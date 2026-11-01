/** The DingTalk Source: credential resolution, translation, scope, policy rows, the Channel, the Stream loop, and setup. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { apply as applyDingtalk, dingtalkKind, dingtalkTrigger, DingtalkConfigSchema } from '../src/sources/dingtalk.ts'
import { sendDingtalk, dingtalkLink } from '../src/sources/dingtalk-channel.ts'
import { runDingtalk, ROBOT_TOPIC, type DingtalkCallback, type DingtalkClient, type DingtalkClientFactory } from '../src/sources/dingtalk-stream.ts'
import { resetDingtalkTokenCache, resolveDingtalkBot } from '../src/deployment.ts'
import { Setup } from '../src/app/setup.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

vi.mock('../src/infra/environment.ts', async importOriginal => ({
  ...(await importOriginal<object>()),
  writeEnvironment: vi.fn(async () => {}), verifyEnvironment: vi.fn(async () => {}),
}))
vi.mock('../src/deployment.ts', async importOriginal => ({
  ...(await importOriginal<object>()),
  resolveGithub: vi.fn(async () => ({ cli: 'gh', login: 'agent-bot', noreply: '', repository: 'acme/widgets' })),
}))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dingtalk-'))
  resetDingtalkTokenCache()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.useRealTimers() })

const credentials = (overrides: Record<string, string> = {}): string => {
  writeFileSync(join(dir, 'clientId'), overrides.clientId ?? 'cli_bot\n')
  writeFileSync(join(dir, 'clientSecret'), overrides.clientSecret ?? 'supersecret')
  return dir
}
interface FetchCall { url: string; body: Record<string, unknown>; headers: Record<string, string> }
type Route = (call: FetchCall) => { status?: number; body?: unknown }
/** Fakes the global `fetch`, recording every call and answering from `route`. */
function fakeFetch(route: Route): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const call: FetchCall = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')), headers }
    calls.push(call)
    const { status = 200, body = {} } = route(call)
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response
  }))
  return calls
}
const tokenRoute = () => ({ body: { accessToken: 'at', expireIn: 7200 } })

function host(overrides: Partial<SourceContextDeps> = {}, config: Record<string, unknown> = { credentialDir: '' }) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'dingtalk-db-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({
    eval: { mode: 'auto' },
    policy: { sources: { dingtalk: { allowed: [{ id: 'staff_alice', name: 'Alice' }] } } },
    sources: { dingtalk: { enabled: true, config } },
  })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(dingtalkKind)
  const deployment = testDeployment({ dingtalk: { credentialDir: String(config.credentialDir ?? ''), clientId: 'cli_bot', robotCode: 'cli_bot' } })
  const assessor = { request: vi.fn(async () => {}) }
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment, ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(parts, dingtalkKind)
  return { ...parts, ctx, store, receive, health: board.all, engine }
}
const text = (msgId: string, fields: Record<string, unknown> = {}) => ({ msgId, msgtype: 'text', text: { content: '  fix the login bug  ' },
  conversationId: 'cidG1==', conversationType: '2', conversationTitle: 'ZJUSCT', senderStaffId: 'staff_alice', senderNick: 'Alice',
  isAdmin: false, createAt: 1757376000000, robotCode: 'cli_bot', ...fields })
const reply = (id: string, address: Record<string, string>, text = 'Done'): OutboundMessage =>
  ({ id, kind: 'reply', text, channel: { source: 'dingtalk', thread: 'dingtalk:x', address } })

describe('resolveDingtalkBot', () => {
  it('finds no bot when no credential directory is set', async () => {
    expect(await resolveDingtalkBot(testMachine(), {})).toBeUndefined()
    expect(await resolveDingtalkBot(testMachine(), { credentialDir: '' })).toBeUndefined()
  })
  it('refuses missing or empty credential files', async () => {
    await expect(resolveDingtalkBot(testMachine(), { credentialDir: dir })).rejects.toMatchObject({ place: 'dingtalk', code: 'dingtalkCredentialsMissing' })
    writeFileSync(join(dir, 'clientId'), 'cli_bot'); writeFileSync(join(dir, 'clientSecret'), '  \n')
    await expect(resolveDingtalkBot(testMachine(), { credentialDir: dir })).rejects.toMatchObject({ code: 'dingtalkCredentialsMissing' })
  })
  it('refuses a failed token exchange without naming the secret', async () => {
    credentials()
    const calls = fakeFetch(() => ({ status: 400, body: { message: 'bad appKey' } }))
    const error = await resolveDingtalkBot(testMachine(), { credentialDir: dir }).catch((error: unknown) => error)
    expect((error as { code: string }).code).toBe('dingtalkTokenFailed')
    expect(String(error)).not.toContain('supersecret')
    expect(calls[0]).toMatchObject({ url: 'https://api.dingtalk.com/v1.0/oauth2/accessToken', body: { appKey: 'cli_bot', appSecret: 'supersecret' } })
  })
  it('resolves the bot from the credential files and returns no secret', async () => {
    credentials()
    const calls = fakeFetch(tokenRoute)
    expect(await resolveDingtalkBot(testMachine(), { credentialDir: dir })).toEqual({ credentialDir: dir, clientId: 'cli_bot', robotCode: 'cli_bot' })
    expect(calls).toHaveLength(1)
  })
})

