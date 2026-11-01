import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { type GitlabAccount } from '../src/deployment.ts'
import { apply as applyGitlab, gitlabKind, pollRound } from '../src/sources/gitlab.ts'
import { SOURCE, issueTrigger, mentions, mergeRequestTrigger, noteTrigger } from '../src/sources/gitlab-trigger.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'
import { claimMergeRequest, mergeRequestEndNotices, mergeRequestOf, mergeRequestsOf, observeMergeRequest, readMergeRequest } from '../src/sources/gitlab-mr.ts'
import { readGitlab, readGitlabRepositoryPath } from '../src/sources/gitlab-read.ts'
import { executorTools } from '../src/app/tools/executor.ts'
import { candidateCard } from '../src/app/links.ts'
import { TextCache } from '../src/app/cache.ts'
import type { Ticket } from '../src/core/index.ts'
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
      events: () => [],
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
      events: () => [],
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
      events: () => [],
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

describe('gitlab merge requests', () => {
  const executionOf = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
  const ticketOf = (id: string, fields: Record<string, unknown> = {}): Ticket =>
    ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
      actor: { source: 'gitlab', id: 'carol' }, scope: '' },
      channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }],
      assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
      execution: executionOf(`fix-${id}`), origin: { triggerId: 'x', triggerIds: [] }, ...fields }) as Ticket
  const mergeRequest = (iid: number, fields: Record<string, unknown> = {}) => ({ iid, title: 'Fix the margin', description: '',
    state: 'opened', author: author('carol'), created_at: at(-60), updated_at: at(-60), web_url: `${BASE}/-/merge_requests/${iid}`,
    source_branch: 'fix', target_branch: 'main', source_project_id: 451, draft: false, merged_at: null, closed_at: null, sha: 'abc', ...fields })
  const agentsMr = (iid: number, branch = 'fix') =>
    mergeRequest(iid, { author: author('agent-bot'), source_branch: branch })
  const originTrigger = (iid: number): Trigger =>
    ({ id: 'src', source: SOURCE, threads: [{ source: SOURCE, id: `mr:${iid}` }], actor: { source: SOURCE, id: 'carol' },
      human: true, at: at(-120), text: 'fix it', meta: { target: 'mr', iid, kind: 'mr' } })

  it('binds the origin MR and an agent MR on the ticket branch, and refuses others', () => {
    const h = host()
    h.store.triggers.save(originTrigger(34))
    h.store.tickets.save(ticketOf('t1', { origin: { triggerId: 'src', triggerIds: ['src'] } }))
    // The MR the ticket started from binds even though someone else opened it.
    expect(claimMergeRequest(h, 't1', mergeRequest(34))).toBeUndefined()
    expect(h.store.tickets.get('t1')!.follows).toEqual([{ thread: 'gitlab:mr:34', own: false }])
    expect(mergeRequestOf(h.store.tickets.get('t1')!)).toBe(34)
    expect(h.store.threads.get('gitlab:mr:34')?.meta).toMatchObject({ target: 'mr', iid: 34, mrAuthor: 'carol', url: `${BASE}/-/merge_requests/34` })
    // An agent MR whose branch ends with the ticket's short name binds; a fork, a stranger's MR, and a mismatched branch do not.
    expect(claimMergeRequest(h, 't1', agentsMr(35, `agent/fix-t1`))).toBeUndefined()
    expect(mergeRequestsOf(h.store.tickets.get('t1')!)).toEqual([34, 35])
    expect(claimMergeRequest(h, 't1', mergeRequest(36))).toMatch(/DSH_SUPERAGENT_NAME.*agent-bot|agent-bot.*DSH_SUPERAGENT_NAME/)
    expect(claimMergeRequest(h, 't1', mergeRequest(37, { author: author('agent-bot'), source_project_id: 999 })))
      .toMatch(/DSH_SUPERAGENT_NAME/)
    expect(claimMergeRequest(h, 't1', agentsMr(38, 'agent/something-else'))).toMatch(/DSH_SUPERAGENT_NAME/)
    expect(mergeRequestsOf(h.store.tickets.get('t1')!, true)).toEqual([34, 35])
    // An MR another open ticket already follows is refused.
    h.store.tickets.save(ticketOf('t2', { follows: [{ thread: 'gitlab:mr:39', own: true }] }))
    expect(claimMergeRequest(h, 't1', agentsMr(39, 'agent/fix-t1'))).toMatch(/another active ticket/)
    h.store.close()
  })

  it('ends tickets when their MR merges or closes, and auto-binds the unique ticket on an open agent MR', async () => {
    const h = host()
    h.store.tickets.save(ticketOf('t1'))
    await observeMergeRequest(h, agentsMr(41, 'agent/fix-t1') as never)
    expect(mergeRequestOf(h.store.tickets.get('t1')!)).toBe(41)
    expect(await observeMergeRequest(h, mergeRequest(41, { author: author('agent-bot'), source_branch: 'agent/fix-t1',
      state: 'merged', merged_at: '2026-09-02T00:00:00Z' }) as never)).toBe(true)
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { by: 'executor', outcome: 'merged', at: '2026-09-02T00:00:00.000Z' } })
    expect(h.store.threads.get('gitlab:mr:41')?.subscriptions).toEqual(['t1'])
    // A closed (unmerged) MR ends its ticket as closed.
    h.store.tickets.save(ticketOf('t2', { follows: [{ thread: 'gitlab:mr:42', own: true }] }))
    await observeMergeRequest(h, mergeRequest(42, { author: author('agent-bot'), source_branch: 'agent/fix-t2',
      state: 'closed', closed_at: '2026-09-03T00:00:00Z' }) as never)
    expect(h.store.tickets.get('t2')).toMatchObject({ ended: { outcome: 'closed' } })
    h.store.close()
  })

  it('notices the ticket\'s IM conversations, in the request\'s language, and skips its GitLab channel', () => {
    const h = host()
    const channels = [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
      { source: 'gitlab', thread: 'gitlab:mr:34', address: { target: 'mr', iid: '34' } }]
    h.store.tickets.save(ticketOf('t1', { channels, follows: [{ thread: 'gitlab:mr:34', own: true,
      closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } }] }))
    const ended = { ...ticketOf('t1', { channels, follows: [{ thread: 'gitlab:mr:34', own: true,
      closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'merged' } }] }), ended: { by: 'executor' as const, outcome: 'merged' as const,
      at: '2026-09-02T00:00:00.000Z' } }
    h.store.tickets.save(ended)
    const chinese = mergeRequestEndNotices(h.store.tickets.get('t1')!, '修一下标题', BASE)
    expect(chinese.map(notice => notice.channel.source)).toEqual(['feishu'])
    expect(chinese[0]!.text).toBe(`[MR !34](${BASE}/-/merge_requests/34) 已合并。`)
    expect(chinese[0]!.id).toBe(key('mr-terminal', '34', 'feishu', JSON.stringify(channels[0]!.address), 'merged'))
    h.store.tickets.save({ ...ticketOf('t2', { channels, follows: [{ thread: 'gitlab:mr:35', own: true,
      closed: { at: '2026-09-02T00:00:00.000Z', outcome: 'closed' } }] }),
      ended: { by: 'executor' as const, outcome: 'closed' as const, at: '2026-09-02T00:00:00.000Z' } })
    expect(mergeRequestEndNotices(h.store.tickets.get('t2')!, 'please fix', BASE)[0]!.text)
      .toBe(`[MR !35](${BASE}/-/merge_requests/35) was closed without merging.`)
    h.store.close()
  })

  it('claims a reported MR through orchestrator_report, refuses without a GitLab Source, and leaves no partial state when refused', async () => {
    const h = host()
    const toolsFor = (context: typeof h) => executorTools({
      engine: context.engine, store: context.store, sessions: { relay: vi.fn(), notify: vi.fn() }, resources: {} as never,
      github: context, gitlab: context, sendReplies: async () => {},
    } as never, ticketOf('t1'))
    const report = (tools: ReturnType<typeof toolsFor>, args: Record<string, unknown>) =>
      tools.find(tool => tool.name === 'orchestrator_report')!.execute(args, new AbortController().signal)
    // Without a GitLab deployment the argument is refused before any read.
    const without = host({ deployment: testDeployment({ gitlab: undefined }) })
    without.store.tickets.save(ticketOf('t1'))
    await expect(report(toolsFor(without), { state: 'progress', summary: 'x', mr_iid: 34 })).rejects.toThrow('no GitLab Source')
    // With one, a valid MR binds and the report is recorded.
    h.store.tickets.save(ticketOf('t1'))
    gitlab(h, { 'merge_requests/34': () => mergeRequest(34, { author: author('agent-bot'), source_branch: 'agent/fix-t1' }) })
    await expect(report(toolsFor(h), { state: 'progress', summary: 'opened MR', mr_iid: 34 })).resolves.toMatchObject({ reported: true })
    expect(mergeRequestOf(h.store.tickets.get('t1')!)).toBe(34)
    // A refused MR leaves neither the binding nor the report.
    gitlab(h, { 'merge_requests/35': () => mergeRequest(35) })
    await expect(report(toolsFor(h), { state: 'progress', summary: 'not mine', mr_iid: 35 })).rejects.toThrow(/DSH_SUPERAGENT_NAME/)
    expect(mergeRequestsOf(h.store.tickets.get('t1')!, true)).toEqual([34])
    expect(h.store.tickets.get('t1')!.assignments.at(-1)?.report).toMatchObject({ summary: 'opened MR' })
    h.store.close(); without.store.close()
  })
})

