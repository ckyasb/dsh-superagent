import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { type GitlabAccount } from '../src/deployment.ts'
import { apply as applyGitlab, gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { SOURCE, issueTrigger, mentions, mergeRequestTrigger, noteTrigger } from '../src/sources/gitlab-trigger.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AGENT: GitlabAccount = { cli: '/bin/glab', host: 'git.example.com', project: 'acme/widgets', projectId: 451,
  webUrl: 'https://git.example.com/acme/widgets', defaultBranch: 'main', login: 'agent-bot', userId: 7, name: 'Agent',
  commitEmail: '7-agent-bot@noreply.git.example.com' }
const BASE = 'https://git.example.com/acme/widgets'
const at = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()
const author = (username: string, fields: Record<string, unknown> = {}) =>
  ({ id: username === 'agent-bot' ? 7 : 3, username, name: username, ...fields })
const issue = (iid: number, fields: Record<string, unknown> = {}) => ({ iid, title: 'Fix the margin', description: 'It is off',
  state: 'opened', author: author('carol'), created_at: at(-3600), updated_at: at(-3600),
  web_url: `${BASE}/-/issues/${iid}`, ...fields })
const note = (id: number, fields: Record<string, unknown> = {}) => ({ id, type: null, body: 'a comment', author: author('carol'),
  created_at: at(-1800), updated_at: at(-1800), system: false, ...fields })