describe('trigger translation', () => {
  const bot = { credentialDir: '', clientId: 'cli_bot', robotCode: 'cli_bot' }
  it('reads a group mention as an addressed trigger in the sender\'s thread', () => {
    const trigger = dingtalkTrigger(text('msg_1'), bot)!
    expect(trigger).toMatchObject({ id: key('dingtalk', 'msg_1'), source: 'dingtalk', threads: [{ source: 'dingtalk', id: 'cidG1==:staff_alice' }],
      actor: { source: 'dingtalk', id: 'staff_alice' }, human: true, addressed: 'mention', at: '2025-09-09T00:00:00.000Z', text: 'fix the login bug',
      channel: { source: 'dingtalk', thread: 'dingtalk:cidG1==:staff_alice', address: { conversationId: 'cidG1==', senderStaffId: 'staff_alice', senderNick: 'Alice' } },
      meta: { conversationId: 'cidG1==', conversationType: '2', title: 'ZJUSCT', senderNick: 'Alice', isAdmin: false, msgId: 'msg_1' } })
    expect(trigger.channel?.address).not.toHaveProperty('direct')
  })
  it('reads a direct chat as its own thread addressed directly', () => {
    const trigger = dingtalkTrigger(text('msg_2', { conversationType: '1', conversationId: 'cidDirect==' }), bot)!
    expect(trigger).toMatchObject({ addressed: 'direct', threads: [{ id: 'direct:staff_alice' }],
      channel: { address: { conversationId: 'cidDirect==', direct: '1' } } })
  })
  it('ignores non-text messages', () => {
    expect(dingtalkTrigger(text('msg_3', { msgtype: 'picture' }), bot)).toBeUndefined()
  })
})