describe('gitlab pushes', () => {
  const pushSettings = () => SettingsSchema.parse({ eval: { mode: 'auto' },
    sources: { gitlab: { enabled: true, config: { host: AGENT.host, project: AGENT.project, cli: AGENT.cli, observePushes: true } } },
    policy: { sources: { gitlab: { allowed: [{ id: 'carol' }] } } } })
  const event = (id: number, fields: Record<string, unknown> = {}) => ({ id, action_name: 'pushed to', author: author('carol'),
    author_username: 'carol', created_at: at(-10), push_data: { commit_count: 2, action: 'pushed', ref_type: 'branch',
      commit_from: 'a'.repeat(40), commit_to: 'b'.repeat(40), ref: 'main', commit_title: 'One' }, ...fields })
  const sha = 'b'.repeat(40)
  const pushRoutes = (commits: unknown[] = [{ id: sha, short_id: 'b1b2b3b', title: 'One' }]) => ({
    issues: () => [], merge_requests: () => [],
    [`repository/commits/${sha}/merge_requests`]: () => [],
    'repository/compare': () => ({ commits, diffs: [] }),
  })

  it('only records a cursor on the first round', async () => {
    const h = host()
    const reads = gitlab(h, { issues: () => [], merge_requests: () => [], events: () => [{ ...event(5) }] })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gitlab.sinceEvents)).toBe('5')
    expect(reads.filter(path => path.startsWith('events?action=pushed&sort=asc'))).toHaveLength(0)
    h.store.close()
  })

  it('advances the cursor while the switch is off without producing Triggers, then takes in default-branch pushes', async () => {
    const h = host()
    h.store.saveSettings(pushSettings())
    h.store.set(KV.gitlab.sinceEvents, '1')
    const off = host(); off.store.set(KV.gitlab.sinceEvents, '1')
    gitlab(off, { issues: () => [], merge_requests: () => [], events: () => [event(2), event(3)] })
    await pollRound(off)
    expect(off.receive).not.toHaveBeenCalled()
    expect(off.store.get(KV.gitlab.sinceEvents)).toBe('3')
    off.store.close()
    // With the switch on, a push to the default branch by someone else becomes one Trigger listing the commits.
    gitlab(h, { ...pushRoutes(), events: () => [event(2)] })
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({
      id: key('gitlab-push', '2'), actor: { id: 'carol' }, human: true,
      threads: [{ source: SOURCE, id: `commit:${sha}` }],
      text: `carol pushed 2 commit(s) to main\nb1b2b3b One`,
      url: `${BASE}/-/compare/${'a'.repeat(40)}...${sha}`,
      channel: { source: SOURCE, thread: `gitlab:commit:${sha}`, address: { target: 'commit', sha, url: `${BASE}/-/compare/${'a'.repeat(40)}...${sha}` } },
      meta: { target: 'commit', kind: 'push', sha, before: 'a'.repeat(40), ref: 'main', count: 2 } })
    expect(h.store.get(KV.gitlab.sinceEvents)).toBe('2')
    h.store.close()
  })

  it('reads pushes newest first and stops at the cursor instead of reading the whole history', async () => {
    const h = host()
    h.store.saveSettings(pushSettings())
    h.store.set(KV.gitlab.sinceEvents, '150')
    // A full page, newest first, that already reaches the cursor: the next page is never requested.
    const page = Array.from({ length: 100 }, (_, index) => event(200 - index, { push_data: { commit_count: 1, action: 'pushed',
      ref_type: 'branch', commit_from: null, commit_to: sha, ref: 'dev' } }))
    const reads = gitlab(h, { issues: () => [], merge_requests: () => [], events: () => page })
    await pollRound(h)
    const eventReads = reads.filter(path => path.startsWith('events?'))
    expect(eventReads).toEqual(['events?action=pushed&sort=desc&per_page=100&page=1'])
    expect(h.store.get(KV.gitlab.sinceEvents)).toBe('200')
    h.store.close()
  })

  it('keeps other branches, the agent itself, and pushes a merged MR produced, and names a new branch by its single commit', async () => {
    const h = host()
    h.store.saveSettings(pushSettings())
    h.store.set(KV.gitlab.sinceEvents, '1')
    const commit = { id: 'c'.repeat(40), short_id: 'c1c2c3c', title: 'First', message: 'First\n\nbody', author_name: 'carol',
      created_at: at(-10), web_url: `${BASE}/-/commit/${'c'.repeat(40)}`, parent_ids: [] }
    gitlab(h, { issues: () => [], merge_requests: () => [], events: () => [
        event(2, { push_data: { commit_count: 1, action: 'pushed', ref_type: 'branch', commit_from: null, commit_to: sha, ref: 'main' } }),
        // Another branch, the agent itself, and a push a merged merge request produced.
        event(3, { push_data: { commit_count: 1, action: 'pushed', ref_type: 'branch', commit_from: null, commit_to: sha, ref: 'dev' } }),
        event(4, { author: author('agent-bot'), author_username: 'agent-bot',
          push_data: { commit_count: 1, action: 'pushed', ref_type: 'branch', commit_from: null, commit_to: sha, ref: 'main' } }),
      ],
      [`repository/commits/${sha}/merge_requests`]: () => [],
      [`repository/commits/${sha}`]: () => commit,
      [`repository/commits/${'c'.repeat(40)}/merge_requests`]: () => [{ iid: 9, state: 'merged' }],
    })
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ text: `carol pushed 1 commit(s) to main\nc1c2c3c First`,
      url: `${BASE}/-/commit/${sha}`, meta: { before: null } })
    h.store.close()
  })

  it('posts commit comments idempotently, answers gone on a 404, and links a commit channel', async () => {
    const h = host()
    const message = { id: 'r1', channel: { source: SOURCE, thread: `gitlab:commit:${sha}`, address: { target: 'commit', sha,
      url: `${BASE}/-/commit/${sha}` } }, text: 'I pushed a fix for this', kind: 'reply' } as const
    const posted: string[] = []
    const paths: string[] = []
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      const path = args[1]!
      paths.push(path)
      if (path.includes('/comments') && args.includes('POST')) { posted.push(args.find(a => String(a).startsWith('note='))!.slice(5)); return '{}' }
      if (path.includes('/comments')) return JSON.stringify([])
      throw notFound()
    })
    expect(await sendGitlab(h, message)).toBe('sent')
    expect(posted).toEqual(['I pushed a fix for this\n\n<!-- dsh-superagent:r1 -->'])
    expect(paths.at(-1)).toContain(`repository/commits/${sha}/comments`)
    // An agent comment already carrying the marker sends nothing again.
    vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify([
      { note: 'I pushed a fix for this\n\n<!-- dsh-superagent:r1 -->', author: author('agent-bot'), created_at: at(-5) }]))
    expect(await sendGitlab(h, message)).toBe('sent')
    // A deleted commit is gone.
    vi.spyOn(h.commands, 'run').mockRejectedValue(notFound())
    expect(await sendGitlab(h, message)).toBe('gone')
    h.store.close()
    expect(gitlabKind.channel!.link({ target: 'commit', sha, url: `${BASE}/-/commit/${sha}` }, {}))
      .toEqual({ url: `${BASE}/-/commit/${sha}`, label: { zh: `GitLab commit ${sha.slice(0, 8)}`, en: `GitLab commit ${sha.slice(0, 8)}` } })
  })

  it('fills the push environment variables and finds a commit by its full hash', () => {
    const config = gitlabKind.schema.parse({ observePushes: true })
    expect(gitlabKind.scope!({ meta: { kind: 'push' } }, config)).toEqual({ listened: true, observed: true, row: 'pushes' })
    expect(gitlabKind.scope!({ meta: { kind: 'push' } }, gitlabKind.schema.parse({}))).toMatchObject({ observed: false })
    const rows = gitlabKind.policy!.rows!(gitlabKind.schema.parse({}))
    expect(rows.map(row => row.id)).toEqual(['issues', 'mrs', 'comments', 'pushes'])
    expect(rows[3]!.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false })
    const values = gitlabKind.environment!.values({ deployment: testDeployment({ gitlab: AGENT }), config,
      trigger: ({ source: SOURCE, meta: { target: 'commit', sha: 'b'.repeat(40), before: 'a'.repeat(40) } }) as unknown as Trigger })
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITLAB_COMMIT: 'b'.repeat(40), DSH_SUPERAGENT_GITLAB_BEFORE: 'a'.repeat(40) })
    expect(gitlabKind.find!('b'.repeat(40))).toEqual({ threads: [`gitlab:commit:${'b'.repeat(40)}`], terms: [] })
  })
})

