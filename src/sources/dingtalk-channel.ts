/** DingTalk outbound channel: group and direct-chat Markdown messages, deduplicated in KV because the API has no idempotency key. */
import type { OutboundMessage } from '../core/index.ts'
import { dingtalkAccessToken, readDingtalkCredentials } from '../deployment.ts'
import { KV } from '../kv.ts'
import { checkedImText } from '../infra/text.ts'
import type { Commands } from '../infra/commands.ts'
import type { ChannelLink, ChannelLinks, SendHost } from './kind.ts'

import type { SourceContext } from './host.ts'
import { z } from 'zod'

const API = 'https://api.dingtalk.com/v1.0/robot'
/** One answer of a robot send API: success carries `processQueryKey`; a failure carries `code`/`errcode`. */
const SendResult = z.looseObject({})
/** POSTs one robot API call; throws for anything a retry could still deliver, and reports permanent refusals to the caller. */
async function dingtalkPost(path: string, accessToken: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  const text = await response.text()
  let answer: unknown = undefined
  try { answer = text ? JSON.parse(text) : undefined } catch { /* A non-JSON body is judged by its status alone. */ }
  // A group the bot is not in refuses permanently; other statuses, throttling included, may succeed on a retry.
  if (response.status === 400 || response.status === 403 || response.status === 404) return Promise.reject(new DingtalkGone(String(answer)))
  if (!response.ok) throw new Error(`DingTalk ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
  const result = SendResult.parse(answer)
  const code = (result as { code?: unknown }).code ?? (result as { errcode?: unknown }).errcode
  if (code !== undefined && code !== 0 && code !== '0') throw new Error(`DingTalk ${path} failed: ${text.slice(0, 500)}`)
  return result
}
/** A permanently unreachable conversation: the bot is not in the group, or the group is gone. */
class DingtalkGone extends Error {}
/** The Markdown message title: the first line, its Markdown symbols removed, cut to twenty characters. */
export const dingtalkTitle = (text: string): string =>
  text.split('\n')[0]!.replace(/[#*_~`>\-\[\]!()]/g, '').trim().slice(0, 20)
/**
 * Delivers one reply to its group or direct chat, exactly once: DingTalk's send APIs take no idempotency key, so the
 * Outbox's retries consult the KV record written after the first success.
 */
export async function sendDingtalk(ctx: SendHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const bot = ctx.deployment?.dingtalk
  if (!bot) throw new Error('The DingTalk Source has no bot credentials')
  if (ctx.state?.get(KV.dingtalk.sent(message.id))) return 'sent'
  const address = message.channel.address
  const direct = address.direct === '1'
  const staffId = address.senderStaffId
  // A group message from a cluster event has no requester, so a group send needs only the conversation; a direct chat still needs its person.
  if (direct ? !staffId : !address.conversationId) throw new Error('Missing DingTalk reply target')
  const text = checkedImText(message.text)
  // DingTalk's Markdown cannot mention a person, so the reply opens with the requester's nickname instead.
  const nick = address.senderNick ?? ''
  const body = nick ? `@${nick} ${text}` : text
  const title = dingtalkTitle(text)
  const msgParam = JSON.stringify({ title, text: body })
  try {
    const credentials = await readDingtalkCredentials(bot.credentialDir)
    const token = await dingtalkAccessToken(credentials.clientId, credentials.clientSecret)
    if (direct) await dingtalkPost('oToMessages/batchSend', token,
      { robotCode: bot.robotCode, userIds: [staffId], msgKey: 'sampleMarkdown', msgParam })
    else await dingtalkPost('groupMessages/send', token,
      { robotCode: bot.robotCode, openConversationId: address.conversationId, msgKey: 'sampleMarkdown', msgParam })
  } catch (error) {
    if (error instanceof DingtalkGone) return 'gone'
    throw error
  }
  ctx.state?.set(KV.dingtalk.sent(message.id), true)
  return 'sent'
}
/** A DingTalk message has no URL to open; the panel shows the group the reply belongs to. */
export const dingtalkLink = (address: Record<string, string>, _links: ChannelLinks): ChannelLink => ({
  url: '', label: address.direct === '1'
    ? { zh: '钉钉私聊', en: 'DingTalk direct message' }
    : { zh: `钉钉群 ${address.conversationId ?? ''}`, en: `DingTalk group ${address.conversationId ?? ''}` },
})
