/** The DingTalk Stream connection loop: one long-lived SDK client that receives @ mentions and reports health. */
import { setTimeout as delay } from 'node:timers/promises'
import type { DingtalkBot } from '../deployment.ts'
import { readDingtalkCredentials } from '../deployment.ts'
import { health, type SourceContext } from './host.ts'
import { dingtalkTrigger, SOURCE } from './dingtalk-trigger.ts'
import type { DingtalkConfig } from './dingtalk.ts'

/** The minimal surface of the SDK's `DWClient` the loop uses; tests substitute a fake. */
export interface DingtalkClient {
  registerCallbackListener(topic: string, callback: (res: DingtalkCallback) => unknown): unknown
  connect(): Promise<unknown>
  disconnect(): void | Promise<unknown>
  socketCallBackResponse(messageId: string, payload: Record<string, unknown>): unknown
}
/** One push of the Stream connection: `data` is the message JSON string, `headers.messageId` the receipt id. */
export interface DingtalkCallback { headers?: { messageId?: string }; data?: string }
export type DingtalkClientFactory = (credentials: { clientId: string; clientSecret: string }) => Promise<DingtalkClient> | DingtalkClient
/** The SDK's robot topic; the SDK is imported lazily so tests inject a fake client instead of loading its dependencies. */
export const ROBOT_TOPIC = '/v1.0/im/bot/messages/get'
/** Builds the real client through the official `dingtalk-stream` SDK, which maintains its own reconnection. */
export const defaultClientFactory: DingtalkClientFactory = async credentials => {
  const { DWClient, TOPIC_ROBOT } = await import('dingtalk-stream')
  // keepAlive pings the socket so a silently dropped connection is noticed, and autoReconnect re-opens it.
  const client = new DWClient({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, debug: false, keepAlive: true,
    autoReconnect: true })
  return {
    registerCallbackListener: (topic, callback) => { client.registerCallbackListener(topic || TOPIC_ROBOT, callback) },
    connect: () => client.connect(),
    disconnect: () => client.disconnect(),
    socketCallBackResponse: (messageId, payload) => { client.socketCallBackResponse(messageId, payload) },
  }
}
/**
 * Runs the Source's connection loop: nothing before setup and the deployment resolve, `paused/sourceOff` while the Source
 * is disabled, otherwise one Stream connection that hands each message to `ctx.receive` and answers the receipt.
 * A failed `connect` retries with backoff from one second up to sixty, and reports `error` after three failures in a row.
 */
export async function runDingtalk(ctx: SourceContext, signal: AbortSignal, create: DingtalkClientFactory = defaultClientFactory): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  if (!ctx.deployment.dingtalk) { ctx.report(SOURCE, health('paused', 'dingtalkNotConfigured')); return }
  let client: DingtalkClient | undefined
  let failures = 0
  let skipped = 0
  try {
    while (!signal.aborted) {
      if (!enabled(ctx)) {
        if (client) await close(client).catch(() => { /* The SDK may already be down; the next round reconnects. */ })
        client = undefined
        ctx.report(SOURCE, health('paused', 'sourceOff'))
        await delay(5000, undefined, { signal }).catch(() => {})
        continue
      }
      try {
        const bot = botOf(ctx)
        client = await create(await readDingtalkCredentials(bot.credentialDir))
        client.registerCallbackListener(ROBOT_TOPIC, res => {
          // DSH ends its process on an unhandled rejection, so a failed receive becomes the Source's health instead.
          onMessage(ctx, client!, bot, res, count => { skipped += count }).catch((error: unknown) => {
            ctx.report(SOURCE, { state: 'error', detail: String(error) })
          })
        })
        await client.connect()
        failures = 0
        ctx.report(SOURCE, { state: 'ready', detail: skipped ? `Listening for @ mentions; ${skipped} non-text messages ignored`
          : 'Listening for @ mentions', at: new Date().toISOString() })
        // The SDK reconnects on its own; this loop only watches the Source's switch and the stop signal.
        while (!signal.aborted && enabled(ctx)) await delay(5000, undefined, { signal }).catch(() => {})
      } catch (error) {
        failures += 1
        if (failures >= 3) ctx.report(SOURCE, { state: 'error', detail: String(error) })
        if (signal.aborted) break
        await delay(Math.min(1000 * 2 ** (failures - 1), 60_000), undefined, { signal }).catch(() => {})
      } finally {
        if (client) await close(client).catch(() => {})
        client = undefined
      }
    }
  } finally { if (client) await close(client).catch(() => {}) }
}
const enabled = (ctx: SourceContext): boolean => !!ctx.config<DingtalkConfig>(SOURCE)
const botOf = (ctx: SourceContext): DingtalkBot => {
  const bot = ctx.deployment.dingtalk
  if (!bot) throw new Error('The DingTalk Source has no bot credentials')
  return bot
}
const close = async (client: DingtalkClient): Promise<unknown> => await client.disconnect()
/** Receives one pushed message, then answers its receipt so DingTalk does not redeliver it. */
async function onMessage(ctx: SourceContext, client: DingtalkClient, bot: DingtalkBot, res: DingtalkCallback, skipped: (count: number) => void): Promise<void> {
  const messageId = res.headers?.messageId ?? ''
  try {
    let payload: unknown
    try { payload = JSON.parse(res.data ?? '') } catch { payload = undefined }
    if (payload === undefined || payload === null || typeof payload !== 'object') { skipped(0); return }
    const trigger = dingtalkTrigger(payload, bot)
    // Non-text messages are counted, not evaluated; a message read while the Source is being disabled is dropped.
    if (!trigger) { if (payload) skipped(1); return }
    if (!enabled(ctx)) return
    await ctx.receive(trigger)
  } finally { if (messageId) client.socketCallBackResponse(messageId, {}) }
}