describe('gitlab reads', () => {
  const sha = 'c'.repeat(40)
  it('reads issues, merge requests, diffs, commits, and comparisons as model-facing records', async () => {
    const h = host()
    gitlab(h, {
      'issues/12': () => issue(12),
      'issues/12/discussions': () => [discussion('d1', [note(1, { body: 'looks wrong',
        position: { new_path: 'src/a.ts', new_line: 3, old_path: null, old_line: null } }), note(2, { system: true, body: 'changed' })])],
      'merge_requests/34': () => ({ ...issue(34, { web_url: `${BASE}/-/merge_requests/34` }), source_branch: 'fix', target_branch: 'main',
        draft: true, state: 'opened' }),
      'merge_requests/34/discussions': () => [discussion('d1', [note(3, { body: 'one more' })])],
      'merge_requests/34/diffs': () => [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@', new_file: false,
        deleted_file: false, renamed_file: false }],
      [`repository/commits/${sha}`]: () => ({ id: sha, short_id: 'c1c2c3c', title: 'One', message: 'One\n\nbody', author_name: 'carol',
        created_at: at(-10), web_url: `${BASE}/-/commit/${sha}`, parent_ids: [] }),
      [`repository/commits/${sha}/diff`]: () => [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@' }],
      'repository/compare': () => ({ commits: [{ id: sha, short_id: 'c1c2c3c', title: 'One', author_name: 'carol', created_at: at(-10) }],
        diffs: [{ old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1 +1 @@' }] }),
    })
    expect(await readGitlab(h.commands, 'gitlab/issues/12')).toMatchObject({ iid: 12, title: 'Fix the margin', state: 'opened',
      description: 'It is off', comments: [{ id: 1, discussion_id: 'd1', path: 'src/a.ts', line: 3, text: 'looks wrong' }] })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/34')).toMatchObject({ iid: 34, source_branch: 'fix',
      target_branch: 'main', draft: true, comments: [{ text: 'one more' }] })
    expect(await readGitlab(h.commands, 'gitlab/merge_requests/34/diffs')).toMatchObject({ iid: 34,
      diffs: [{ new_path: 'src/a.ts', diff: '@@ -1 +1 @@' }] })
    expect(await readGitlab(h.commands, `gitlab/commits/${sha}`)).toMatchObject({ short_id: 'c1c2c3c', title: 'One',
      diffs: [{ new_path: 'src/a.ts' }] })
    expect(await readGitlab(h.commands, `gitlab/compare/${'a'.repeat(40)}...${sha}`)).toMatchObject({ commits: [{ short_id: 'c1c2c3c' }],
      diffs: [{ new_path: 'src/a.ts' }] })
    await expect(readGitlab(h.commands, 'gitlab/nope')).rejects.toThrow()
    h.store.close()
  })

  it('reads a repository file and a directory listing from the default branch', async () => {
    const h = host()
    // A raw file comes back as the file's text, not JSON.
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^projects\/451\//, '')
      if (path.startsWith('repository/files/')) return '# hello'
      if (path.startsWith('repository/tree')) return JSON.stringify([{ name: 'src', type: 'tree', path: 'src' },
        { name: 'README.md', type: 'blob', path: 'README.md' }, { name: '.hidden', type: 'blob', path: '.hidden' }])
      throw notFound()
    })
    expect(await readGitlabRepositoryPath(h.commands, AGENT, 'src/README.md', 'file')).toBe('# hello')
    expect(await readGitlabRepositoryPath(h.commands, AGENT, 'src', 'directory')).toBe('README.md\nsrc/')
    await expect(readGitlabRepositoryPath(h.commands, AGENT, '../etc', 'file')).rejects.toThrow()
    h.store.close()
  })

  it('gives a commit Trigger its commit and comments as context, and references `!12` MR tickets', async () => {
    const h = host()
    const commitSha = 'd'.repeat(40)
    gitlab(h, {
      [`repository/commits/${commitSha}`]: () => ({ id: commitSha, short_id: 'd1d2d3d', title: 'One', message: 'One\n\nbody',
        author_name: 'carol', created_at: at(-10), web_url: `${BASE}/-/commit/${commitSha}`, parent_ids: [] }),
      [`repository/commits/${commitSha}/comments`]: () => [{ note: 'please split', author: author('carol'), created_at: at(-5) }],
    })
    const trigger = { source: SOURCE, url: `${BASE}/-/commit/${commitSha}`, at: at(-10),
      meta: { target: 'commit', kind: 'push', sha: commitSha } } as never
    const context = gitlabKind.threadContext!
    const read = await context.read(h.commands, trigger, 'thread', undefined, gitlabKind.schema.parse({}))
    expect(read.messages).toEqual([expect.objectContaining({ id: `${BASE}/-/commit/${commitSha}`, from: 'carol' }),
      expect.objectContaining({ from: 'carol', text: 'please split' })])
    // A commit Thread's root and parent are its commit followed by its comments.
    const ids = read.messages.map(message => message.id)
    expect((await context.read(h.commands, trigger, 'root', undefined, gitlabKind.schema.parse({}))).messages.map(m => m.id))
      .toEqual(ids)
    expect((await context.read(h.commands, trigger, 'parent', undefined, gitlabKind.schema.parse({}))).messages.map(m => m.id))
      .toEqual(ids)
    // `!34` in a candidate's text names the merge request's Thread and its tickets.
    h.store.threads.save({ key: 'gitlab:mr:34', ref: { source: SOURCE, id: 'mr:34' }, createdAt: at(-60), lastAt: at(-60),
      subscriptions: ['t1'], correlated: [], pending: [], meta: {} })
    h.store.tickets.save({ id: 't1', title: 'one', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '',
      basis: { via: 'listed' }, actor: { source: 'gitlab', id: 'carol' }, scope: '' }, channels: [], assignments: [], inputs: [],
      undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: [] } } as Ticket)
    const primary = issueTrigger(issue(50, { description: 'see !34' }), AGENT)
    h.store.triggers.save(primary)
    const candidate = { evalId: 'e1', strength: 'inferred' as const, triggers: [primary], tickets: [], policyVersion: '' }
    const card = await candidateCard({ store: h.store, links: new TextCache(1000), commands: h.commands, sources: h.sources,
      lifetime: new AbortController().signal }, candidate as never)
    expect(card).toMatchObject({ referenced_tickets: [{ ticket_id: 't1' }] })
    h.store.close()
  })
})