describe('scope and policy', () => {
  const config = DingtalkConfigSchema.parse({ chats: [{ conversationId: 'cidG1==', name: 'ZJUSCT' }], directMessages: true, otherChats: 'mentions' })
  it('listens to configured groups, other groups on mentions, and direct messages only when switched on', () => {
    const meta = { conversationId: 'cidG1==', conversationType: '2' }
    expect(dingtalkKind.scope!({ meta }, config)).toEqual({ listened: true, observed: false, row: 'cidG1==' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cidOther==', conversationType: '2' } }, config)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(dingtalkKind.scope!({ meta: { conversationId: 'cidOther==', conversationType: '2' } }, DingtalkConfigSchema.parse({})))
      .toEqual({ listened: false, reason: 'chat_not_listed' })
    expect(dingtalkKind.scope!({ meta: { conversationType: '1' } }, config)).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(dingtalkKind.scope!({ meta: { conversationType: '1' } }, DingtalkConfigSchema.parse({})))
      .toEqual({ listened: false, reason: 'direct_messages_off' })
  })
  it('drops replies to chats the Source no longer receives', () => {
    expect(dingtalkKind.channel!.allowed!({ conversationId: 'cidG1==' }, config)).toBe(true)
    expect(dingtalkKind.channel!.allowed!({ conversationId: 'cidOther==' }, config)).toBe(true)
    expect(dingtalkKind.channel!.allowed!({ conversationId: 'cidOther==' }, DingtalkConfigSchema.parse({}))).toBe(false)
    expect(dingtalkKind.channel!.allowed!({ conversationId: 'cidDirect==', direct: '1' }, config)).toBe(true)
    expect(dingtalkKind.channel!.allowed!({ conversationId: 'cidDirect==', direct: '1' }, DingtalkConfigSchema.parse({}))).toBe(false)
  })
  it('offers an unlistedAddressed-only row per group, plus other and direct', () => {
    expect(dingtalkKind.policy!.rows!(DingtalkConfigSchema.parse({ chats: [{ conversationId: 'cidG1==', name: 'ZJUSCT' }] }))).toEqual([
      { id: 'cidG1==', label: 'ZJUSCT', note: { zh: '仅 @', en: '@ only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: { zh: '不接收', en: 'Not received' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '不接收', en: 'Not received' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } },
    ])
  })
})

describe('sendDingtalk', () => {
  it('sends group replies as Markdown with the requester\'s nickname, once per message', async () => {
    const h = host(undefined, { credentialDir: credentials(), chats: [{ conversationId: 'cidG1==' }] })
    const calls = fakeFetch(tokenRoute)
    const first = await sendDingtalk(h.ctx, reply('r1', { conversationId: 'cidG1==', senderStaffId: 'staff_alice', senderNick: 'Alice' }, '**Done**\nmerged'))
    expect(first).toBe('sent')
    expect(calls[1]).toMatchObject({ url: 'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      headers: { 'x-acs-dingtalk-access-token': 'at' } })
    expect(JSON.parse(calls[1]!.body.msgParam as string)).toEqual({ title: 'Done', text: '@Alice **Done**\nmerged' })
    h.store.close()
  })
  it('sends direct replies through the oToMessages API and records the message', async () => {
    const h = host(undefined, { credentialDir: credentials(), directMessages: true })
    const calls = fakeFetch(tokenRoute)
    expect(await sendDingtalk(h.ctx, reply('r2', { conversationId: 'cidDirect==', senderStaffId: 'staff_alice', senderNick: 'Alice', direct: '1' }))).toBe('sent')
    expect(calls[1]!.url).toBe('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend')
    expect(calls[1]!.body.userIds).toEqual(['staff_alice'])
    // The KV record short-circuits a retry: no further HTTP call is made.
    const after = calls.length
    expect(await sendDingtalk(h.ctx, reply('r2', { conversationId: 'cidDirect==', senderStaffId: 'staff_alice', senderNick: 'Alice', direct: '1' }))).toBe('sent')
    expect(calls).toHaveLength(after)
    h.store.close()
  })
  it('settles 400, 403 and 404 as gone, and throws for a status a retry could pass', async () => {
    const h = host(undefined, { credentialDir: credentials() })
    for (const [status, gone] of [[400, true], [403, true], [404, true], [429, false], [500, false]] as const) {
      resetDingtalkTokenCache()
      const message = reply(`r-${status}`, { conversationId: 'cidG1==', senderStaffId: 'staff_alice', senderNick: 'Alice' })
      fakeFetch(call => call.url.includes('groupMessages') ? { status, body: { message: 'robot not in conversation' } } : tokenRoute())
      if (gone) expect(await sendDingtalk(h.ctx, message)).toBe('gone')
      else await expect(sendDingtalk(h.ctx, message)).rejects.toThrow(`HTTP ${status}`)
    }
    h.store.close()
  })
  it('caches the access token in memory and refreshes it before it expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const h = host(undefined, { credentialDir: credentials() })
    const calls = fakeFetch(tokenRoute)
    await sendDingtalk(h.ctx, reply('t1', { conversationId: 'cidG1==', senderStaffId: 's', senderNick: 'A' }))
    await sendDingtalk(h.ctx, reply('t2', { conversationId: 'cidG1==', senderStaffId: 's', senderNick: 'A' }))
    expect(calls.filter(call => call.url.endsWith('oauth2/accessToken'))).toHaveLength(1)
    // Two hours minus one minute later the token is stale and exchanged again.
    vi.setSystemTime(new Date('2026-01-01T01:59:01Z'))
    await sendDingtalk(h.ctx, reply('t3', { conversationId: 'cidG1==', senderStaffId: 's', senderNick: 'A' }))
    expect(calls.filter(call => call.url.endsWith('oauth2/accessToken'))).toHaveLength(2)
    h.store.close()
  })
  it('labels the group without a URL', () => {
    expect(dingtalkLink({ conversationId: 'cidG1==' }, {})).toEqual({ url: '',
      label: { zh: '钉钉群 cidG1==', en: 'DingTalk group cidG1==' } })
  })
})

describe('stream loop', () => {
  const client = (overrides: Partial<DingtalkClient> = {}): DingtalkClient & { callbacks: ((res: DingtalkCallback) => unknown)[] } => {
    const callbacks: ((res: DingtalkCallback) => unknown)[] = []
    return { callbacks, registerCallbackListener: (topic: string, callback: (res: DingtalkCallback) => unknown) => { expect(topic).toBe(ROBOT_TOPIC); callbacks.push(callback) },
      connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), socketCallBackResponse: vi.fn(), ...overrides } as never
  }
  it('reports paused when the deployment names no bot, without connecting', async () => {
    const h = host({ deployment: testDeployment() })
    const create = vi.fn<DingtalkClientFactory>(() => client())
    await runDingtalk(h.ctx, new AbortController().signal, create)
    expect(h.health.dingtalk).toMatchObject({ state: 'paused', code: 'dingtalkNotConfigured' })
    expect(create).not.toHaveBeenCalled()
    h.store.close()
  })
  it('reports paused while setup waits', async () => {
    const h = host({ configured: () => false })
    await runDingtalk(h.ctx, new AbortController().signal, () => client())
    expect(h.health.dingtalk).toMatchObject({ state: 'paused', code: 'setupPending' })
    h.store.close()
  })
  it('receives each pushed message, answers its receipt, and disconnects when the Source stops', async () => {
    credentials()
    const h = host(undefined, { credentialDir: dir, chats: [{ conversationId: 'cidG1==' }] })
    const fake = client()
    const controller = new AbortController()
    const running = runDingtalk(h.ctx, controller.signal, () => fake)
    while (!fake.callbacks.length) await new Promise(resolve => setTimeout(resolve, 5))
    expect(h.health.dingtalk).toMatchObject({ state: 'ready', detail: 'Listening for @ mentions' })
    await fake.callbacks[0]!({ headers: { messageId: 'm1' }, data: JSON.stringify(text('msg_1')) })
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('dingtalk', 'msg_1'), source: 'dingtalk' })
    expect((fake.socketCallBackResponse as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('m1', {})
    // A non-text message is ignored and counted, but still receipted.
    await fake.callbacks[0]!({ headers: { messageId: 'm2' }, data: JSON.stringify(text('msg_2', { msgtype: 'picture' })) })
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect((fake.socketCallBackResponse as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('m2', {})
    controller.abort()
    await running
    expect(fake.disconnect).toHaveBeenCalled()
    h.store.close()
  })
  it('retries a failed connect with backoff and reports an error after three failures', async () => {
    credentials()
    const h = host(undefined, { credentialDir: dir })
    const controller = new AbortController()
    let failures = 0
    const create: DingtalkClientFactory = () => {
      failures += 1
      if (failures >= 3) controller.abort() // Ends the loop's backoff delay at once for the test.
      throw new Error('gateway unreachable')
    }
    await runDingtalk(h.ctx, controller.signal, create)
    expect(failures).toBe(3)
    expect(h.health.dingtalk).toMatchObject({ state: 'error' })
    expect(String(h.health.dingtalk?.detail)).toContain('gateway unreachable')
    h.store.close()
  })
})

describe('plugin and setup', () => {
  it('registers its kind on apply and unregisters it on disposal', async () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const report = vi.fn()
    const orchestrator = { sources,
      // The loop's effect runs at once; without a resolved bot it only reports and returns.
      context: () => ({ report, config: () => undefined, ready: Promise.resolve(), configured: () => true, deployment: testDeployment() }) }
    const ctx = { orchestrator, effect: (run: () => unknown) => { void run() }, logger: { warn: () => {} } } as unknown as Context
    applyDingtalk(ctx)
    expect(sources.kind('dingtalk')).toBe(dingtalkKind)
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith('dingtalk', expect.objectContaining({ state: 'paused', code: 'dingtalkNotConfigured' })))
  })
  it('leaves DingTalk out without blocking setup when its credentials fail', async () => {
    fakeFetch(() => ({ status: 400, body: { message: 'bad appKey' } }))
    const restart = vi.fn()
    const setup = new Setup({ context: { logger: { warn: vi.fn() } } as unknown as Context,
      machine: testMachine({ stateDir: join(dir, 'state') }), lifetime: new AbortController().signal, restart })
    const settings = SettingsSchema.parse({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh' } },
      dingtalk: { enabled: true, config: { credentialDir: credentials() } } } })
    expect(await setup.run(settings)).toBe(true)
    expect(setup.problem).toBeUndefined()
    expect(setup.dingtalkProblem).toMatchObject({ place: 'dingtalk', code: 'dingtalkTokenFailed' })
    expect(setup.deployment.github).toBeDefined()
    expect(setup.deployment.dingtalk).toBeUndefined()
  })
})
