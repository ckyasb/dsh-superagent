/** GitLab source kind definition, issue and merge-request polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Thread } from '../core/index.ts'
import { GitlabAccountsSchema, type GitlabAccount } from '../deployment.ts'
import type { Tally } from '../infra/commands.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { DiscussionSchema, IssueSchema, MergeRequestSchema, SOURCE, discussionNotes, isSelf, issueTrigger, mentions,
  mergeRequestTrigger, noteTrigger, threadId, threadKey, type GitlabIssue, type GitlabMergeRequest, type GitlabNote } from './gitlab-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollFailure, pollThreads as pollEach } from './poll.ts'
import type { Localized, SourceKind } from './kind.ts'

export { issueTrigger, mergeRequestTrigger, noteTrigger, SOURCE } from './gitlab-trigger.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false), observeComments: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', mrs: 'observeMergeRequests', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mrs'
  return meta.kind === 'note' ? 'comments' : undefined
}
export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的 Issue、合并请求与评论，并跟进已订阅的讨论。', en: 'The agent\'s GitLab account; receives Issues, merge requests, and comments addressed to it in the project, and follows subscribed discussions.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'host', type: 'text', pattern: '[A-Za-z0-9.-]+(:[0-9]+)?', label: { zh: 'GitLab 主机', en: 'GitLab host' },
      hint: { zh: '自建 GitLab 的主机名，如 git.zju.edu.cn。保存时检查智能体账号能否读到项目并推送，然后重启 dsh-superagent。', en: 'The hostname of the self-hosted GitLab, such as git.zju.edu.cn. Saving checks that the agent account can read the project and push, then restarts dsh-superagent.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9_.\\-]+(/[A-Za-z0-9_.\\-]+)+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/subgroup/name。这个来源接收这个项目的 Issue、合并请求和评论。', en: 'Written group/subgroup/name. This Source receives the project\'s Issues, merge requests, and comments.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用自己的配置目录登录智能体账号的 glab 包装脚本。智能体以它登录的账号行事，执行器以 glab 调用它。保存账号字段会检查权限并重启 dsh-superagent。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through its own configuration directory. The agent acts as the account it is signed in to, and the Executor calls it as glab. Saving an account field checks permissions and restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: '两次轮询之间等待的秒数。', en: 'Seconds to wait between polls.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。首次启用不回读以前的内容。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Nothing before the Source was first enabled is read.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新合并请求', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新合并请求也会收到，由策略的接收表决定是否成为候选。', en: 'New merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，Issue 和合并请求上没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments on Issues and merge requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } }],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  // `#12` names Issue 12, `!34` names merge request 34, and a bare number is ambiguous because the two sequences are independent.
  find: query => {
    const text = query.trim()
    const threads = new Set<string>()
    const issue = /^#(\d+)$/.exec(text)?.[1] ?? /\/-\/issues\/(\d+)/.exec(query)?.[1]
    const mr = /^!(\d+)$/.exec(text)?.[1] ?? /\/-\/merge_requests\/(\d+)/.exec(query)?.[1]
    const plain = /^(\d+)$/.exec(text)?.[1]
    if (issue) threads.add(threadKey('issue', Number(issue)))
    if (mr) threads.add(threadKey('mr', Number(mr)))
    if (plain) { threads.add(threadKey('issue', Number(plain))); threads.add(threadKey('mr', Number(plain))) }
    return { threads: [...threads], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收项目里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the project on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、合并请求或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a merge request, or a comment.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('mrs', { zh: '新合并请求', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Comments' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源监听的 GitLab 主机。智能体的 git 以这里写的凭据推送', en: 'The GitLab host this Source watches. The agent\'s git pushes with the credentials written here' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，写作 group/subgroup/name。智能体在这里开的分支，最后一段是 DSH_SUPERAGENT_NAME 时会关联到工单', en: 'The project this Source watches, as group/subgroup/name. A branch the agent opens here whose last path segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT_ID', description: { zh: '项目的数字 ID，可用来调用 GitLab API', en: 'The project\'s numeric ID, for GitLab API calls' } },
      { key: 'DSH_SUPERAGENT_GITLAB_WEB_URL', description: { zh: '项目网页的地址，如 https://git.zju.edu.cn/group/project', en: 'The project\'s web address, such as https://git.zju.edu.cn/group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_DEFAULT_BRANCH', description: { zh: '项目的默认分支名', en: 'The project\'s default branch name' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，GitLab 操作都用 glab，不用其他账号或凭据', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ISSUE_IID', description: { zh: '接下工单的 Issue 的 iid；工单不是从 Issue 来的时为空', en: 'The iid of the Issue that started the ticket; empty when it did not start on an Issue' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_IID', description: { zh: '接下工单的合并请求的 iid；工单不是从合并请求来的时为空', en: 'The iid of the merge request that started the ticket; empty when it did not start on one' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的合并请求的 head 引用 refs/merge-requests/<iid>/head；不是合并请求时为空', en: 'Head ref refs/merge-requests/<iid>/head of the merge request that started the ticket; empty when it was not one' } },
    ],
    values: ({ deployment, trigger }) => {
      const { gitlab } = deployment
      const origin = trigger?.source === SOURCE ? trigger : undefined
      const iid = Number(origin?.meta.iid) || 0
      const onIssue = origin?.meta.target === 'issue' && iid > 0
      const onMr = origin?.meta.target === 'mr' && iid > 0
      return { DSH_SUPERAGENT_GITLAB_HOST: gitlab?.host ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_PROJECT_ID: gitlab ? String(gitlab.projectId) : '', DSH_SUPERAGENT_GITLAB_WEB_URL: gitlab?.webUrl ?? '',
        DSH_SUPERAGENT_GITLAB_DEFAULT_BRANCH: gitlab?.defaultBranch ?? '', DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.commitEmail ?? '', DSH_SUPERAGENT_GITLAB_ISSUE_IID: onIssue ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_IID: onMr ? String(iid) : '', DSH_SUPERAGENT_GITLAB_MR_HEAD: onMr ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Re-checked every round, so configuring the GitLab Source or its account starts polling without a restart.
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      const configured = ctx.configured() && !!ctx.deployment.gitlab
      if (!ctx.configured()) ctx.report('gitlab', health('paused', 'setupPending'))
      else if (!configured) ctx.report('gitlab', health('paused', 'gitlabNotConfigured'))
      else if (config) { interval = await pollRound(ctx, signal); failures = 0 }
      else { ctx.report('gitlab', health('paused', 'sourceOff')); failures = 0 }
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; signal?: AbortSignal | undefined; read: Set<string>; failures: string[]; tally: Tally }
const newRound = (signal?: AbortSignal): Round =>
  ({ started: new Date().toISOString(), signal, read: new Set<string>(), failures: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/**
 * One polling round: the Issue stream, the merge-request stream, then subscribed Threads not already read in this round.
 * Each stream and each Thread fails independently so all steps run before the round fails.
 * @returns the polling interval the configuration requests, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return 60
  if (!ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'gitlabNotConfigured')); return config.pollSeconds }
  const round = newRound(signal)
  const commands = ctx.commands.withSignal(round.signal)
  await pollStream(ctx, commands, round, 'issues', config).catch(error => { if (!stopped(ctx, round)) round.failures.push(`issues: ${String(error)}`) })
  await pollStream(ctx, commands, round, 'mrs', config).catch(error => { if (!stopped(ctx, round)) round.failures.push(`merge requests: ${String(error)}`) })
  await pollSubscribed(ctx, round)
  if (signal?.aborted) return config.pollSeconds
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.report('gitlab', { state: 'ready', detail: `next poll ≥ ${config.pollSeconds}s${round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''}`,
    at: round.started })
  return config.pollSeconds
}
type Stream = 'issues' | 'mrs'
/**
 * Reads one project-wide stream (new Issues or new merge requests with their comments) since its cursor and steps the cursor
 * to five seconds before the round started. The first round only sets the cursor, so a Source switched on reads nothing earlier.
 */
