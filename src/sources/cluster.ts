/** Cluster Source kind: Argo CD sync failures and the daily patrol report, polled by kubectl and offered to the Policy as inferred candidates. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { validItems } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { ApplicationSchema, argocdTrigger, argocdFailure, argocdRevision, SOURCE, type Application } from './cluster-argocd.ts'
import { PatrolJobSchema, patrolEndedAt, patrolFinished, patrolOfCronJob, patrolReport, patrolTrigger, type PatrolJob } from './cluster-patrol.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause, pollFailure } from './poll.ts'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, Localized, SourceKind, ThreadContext } from './kind.ts'

export { SOURCE, argocdTrigger, argocdFailure, argocdRevision } from './cluster-argocd.ts'
export { patrolTrigger, patrolReport, patrolOfCronJob, patrolFinished, patrolEndedAt } from './cluster-patrol.ts'

export const ClusterConfigSchema = z.object({
  argocd: z.object({ enabled: z.boolean().default(false), namespace: z.string().default('argocd'),
    ignore: z.array(z.string()).default([]) }).strict().default({ enabled: false, namespace: 'argocd', ignore: [] }),
  patrol: z.object({ enabled: z.boolean().default(false), namespace: z.string().default('dsh'),
    cronJob: z.string().default('dsh-patrol') }).strict().default({ enabled: false, namespace: 'dsh', cronJob: 'dsh-patrol' }),
  reportTo: z.object({ conversationId: z.string().default('') }).strict().default({ conversationId: '' }),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type ClusterConfig = z.infer<typeof ClusterConfigSchema>
/** Runs one read-only kubectl call and validates its JSON output. */
async function kubectl<T>(commands: Commands, schema: z.ZodType<T>, args: string[]): Promise<T> {
  return schema.parse(JSON.parse(await commands.run('kubectl', [...args, '-o', 'json', '--request-timeout=30s'])))
}
const listing = z.looseObject({ items: z.array(z.unknown()).nullish() })
/** True when the change from one fingerprint to the next is a failure worth a Trigger: a first failure, or a failure at a new revision. */
export function argocdChanged(previous: string, current: string): boolean {
  const before = JSON.parse(previous) as { revision: string; failure: string }
  const now = JSON.parse(current) as { revision: string; failure: string }
  if (!before.failure && now.failure) return true
  return !!before.failure && !!now.failure && before.revision !== now.revision
}
/** Reads every application once per round; the first sight of one only records its baseline, and ignored ones are not read at all. */
export async function pollArgocd(ctx: SourceContext, commands: Commands, config: ClusterConfig): Promise<void> {
  const { items } = await kubectl(commands, listing, ['get', 'applications.argoproj.io', '-n', config.argocd.namespace])
  for (const item of validItems(ApplicationSchema, items ?? [])) {
    const app = item.metadata.name
    if (config.argocd.ignore.includes(app)) continue
    const fingerprint = JSON.stringify({ revision: argocdRevision(item), failure: argocdFailure(item) })
    const previous = ctx.state.get(KV.cluster.argocd(app))
    const count = previous?.revision ?? 0
    if (previous && argocdChanged(previous.fingerprint, fingerprint)) {
      await ctx.receive(argocdTrigger(item, count + 1, config.reportTo.conversationId))
      ctx.state.set(KV.cluster.argocd(app), { fingerprint, revision: count + 1 })
    } else ctx.state.set(KV.cluster.argocd(app), { fingerprint, revision: count })
  }
}
/** Reads the finished patrol Jobs newer than the newest one already processed; the first round only records that one. */
export async function pollPatrol(ctx: SourceContext, commands: Commands, config: ClusterConfig): Promise<void> {
  const { items } = await kubectl(commands, listing, ['get', 'jobs', '-n', config.patrol.namespace])
  const finished = validItems(PatrolJobSchema, items ?? [])
    .filter(job => patrolOfCronJob(job, config.patrol.cronJob) && patrolFinished(job))
    .sort((a, b) => patrolEndedAt(a) - patrolEndedAt(b))
  const processed = ctx.state.get(KV.cluster.patrol)
  if (!processed) {
    const latest = finished.at(-1)
    if (latest) ctx.state.set(KV.cluster.patrol, { job: latest.metadata.name, at: new Date(patrolEndedAt(latest)).toISOString() })
    return
  }
  // A Job record Kubernetes has already dropped is replaced by its end time, so no older Job is read again.
  const index = finished.findIndex(job => job.metadata.name === processed.job)
  const start = index >= 0 ? index + 1 : finished.findIndex(job => patrolEndedAt(job) > Date.parse(processed.at))
  const pending = start < 0 ? [] : finished.slice(start)
  for (const job of pending) await readPatrolJob(ctx, commands, job, config)
}
async function readPatrolJob(ctx: SourceContext, commands: Commands, job: PatrolJob, config: ClusterConfig): Promise<void> {
  const name = job.metadata.name
  const at = patrolEndedAt(job)
  // `logs` prints text, not JSON, so it runs without the `-o json` the other reads add.
  const log = await commands.run('kubectl', ['logs', `job/${name}`, '-n', config.patrol.namespace, '--tail=-1'])
  const report = patrolReport(log)
  if (report) await ctx.receive(patrolTrigger(name, report.text, report.status, at, config.reportTo.conversationId))
  ctx.state.set(KV.cluster.patrol, { job: name, at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString() })
}
/** DingTalk keeps no group history a bot can read, so a Trigger's context is the Trigger itself. */
export const clusterThreadContext: ThreadContext<ClusterConfig> = {
  messageId: trigger => trigger.id,
  read: async (_commands, trigger) => {
    const message: ContextMessage = { id: trigger.id, from: '', at: trigger.at, text: trigger.text }
    return { messages: [message], status: 'no_history', body: { messages: [message] } }
  },
}
export const clusterKind: SourceKind<ClusterConfig> = {
  kind: SOURCE,
  title: { zh: '集群', en: 'Cluster' },
  description: { zh: '只读地观察集群：Argo CD 应用同步失败或不健康、每日巡检报告发现异常时产生触发，交给策略里写好的规则评估。', en: 'Reads the cluster read-only: Argo CD applications that fail to sync or turn unhealthy, and daily patrol reports with an alert, become Triggers for the Policy\'s rules.' },
  schema: ClusterConfigSchema,
  fields: [
    { key: 'argocd.enabled', type: 'switch', label: { zh: '接收 Argo CD 同步失败', en: 'Receive Argo CD sync failures' },
      hint: { zh: '打开后，应用的同步失败或健康变差会收到；第一次见到每个应用只记录基线，不产生触发。', en: 'Failures of an application\'s sync, or its health turning bad, are received; the first sight of an application only records its baseline.' } },
    { key: 'argocd.namespace', type: 'text', label: { zh: 'Argo CD 命名空间', en: 'Argo CD namespace' },
      hint: { zh: 'Application 资源所在的命名空间，默认 argocd。', en: 'The namespace holding the Application resources; argocd by default.' } },
    { key: 'argocd.ignore', type: 'rows', label: { zh: '忽略的应用', en: 'Ignored applications' },
      hint: { zh: '这些 Argo CD 应用不检查。', en: 'These Argo CD applications are not checked.' },
      columns: [{ key: 'name', type: 'text', label: { zh: '应用', en: 'Application' } }] },
    { key: 'patrol.enabled', type: 'switch', label: { zh: '接收每日巡检异常', en: 'Receive daily patrol alerts' },
      hint: { zh: '打开后，巡检 Job 的日志里有 ALERT 报告或巡检本身失败时收到。', en: 'A patrol Job whose log holds an ALERT report, or whose patrol failed, is received.' } },
    { key: 'patrol.namespace', type: 'text', label: { zh: '巡检命名空间', en: 'Patrol namespace' },
      hint: { zh: '巡检 Job 所在的命名空间，默认 dsh。', en: 'The namespace holding the patrol Jobs; dsh by default.' } },
    { key: 'patrol.cronJob', type: 'text', label: { zh: '巡检 CronJob 名', en: 'Patrol CronJob name' },
      hint: { zh: '默认 dsh-patrol；它跑出的 Job（含手动 create job --from 产生的）会检查。', en: 'dsh-patrol by default; the Jobs it runs, including ones started by a manual create job --from, are checked.' } },
    { key: 'reportTo.conversationId', type: 'text', label: { zh: '报告到的钉钉群 conversationId', en: 'DingTalk group conversationId to report to' },
      hint: { zh: '集群事件的回复发到这个钉钉群；留空则触发没有 channel，只出现在面板里。', en: 'Replies to a cluster event go to this DingTalk group; leave it empty and the Trigger has no channel, appearing only in the panel.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '两次轮询之间等待的秒数。', en: 'Seconds to wait between polls.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次失败会在下一次轮询时自动重试，不必报告。', en: 'A single failure is retried on the next poll and need not be reported.' } },
  ],
  scope: ({ meta }, config) => meta.kind === 'argocd'
    ? config.argocd.enabled ? { listened: true, observed: true, row: 'argocd' } : { listened: false, reason: 'argocd_off' }
    : meta.kind === 'patrol'
      ? config.patrol.enabled ? { listened: true, observed: true, row: 'patrol' } : { listened: false, reason: 'patrol_off' }
      : { listened: false, reason: 'unknown_kind' },
  health: [SOURCE],
  threadContext: clusterThreadContext,
  // `argocd:<app>` or a bare application name names the application's Thread.
  find: query => {
    const text = query.trim()
    const app = /^argocd:(.+)$/.exec(text)?.[1] ?? (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : '')
    return { threads: app ? [`${SOURCE}:argocd:${app}`] : [], terms: [] }
  },
  policy: {
    // A cluster event has no sender, so there is nobody to list; `allowed` keeps the shape the gate reads.
    schema: z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).default([]) }).strict(),
    fields: [],
    explicit: { zh: '没有：这个来源没有发送者，集群事件不会成为明确请求。', en: 'None: this Source has no senders, and a cluster event never makes an explicit request.' },
    rows(stored) {
      const config = ClusterConfigSchema.partial().parse(stored)
      const row = (id: 'argocd' | 'patrol', label: Localized, enabled: boolean | undefined) => ({
        id, label, note: enabled ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!enabled } })
      return [row('argocd', { zh: 'Argo CD 同步', en: 'Argo CD syncs' }, config.argocd?.enabled),
        row('patrol', { zh: '每日巡检', en: 'Daily patrol' }, config.patrol?.enabled)]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_CLUSTER_KIND', description: { zh: '集群事件的种类：argocd 或 patrol；工单不是从集群来的时为空', en: 'The kind of cluster event, argocd or patrol; empty when the ticket did not start on the cluster' } },
      { key: 'DSH_SUPERAGENT_CLUSTER_APP', description: { zh: '同步失败的 Argo CD 应用名；不是 Argo CD 事件时为空', en: 'The Argo CD application that failed to sync; empty when the event is not an Argo CD one' } },
      { key: 'DSH_SUPERAGENT_CLUSTER_REVISION', description: { zh: '应用失败时所在的 revision；不是 Argo CD 事件时为空', en: 'The revision the application failed at; empty when the event is not an Argo CD one' } },
      { key: 'DSH_SUPERAGENT_CLUSTER_PATROL_JOB', description: { zh: '产生巡检触发的 Job 名；不是巡检事件时为空', en: 'The patrol Job that produced the trigger; empty when the event is not a patrol one' } },
    ],
    values: ({ trigger }) => {
      const origin = trigger?.source === SOURCE ? trigger : undefined
      const argocd = origin?.meta.kind === 'argocd'
      const patrol = origin?.meta.kind === 'patrol'
      return { DSH_SUPERAGENT_CLUSTER_KIND: argocd ? 'argocd' : patrol ? 'patrol' : '',
        DSH_SUPERAGENT_CLUSTER_APP: argocd ? String(origin?.meta.app ?? '') : '',
        DSH_SUPERAGENT_CLUSTER_REVISION: argocd ? String(origin?.meta.revision ?? '') : '',
        DSH_SUPERAGENT_CLUSTER_PATROL_JOB: patrol ? String(origin?.meta.job ?? '') : '' }
    },
  },
}
export const name = 'dsh-superagent-cluster'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(clusterKind), 'cluster: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, clusterKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Re-checked every round, so enabling the Cluster Source starts polling without a restart.
  while (!signal.aborted) {
    const config = ctx.config<ClusterConfig>(SOURCE)
    try {
      if (!ctx.configured()) ctx.report(SOURCE, health('paused', 'setupPending'))
      else if (!config) { ctx.report(SOURCE, health('paused', 'sourceOff')); failures = 0 }
      else if (!config.argocd.enabled && !config.patrol.enabled) { ctx.report(SOURCE, health('paused', 'clusterNothingEnabled')); failures = 0 }
      else { interval = await pollRound(ctx, signal); failures = 0 }
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report(SOURCE, failed)
    }
    await pause(Math.max(interval, ctx.config<ClusterConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
/** One polling round: the Argo CD applications, then the patrol Jobs; each fails independently so both run before the round fails. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const config = ctx.config<ClusterConfig>(SOURCE)
  if (!config) return 60
  const failures: string[] = []
  const commands = ctx.commands.withSignal(signal)
  if (config.argocd.enabled) await pollArgocd(ctx, commands, config).catch((error: unknown) => { failures.push(`argocd: ${String(error)}`) })
  if (config.patrol.enabled) await pollPatrol(ctx, commands, config).catch((error: unknown) => { failures.push(`patrol: ${String(error)}`) })
  if (signal?.aborted) return config.pollSeconds
  if (failures.length) throw new Error(`${failures.length} cluster reads failed: ${failures.join('; ')}`)
  ctx.report(SOURCE, { state: 'ready', detail: `next poll ≥ ${config.pollSeconds}s`, at: new Date().toISOString() })
  return config.pollSeconds
}