const discussion = <T,>(id: string, notes: T[], individual_note = false): { id: string; individual_note: boolean; notes: T[] } => ({ id, individual_note, notes })
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'gitlab-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { host: AGENT.host, project: AGENT.project, cli: AGENT.cli } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'carol' }] } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ gitlab: AGENT })
  sources.register(gitlabKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => engine.receive(trigger))
  const parts: SourceContextDeps = { store, engine, outbox, commands, sources, deployment, ready: Promise.resolve(),
    configured: () => true, receive, ...overrides }
  const context = sourceContextOf(parts, gitlabKind)
  return { ...parts, ...context, health: board.all, store, engine, receive }
}
/** Stubs `glab api` calls against the configured project and returns the requested paths in order. */
function gitlab(h: { commands: SourceContextDeps['commands'] }, routes: Record<string, unknown>): string[] {
  const reads: string[] = []
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    reads.push(args[1]!.replace(/^projects\/451\//, ''))
    const path = reads.at(-1)!.split('?')[0]!
    const route = routes[path]
    if (route === undefined) throw commandError({ stderr: 'glab: Not Found (HTTP 404)', code: 1 })
    const value: unknown = typeof route === 'function' ? (route as () => unknown)() : route
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return reads
}
const notFound = () => commandError({ stderr: 'glab: Not Found (HTTP 404)', code: 1 })
afterEach(() => { vi.restoreAllMocks() })

describe('gitlab source', () => {
  it('translates an Issue description and a note into triggers with independent issue and MR sequences', () => {
    const described = issueTrigger(issue(12), AGENT)
    expect(described).toMatchObject({ id: key('gitlab-issue', '12'), source: 'gitlab', threads: [{ source: 'gitlab', id: 'issue:12' }],
      actor: { source: 'gitlab', id: 'carol' }, human: true, at: described.at, text: 'Fix the margin\n\nIt is off',
      channel: { source: 'gitlab', address: { target: 'issue', iid: '12' } }, url: `${BASE}/-/issues/12`,
      meta: { target: 'issue', iid: 12, kind: 'issue' } })
    const mr = mergeRequestTrigger({ ...issue(34, { web_url: `${BASE}/-/merge_requests/34` }), draft: false } as never, AGENT)
    expect(mr).toMatchObject({ id: key('gitlab-mr', '34'), threads: [{ id: 'mr:34' }], meta: { target: 'mr', iid: 34, kind: 'mr', mrAuthor: 'carol' } })
    const comment = noteTrigger({ ...note(5, { body: '@agent-bot please fix' }) },
      { target: 'mr', iid: 34, url: `${BASE}/-/merge_requests/34`, mrAuthor: 'carol' }, 'd1', AGENT)
    expect(comment).toMatchObject({ addressed: 'mention', human: true,
      channel: { address: { target: 'mr', iid: '34', discussionId: 'd1', url: `${BASE}/-/merge_requests/34#note_5` } },
      url: `${BASE}/-/merge_requests/34#note_5`, meta: { kind: 'note', noteId: 5, discussionId: 'd1', mrAuthor: 'carol' } })
    // A single-note discussion that takes no replies addresses the comment itself.
    const single = noteTrigger(note(6), { target: 'issue', iid: 12, url: `${BASE}/-/issues/12` }, undefined, AGENT)
    expect(single.channel!.address).not.toHaveProperty('discussionId')
  })
  it('makes the agent, bots, and project bot accounts non-human', () => {
    expect(issueTrigger(issue(1, { author: author('agent-bot') }), AGENT).human).toBe(false)
    expect(issueTrigger(issue(2, { author: author('sem', { bot: true }) }), AGENT).human).toBe(false)
    expect(issueTrigger(issue(3, { author: author('project_42_bot_6abc') }), AGENT).human).toBe(false)
    expect(issueTrigger(issue(4, { author: author('project_bot') }), AGENT).human).toBe(true)
  })
  it('matches mentions by word boundary and case, and keys a note by its content so resolving keeps the id and editing changes it', () => {
    for (const text of ['@agent-bot hi', 'hey @AGENT-BOT!', '(@agent-bot)']) expect(mentions(text, 'agent-bot')).toBe(true)
    expect(mentions('@agent-bot hi', 'agent.bot')).toBe(false)
    for (const text of ['x@agent-bot', '@agent-botting', '@agent-bot.', 'mail me at bob@agent-bot.example', '@notagent-bot'])
      expect(mentions(text, 'agent-bot')).toBe(false)
    const body = note(9, { body: 'same words' })
    const first = noteTrigger(body, { target: 'issue', iid: 1, url: `${BASE}/-/issues/1` }, 'd', AGENT)
    // Resolving a discussion changes only its state, which the id never reads.
    expect(noteTrigger({ ...body, updated_at: at(-10) }, { target: 'issue', iid: 1, url: `${BASE}/-/issues/1` }, 'd', AGENT).id).toBe(first.id)
    expect(noteTrigger({ ...body, body: 'edited words' }, { target: 'issue', iid: 1, url: `${BASE}/-/issues/1` }, 'd', AGENT).id).not.toBe(first.id)
  })
  it('scopes by kind, finds threads by reference, and fills the execution environment from the origin', () => {
    const config = gitlabKind.schema.parse({})
    expect(gitlabKind.scope!({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: false, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { kind: 'mr' } }, config)).toEqual({ listened: true, observed: false, row: 'mrs' })
    expect(gitlabKind.scope!({ meta: { kind: 'note' } }, config)).toEqual({ listened: true, observed: false, row: 'comments' })
    expect(gitlabKind.find!('#12')).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!('!34')).toEqual({ threads: ['gitlab:mr:34'], terms: [] })
    expect(gitlabKind.find!(`${BASE}/-/issues/12`)).toEqual({ threads: ['gitlab:issue:12'], terms: [] })
    expect(gitlabKind.find!(`${BASE}/-/merge_requests/34`)).toEqual({ threads: ['gitlab:mr:34'], terms: [] })
    expect(gitlabKind.find!('12')).toEqual({ threads: ['gitlab:issue:12', 'gitlab:mr:12'], terms: [] })
    expect(gitlabKind.find!('nope')).toEqual({ threads: [], terms: [] })
    const values = gitlabKind.environment!.values
    const origin = (target: 'issue' | 'mr', iid: number) => ({ deployment: testDeployment({ gitlab: AGENT }), config, trigger: ({ source: SOURCE, meta: { target, iid } }) as unknown as Trigger })
    const issueOrigin = origin('issue', 12)
    expect(values(issueOrigin)).toMatchObject({ DSH_SUPERAGENT_GITLAB_HOST: 'git.example.com', DSH_SUPERAGENT_GITLAB_PROJECT: 'acme/widgets',
      DSH_SUPERAGENT_GITLAB_PROJECT_ID: '451', DSH_SUPERAGENT_GITLAB_WEB_URL: AGENT.webUrl, DSH_SUPERAGENT_GITLAB_DEFAULT_BRANCH: 'main',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: 'agent-bot', DSH_SUPERAGENT_GITLAB_ISSUE_IID: '12', DSH_SUPERAGENT_GITLAB_MR_IID: '', DSH_SUPERAGENT_GITLAB_MR_HEAD: '' })
    const mrOrigin = origin('mr', 34)
    expect(values(mrOrigin)).toMatchObject({ DSH_SUPERAGENT_GITLAB_MR_IID: '34', DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/34/head',
      DSH_SUPERAGENT_GITLAB_ISSUE_IID: '' })
    expect(Object.values(values({ deployment: testDeployment(), config, trigger: undefined })).every(value => value === '')).toBe(true)
  })
  it('posts a comment, replies into its discussion, and never duplicates a marked comment', async () => {
    const h = host()
    const message = { id: 'r1', channel: { source: SOURCE, thread: 'gitlab:issue:12', address: { target: 'issue', iid: '12',
      url: `${BASE}/-/issues/12` } }, text: 'done', kind: 'reply' } as const
    const posted: string[] = []
    const paths: string[] = []
    gitlab(h, {})
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      const path = args[1]!
      paths.push(path)
      if (path.includes('/notes') && args.includes('POST')) { posted.push(args.find(a => String(a).startsWith('body='))!.slice(5)); return '{}' }
      if (path.includes('/discussions')) return JSON.stringify([discussion('d1', [note(1)])])
      throw notFound()
    })
    expect(await sendGitlab(h, message)).toBe('sent')
    expect(posted).toEqual(['done\n\n<!-- dsh-superagent:r1 -->'])
    // The marker lookup read the Issue's discussions, and the comment went to its notes.
    expect(paths.slice(-2)[0]).toContain('issues/12/discussions')
    expect(paths.at(-1)).toContain('issues/12/notes')
    // A second attempt whose marker is already on a comment of the agent sends nothing.
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      if (args[1]!.includes('/discussions'))
        return JSON.stringify([discussion('d1', [note(2, { author: author('agent-bot'), body: 'done\n\n<!-- dsh-superagent:r1 -->' })])])
      throw new Error('should not post')
    })
    expect(await sendGitlab(h, message)).toBe('sent')
    // A discussion address replies inside that discussion.
    const reply = { ...message, channel: { ...message.channel, address: { ...message.channel.address, discussionId: 'd1' } } }
    const replies: string[] = []
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      paths.push(args[1]!)
      replies.push(args[1]!)
      return JSON.stringify([])
    })
    expect(await sendGitlab(h, reply)).toBe('sent')
    expect(replies.at(-1)).toContain('issues/12/discussions/d1/notes')
    h.store.close()
  })
  it('answers gone for a 404 only, and throws other failures so the outbox retries', async () => {
    const h = host()
    const message = { id: 'r2', channel: { source: SOURCE, thread: 'gitlab:issue:12', address: { target: 'issue', iid: '12' } },
      text: 'hi', kind: 'reply' } as const
    gitlab(h, {})
    vi.spyOn(h.commands, 'run').mockRejectedValue(notFound())
    expect(await sendGitlab(h, message)).toBe('gone')
    vi.spyOn(h.commands, 'run').mockRejectedValue(commandError({ stderr: 'glab: server error (HTTP 500)', code: 1 }))
    await expect(sendGitlab(h, message)).rejects.toThrow()
    h.store.close()
  })
  it('reads a Thread by page with the description first, the root alone, and the parent of the Trigger', async () => {
    const h = host()
    // A full page of exactly 100 discussions offers the next page; note 6 is the reply the Trigger names.
    const full = Array.from({ length: 99 }, (_, index) => discussion(`d${index}`, [note(1000 + index, { body: `note ${index + 1}` })]))
    full.push(discussion('d2', [note(2, { body: 'second' }), note(6, { body: 'a reply' })]))
    const pages = [full, [discussion('d3', [note(3, { body: 'third' })])]]
    gitlab(h, {})
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      const path = args[1]!
      if (path.includes('issues/12/discussions')) return JSON.stringify(pages[Number(/[?&]page=(\d+)/.exec(path)?.[1]) - 1] ?? [])
      if (path.endsWith('issues/12')) return JSON.stringify(issue(12))
      throw notFound()
    })
    const trigger = { source: SOURCE, url: `${BASE}/-/issues/12#note_6`, meta: { target: 'issue', iid: 12, noteId: 6 } } as never
    const context = gitlabKind.threadContext!
    const noConfig = gitlabKind.schema.parse({})
    const first = await context.read(h.commands, trigger, 'thread', undefined, gitlabKind.schema.parse({}))
        expect(first.messages[0]!.id).toBe(`${BASE}/-/issues/12`)
    expect(first.messages).toHaveLength(102)
    expect(first.messages.at(-1)!.id).toBe(`${BASE}/-/issues/12#note_6`)
    expect(first.next).toBe('2')
    const second = await context.read(h.commands, trigger, 'thread', first.next, noConfig)
    expect(second.messages.map(message => message.text)).toEqual(['third'])
    expect(second.next).toBeUndefined()
    expect(context.messageId(trigger)).toBe(`${BASE}/-/issues/12#note_6`)
    expect((await context.read(h.commands, trigger, 'root', undefined, noConfig)).messages)
      .toEqual([expect.objectContaining({ id: `${BASE}/-/issues/12` })])
    expect((await context.read(h.commands, trigger, 'parent', undefined, noConfig)).messages.map(message => message.id))
      .toEqual([`${BASE}/-/issues/12#note_2`])
    h.store.close()
  })
  it('reports an unconfigured GitLab without calling its CLI', async () => {
    const h = host({ deployment: testDeployment({ gitlab: undefined }) })
    const run = vi.spyOn(h.commands, 'run')
    await pollRound(h)
    expect(h.health.gitlab).toMatchObject({ state: 'paused', detail: 'The GitLab Source is not configured.' })
    expect(run).not.toHaveBeenCalled()
    expect(h.receive).not.toHaveBeenCalled()
    h.store.close()
  })
  it('sets its cursors on the first round without reading history, then takes in what the streams hold', async () => {
    const h = host()
    let opened = false
    const reads = gitlab(h, {
      issues: () => opened ? [issue(12, { description: 'please @agent-bot look', created_at: at(1), updated_at: at(1) })] : [],
      'issues/12/discussions': () => [],
      merge_requests: () => [],
    })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(reads.filter(path => path.startsWith('issues?updated_after'))).toHaveLength(0)
    const cursor = h.store.get(KV.gitlab.sinceIssues)!
    expect(typeof cursor).toBe('string')
    // The next round reads from its cursor and takes in the mentioned Issue.
    opened = true
    await pollRound(h)
    expect(reads.filter(path => path.startsWith('issues?updated_after'))).toHaveLength(1)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('gitlab-issue', '12'), addressed: 'mention', threads: [{ id: 'issue:12' }] })
    expect(h.store.threads.get('gitlab:issue:12')?.meta).toMatchObject({ title: 'Fix the margin' })
    // The cursor never moves backwards, even across rounds closer than the five-second overlap.
    expect(Date.parse(h.store.get(KV.gitlab.sinceIssues)!)).toBeGreaterThanOrEqual(Date.parse(cursor))
    h.store.close()
  })
  it('takes in a mentioned comment, skips system notes and the agent\'s own, and advances the thread cursor', async () => {
    const h = host()
    let fresh = false
    const batch = [
      discussion('d1', [
        note(1, { body: '@AGENT-BOT start' }),
        note(2, { system: true, body: 'changed the description' }),
        note(3, { author: author('agent-bot'), body: 'on it' }),
        note(4, { body: 'unrelated' }),
      ]),
    ]
    gitlab(h, {
      issues: () => fresh ? [issue(12, { created_at: at(1), updated_at: at(1) })] : [],
      'issues/12/discussions': () => fresh
        ? [discussion('d1', batch[0]!.notes.map(item => ({ ...item, created_at: at(1), updated_at: at(1) })))]
        : [],
      merge_requests: () => [],
    })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    const beforeRound = Date.now()
    fresh = true
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ addressed: 'mention', threads: [{ id: 'issue:12' }], actor: { id: 'carol' } })
    expect(Date.parse(h.store.get(KV.gitlab.cursor('issue', 12))!)).toBeGreaterThanOrEqual(beforeRound)
    // The advanced cursor keeps the next round from reading anything new; a reread comment is stored once.
    await pollRound(h)
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    h.store.close()
  })
  it('takes in an unaddressed comment of a subscribed Thread without a switch, and observes where a switch is on', async () => {
    const h = host()
    // A subscribed Thread is polled even when it never appears in a stream; it must be within the polling horizon.
    h.store.threads.save({ key: 'gitlab:issue:12', ref: { source: SOURCE, id: 'issue:12' }, createdAt: at(-3600), lastAt: at(-60),
      subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    let fresh = false
    gitlab(h, {
      issues: () => [], merge_requests: () => [],
      'issues/12/discussions': () => fresh ? [discussion('d1', [note(5, { body: 'quiet follow-up', updated_at: at(-1) })])] : [],
    })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    fresh = true
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ threads: [{ id: 'issue:12' }] })
    expect(h.receive.mock.calls[0]![0].addressed).toBeUndefined()
    // An observed stream admits unaddressed comments, and the policy keeps the Thread listened to.
    const config = gitlabKind.schema.parse({ observeComments: true })
    expect(gitlabKind.scope!({ meta: { kind: 'note' } }, config)).toMatchObject({ listened: true, observed: true, row: 'comments' })
    h.store.close()
  })
  it('registers its kind through the plugin entry', async () => {
    const h = host()
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const parts: SourceContextDeps = { ...h, sources }
    const fresh = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind),
      ...sourceContextOf(parts, gitlabKind) }
    const disposers: (() => unknown)[] = []
    applyGitlab({ orchestrator: fresh, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind('gitlab')).toBe(gitlabKind)
    for (const dispose of disposers) await dispose()
    expect(sources.kind('gitlab')).toBeUndefined()
    h.store.close()
  })
  it('keeps the configuration strict and the polling tunables bounded', () => {
    const parsed = gitlabKind.schema.parse({ host: 'git.example.com', project: 'a/b', cli: 'glab' })
    expect(parsed).toMatchObject({ pollSeconds: 60, failuresBeforeError: 3, observeIssues: false, observeMergeRequests: false, observeComments: false })
    expect(() => gitlabKind.schema.parse({ pollSeconds: 10 })).toThrow()
    expect(() => gitlabKind.schema.parse({ extra: true })).toThrow()
    expect(gitlabKind.health).toEqual(['gitlab'])
  })
})