async function pollStream(ctx: SourceContext, commands: ReturnType<SourceContext['commands']['withSignal']>, round: Round, stream: Stream,
  config: GitlabConfig): Promise<void> {
  const account = ctx.deployment.gitlab!
  const name = stream === 'issues' ? KV.gitlab.sinceIssues : KV.gitlab.sinceMrs
  const since = ctx.state.get(name)
  if (since === undefined) { ctx.state.set(name, round.started); return }
  const path = `${stream === 'issues' ? 'issues' : 'merge_requests'}?updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=asc&scope=all`
  const listed = await commands.gitlabPages(stream === 'issues'
    ? IssueSchema as z.ZodType<GitlabIssue> : MergeRequestSchema as z.ZodType<GitlabMergeRequest>, path, round.tally)
  for (const item of listed) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const target = stream === 'issues' ? 'issue' as const : 'mr' as const
    const iid = item.iid
    const opened = Date.parse(item.created_at) >= Date.parse(since) && !isSelf(item.author, account)
    // A description reaches the gate when it mentions the agent, or when the stream is observed in full.
    if (opened && (mentions(item.description ?? '', account.login) || (stream === 'issues' ? config.observeIssues : config.observeMergeRequests))) {
      await ctx.receive(stream === 'issues' ? issueTrigger(item, account) : mergeRequestTrigger(item, account))
    }
    describe(ctx, target, iid, item.title, item.state)
    await readComments(ctx, commands, round, account, { target, iid, url: item.web_url,
      ...target === 'mr' ? { mrAuthor: (item as GitlabMergeRequest).author.username } : {} }, ctx.state.get(KV.gitlab.cursor(target, iid)) ?? since,
      config)
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
  }
  // Never move a cursor backwards: rounds closer than the five-second overlap would otherwise re-read what they covered.
  const next = cursorAt(round.started)
  if (Date.parse(next) > Date.parse(since)) ctx.state.set(name, next)
}
/** Reads one Issue's or merge request's non-system comments newer than `since`, receiving the ones that reach the gate. */
async function readComments(ctx: SourceContext, commands: ReturnType<SourceContext['commands']['withSignal']>, round: Round,
  account: GitlabAccount, ref: { target: 'issue' | 'mr'; iid: number; url?: string; mrAuthor?: string }, since: string,
  config: GitlabConfig): Promise<void> {
  const checkpoint = KV.gitlab.cursor(ref.target, ref.iid)
  const discussions = await commands.gitlabPages(DiscussionSchema, `${ref.target === 'issue' ? 'issues' : 'merge_requests'}/${ref.iid}/discussions`)
  let newest = Date.parse(since)
  for (const discussion of discussions) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    const notes = discussionNotes(discussion)
    for (const note of notes) {
      const at = Date.parse(note.updated_at ?? note.created_at)
      // A note at the cursor itself was read by the round that set it, so only later ones are new.
      if (!Number.isFinite(at) || at <= Date.parse(since)) continue
      newest = Math.max(newest, at)
      // The agent's own comments, and system notes already dropped above, produce no Trigger.
      if (isSelf(note.author, account)) continue
      const subscribed = (ctx.threads.get(threadKey(ref.target, ref.iid))?.subscriptions.length ?? 0) > 0
      if (!mentions(note.body ?? '', account.login) && !subscribed && !config.observeComments) continue
      await ctx.receive(noteTrigger(note, ref, discussion.individual_note === true ? undefined : discussion.id, account))
    }
  }
  if (newest > Date.parse(since)) ctx.state.set(checkpoint, new Date(newest).toISOString())
  else if (Date.parse(cursorAt(round.started)) > Date.parse(since)) ctx.state.set(checkpoint, cursorAt(round.started))
}
/** Polls subscribed Issue and merge-request Threads not already read in this round, so followed discussions are never skipped. */
async function pollSubscribed(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config) return
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => { await pollThread(ctx, round, thread, config) },
    thread => round.read.has(thread.key))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread, config: GitlabConfig): Promise<void> {
  const target = thread.ref.id.startsWith('mr:') ? 'mr' as const : thread.ref.id.startsWith('issue:') ? 'issue' as const : undefined
  const iid = Number(thread.ref.id.split(':')[1])
  if (!target || !iid) throw new Error('Subscribed thread has no GitLab Issue or merge request iid')
  round.read.add(thread.key)
  const account = ctx.deployment.gitlab!
  const commands = ctx.commands.withSignal(round.signal)
  const checkpoint = KV.gitlab.cursor(target, iid)
  await readComments(ctx, commands, round, account, { target, iid,
    ...target === 'mr' ? { mrAuthor: typeof thread.meta.mrAuthor === 'string' ? thread.meta.mrAuthor : undefined } : {} },
    ctx.state.get(checkpoint) ?? thread.createdAt, config)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
/** Names a Thread after its Issue or merge request, with the item's state as a fact. */
function describe(ctx: SourceContext, target: 'issue' | 'mr', iid: number, title: string, state: string): void {
  const key = threadKey(target, iid)
  ctx.threads.patch(key, { title })
  ctx.threads.describe(key, { label: `${target === 'issue' ? `Issue #${iid}` : `MR !${iid}`} ${title}`,
    facts: { state: { value: state === 'opened' ? 'open' : state } } })
}
