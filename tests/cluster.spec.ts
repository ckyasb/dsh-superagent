/** The Cluster Source: Argo CD failure fingerprints, patrol Job reports, the kind's scope and policy rows, and the DingTalk reply channel. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Engine, key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { apply as applyCluster, clusterKind, ClusterConfigSchema, pollRound } from '../src/sources/cluster.ts'
import { SOURCE } from '../src/sources/cluster-argocd.ts'
import { sendDingtalk } from '../src/sources/dingtalk-channel.ts'
import { resetDingtalkTokenCache } from '../src/deployment.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const baseConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ argocd: { enabled: true, namespace: 'argocd', ignore: [] }, patrol: { enabled: true, namespace: 'dsh', cronJob: 'dsh-patrol' },
    reportTo: { conversationId: 'cidG' }, pollSeconds: 60, failuresBeforeError: 3, ...overrides })
/** One Argo CD Application as `kubectl get applications.argoproj.io` prints it, healthy and synced by default. */
const app = (name: string, fields: Record<string, unknown> = {}, revision = 'r1'): Record<string, unknown> =>
  ({ metadata: { name }, status: { sync: { status: 'Synced', revision }, health: { status: 'Healthy' },
    operationState: { phase: 'Succeeded', message: '', syncResult: { revision } }, conditions: [], resources: [], ...fields } })
const failed = (phase = 'Failed', revision = 'r1', extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ operationState: { phase, message: 'Sync failed: timeout', syncResult: { revision } }, health: { status: 'Degraded' }, ...extra })
const patrolJob = (name: string, endedAt: string, fields: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ metadata: { name, creationTimestamp: endedAt, ownerReferences: [{ kind: 'CronJob', name: 'dsh-patrol' }] },
    status: { succeeded: 1, failed: 0, completionTime: endedAt }, ...fields })

function host(overrides: Partial<SourceContextDeps> = {}, sourceConfig: Record<string, unknown> = baseConfig()) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'cluster-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { sources: { cluster: { allowed: [] } } },
    sources: { cluster: { enabled: true, config: sourceConfig } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(clusterKind)
  const deployment = testDeployment()
  const assessor = { request: vi.fn(async () => {}) }
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment, ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(parts, clusterKind)
  return { ...parts, ...ctx, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind),
    store, receive, health: board.all, engine }
}
/** Fakes `kubectl`: Argo CD applications, patrol Jobs and Job logs answered from the given state. */
function kubectl(h: ReturnType<typeof host>, state: { apps: () => unknown[]; jobs?: () => unknown[]; logs?: Record<string, string> }) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    if (args[0] !== 'get' && args[0] !== 'logs') throw new Error(`unexpected kubectl args: ${args.join(' ')}`)
    if (args[0] === 'get' && args[1] === 'applications.argoproj.io') return JSON.stringify({ items: state.apps() })
    if (args[0] === 'get' && args[1] === 'jobs') return JSON.stringify({ items: (state.jobs ?? (() => []))() })
    if (args[0] === 'logs') return state.logs?.[args[1]!] ?? 'all good (OK)'
    throw new Error(`unexpected kubectl args: ${args.join(' ')}`)
  })
}
const triggers = (h: ReturnType<typeof host>): Trigger[] => h.receive.mock.calls.map(([trigger]) => trigger)

describe('cluster source: argo cd', () => {
  it('records a baseline without a trigger, then one trigger for a failure, none for the same failure again', async () => {
    const h = host()
    let state = { apps: [app('demo')] }
    kubectl(h, { apps: () => state.apps })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('cluster-argocd:demo')).toMatchObject({ revision: 0 })
    state = { apps: [app('demo', failed(), 'r1')] }
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    const trigger = triggers(h)[0]!
    expect(trigger).toMatchObject({ source: SOURCE, id: key('cluster-argocd', 'demo', '1'),
      threads: [{ source: SOURCE, id: 'argocd:demo' }], actor: { source: SOURCE, id: '' }, human: false,
      channel: { source: 'dingtalk', thread: 'dingtalk:cidG:cluster', address: { conversationId: 'cidG', senderNick: '' } },
      meta: { kind: 'argocd', app: 'demo', revision: 'r1', failure: 'Failed', phase: 'Failed', health: 'Degraded', sync: 'Synced' } })
    // The same failure at the same revision is quiet.
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    // A failure at a new revision reports once more, under its own id.
    state = { apps: [app('demo', failed(), 'r2')] }
    await pollRound(h)
    expect(triggers(h)[1]).toMatchObject({ id: key('cluster-argocd', 'demo', '2'), meta: { revision: 'r2', failure: 'Failed' } })
    // Recovery is recorded without a Trigger.
    state = { apps: [app('demo')] }
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.store.get('cluster-argocd:demo')).toMatchObject({ revision: 2 })
    h.store.close()
  })
  it('treats Progressing and OutOfSync as ordinary states, and ignores the applications on its list', async () => {
    const h = host()
    let state = { apps: [app('demo'), app('quiet')] }
    kubectl(h, { apps: () => state.apps })
    await pollRound(h)
    // A sync under way is not a failure even after the baseline exists.
    state = { apps: [app('demo', { sync: { status: 'OutOfSync', revision: 'r9' }, health: { status: 'Progressing' }, operationState: { phase: 'Running', message: '', syncResult: { revision: 'r9' } } }), app('quiet', failed())] }
    await pollRound(h)
    expect(triggers(h).map(trigger => trigger.meta.app)).toEqual(['quiet'])
    // An ignored application is not read at all, not even for its baseline.
    const h2 = host({}, baseConfig({ argocd: { enabled: true, namespace: 'argocd', ignore: ['demo'] }, patrol: { enabled: false, namespace: 'dsh', cronJob: 'dsh-patrol' } }))
    state = { apps: [app('demo')] }
    kubectl(h2, { apps: () => state.apps })
    await pollRound(h2)
    state = { apps: [app('demo', failed())] }
    await pollRound(h2)
    expect(h2.receive).not.toHaveBeenCalled()
    expect(h2.store.get('cluster-argocd:demo')).toBeUndefined()
    h.store.close(); h2.store.close()
  })
  it('writes the failure details into the text: the operation message, the conditions and the unhealthy resources', async () => {
    const h = host()
    const detailed = { conditions: [{ type: 'ComparisonError', message: 'yaml parse error' }],
      resources: [{ kind: 'Deployment', namespace: 'web', name: 'api', status: 'OutOfSync', health: { status: 'Degraded', message: 'crash loop' } },
        { kind: 'Service', namespace: 'web', name: 'api', status: 'Synced', health: { status: 'Healthy' } }] }
    let state = { apps: [app('demo', detailed)] }
    kubectl(h, { apps: () => state.apps })
    await pollRound(h)
    state = { apps: [app('demo', { ...failed(), ...detailed })] }
    await pollRound(h)
    const text = triggers(h)[0]!.text
    expect(text.split('\n')[0]).toBe('Argo CD application demo Failed at revision r1')
    expect(text).toContain('Sync failed: timeout')
    expect(text).toContain('ComparisonError: yaml parse error')
    expect(text).toContain('Deployment/web/api: OutOfSync, Degraded — crash loop')
    expect(text).not.toContain('Service')
    h.store.close()
  })
  it('sends no channel when reportTo is empty, and an Argo CD-off scope is not listened to', async () => {
    const h = host({}, baseConfig({ reportTo: { conversationId: '' } }))
    let state = { apps: [app('demo')] }
    kubectl(h, { apps: () => state.apps })
    await pollRound(h)
    state = { apps: [app('demo', failed())] }
    await pollRound(h)
    expect(triggers(h)[0]).not.toHaveProperty('channel')
    // Without the switch, the kind does not listen to its own triggers.
    const off = ClusterConfigSchema.parse({})
    expect(clusterKind.scope!({ meta: { kind: 'argocd' } }, off)).toEqual({ listened: false, reason: 'argocd_off' })
    expect(clusterKind.scope!({ meta: { kind: 'patrol' } }, off)).toEqual({ listened: false, reason: 'patrol_off' })
    expect(clusterKind.scope!({ meta: { kind: 'argocd' } }, ClusterConfigSchema.parse(baseConfig({ argocd: { enabled: true, namespace: 'argocd', ignore: [] } }))))
      .toEqual({ listened: true, observed: true, row: 'argocd' })
    h.store.close()
  })
})

describe('cluster source: patrol', () => {
  it('records the newest finished Job as its baseline, then reads every newer Job once', async () => {
    const h = host()
    let state = { jobs: [patrolJob('dsh-patrol-1', '2026-09-09T16:00:00Z')], logs: {} as Record<string, string> }
    kubectl(h, { apps: () => [], jobs: () => state.jobs, logs: state.logs })
    await pollRound(h)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get('cluster-patrol-cursor')).toEqual({ job: 'dsh-patrol-1', at: '2026-09-09T16:00:00.000Z' })
    // A newer Job with an ALERT report produces one Trigger whose text is the report.
    state.jobs = [patrolJob('dsh-patrol-1', '2026-09-09T16:00:00Z'), patrolJob('dsh-patrol-2', '2026-09-10T01:30:00Z')]
    state.logs['job/dsh-patrol-2'] = 'patrol starting\n----- report (ALERT) -----\nDisk /dev/sda is 91% full\nnode-3 has a failing pod\n-----\n'
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(triggers(h)[0]).toMatchObject({ source: SOURCE, id: key('cluster-patrol', 'dsh-patrol-2'),
      threads: [{ source: SOURCE, id: 'patrol:2026-09-10' }], human: false,
      channel: { source: 'dingtalk', address: { conversationId: 'cidG' } }, text: 'Disk /dev/sda is 91% full\nnode-3 has a failing pod',
      meta: { kind: 'patrol', job: 'dsh-patrol-2', status: 'ALERT' } })
    // The same Job is not read again.
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    // An OK report produces no Trigger, but the cursor still moves.
    state.jobs = [...state.jobs, patrolJob('dsh-patrol-3', '2026-09-11T01:30:00Z')]
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.store.get('cluster-patrol-cursor')).toEqual({ job: 'dsh-patrol-3', at: '2026-09-11T01:30:00.000Z' })
    h.store.close()
  })
  it('reports a patrol that failed, and takes manual Jobs named after the CronJob', async () => {
    const h = host()
    let state = { jobs: [patrolJob('dsh-patrol-1', '2026-09-09T16:00:00Z')], logs: {} as Record<string, string> }
    kubectl(h, { apps: () => [], jobs: () => state.jobs, logs: state.logs })
    await pollRound(h)
    // A manual `create job --from=cronjob/dsh-patrol` Job carries the CronJob's name as a prefix.
    state.jobs = [...state.jobs, patrolJob('dsh-patrol-manual', '2026-09-10T02:00:00Z')]
    state.logs['job/dsh-patrol-manual'] = 'checking\npatrol failed: kubectl quit with exit code 1\nthe cluster API refused the read\n'
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(triggers(h)[0]).toMatchObject({ id: key('cluster-patrol', 'dsh-patrol-manual'),
      threads: [{ source: SOURCE, id: 'patrol:2026-09-10' }], text: 'the cluster API refused the read',
      meta: { kind: 'patrol', job: 'dsh-patrol-manual', status: 'FAILED' } })
    // A Job of another CronJob, finished or not, is not read.
    state.jobs = [...state.jobs, patrolJob('other-1', '2026-09-11T02:00:00Z', { metadata: { name: 'other-1', creationTimestamp: '2026-09-11T02:00:00Z', ownerReferences: [{ kind: 'CronJob', name: 'other' }] } })]
    state.logs['job/other-1'] = '----- report (ALERT) -----\nunrelated\n-----'
    await pollRound(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    h.store.close()
  })
})

describe('cluster source: kind', () => {
  it('declares its admission rows with only the unlisted-unaddressed cell, and its environment from the trigger', () => {
    const rows = clusterKind.policy!.rows!(ClusterConfigSchema.parse(baseConfig()))
    expect(rows.map(row => row.id)).toEqual(['argocd', 'patrol'])
    for (const row of rows) expect(row.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true })
    expect(clusterKind.policy!.rows!(ClusterConfigSchema.parse({})).every(row => !row.cells.unlistedUnaddressed)).toBe(true)
    expect(clusterKind.health).toEqual([SOURCE])
    const argocdTrigger: Trigger = { id: 't1', source: SOURCE, threads: [{ source: SOURCE, id: 'argocd:demo' }],
      actor: { source: SOURCE, id: '' }, human: false, at: '', text: '', meta: { kind: 'argocd', app: 'demo', revision: 'r2' } }
    const patrolTrigger: Trigger = { id: 't2', source: SOURCE, threads: [{ source: SOURCE, id: 'patrol:2026-09-10' }],
      actor: { source: SOURCE, id: '' }, human: false, at: '', text: '', meta: { kind: 'patrol', job: 'dsh-patrol-2' } }
    expect(clusterKind.environment!.values({ deployment: testDeployment(), config: ClusterConfigSchema.parse(baseConfig()), trigger: argocdTrigger }))
      .toEqual({ DSH_SUPERAGENT_CLUSTER_KIND: 'argocd', DSH_SUPERAGENT_CLUSTER_APP: 'demo', DSH_SUPERAGENT_CLUSTER_REVISION: 'r2', DSH_SUPERAGENT_CLUSTER_PATROL_JOB: '' })
    expect(clusterKind.environment!.values({ deployment: testDeployment(), config: ClusterConfigSchema.parse(baseConfig()), trigger: patrolTrigger }))
      .toEqual({ DSH_SUPERAGENT_CLUSTER_KIND: 'patrol', DSH_SUPERAGENT_CLUSTER_APP: '', DSH_SUPERAGENT_CLUSTER_REVISION: '', DSH_SUPERAGENT_CLUSTER_PATROL_JOB: 'dsh-patrol-2' })
    expect(clusterKind.find!('argocd:demo')).toEqual({ threads: ['cluster:argocd:demo'], terms: [] })
    expect(clusterKind.find!('demo')).toEqual({ threads: ['cluster:argocd:demo'], terms: [] })
  })
  it('registers its kind, reports paused while nothing is enabled, and unregisters on disposal', async () => {
    const value = host({}, baseConfig({ argocd: { enabled: false, namespace: 'argocd', ignore: [] }, patrol: { enabled: false, namespace: 'dsh', cronJob: 'dsh-patrol' } }))
    const disposers: (() => unknown)[] = []
    const sources = new SourceRegistry(() => value.store.settings(), new HealthBoard())
    applyCluster({ orchestrator: { ...value, sources }, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(value.health.cluster).toBeDefined())
    const health = { ...value.health }
    for (const dispose of disposers) await dispose()
    expect(health.cluster).toMatchObject({ state: 'paused', code: 'clusterNothingEnabled' })
    expect(health.cluster!.detail).toContain('Neither the Argo CD watch nor the patrol is enabled')
  })
})

describe('dingtalk channel for cluster events', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dingtalk-')); resetDingtalkTokenCache() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals() })
  it('sends a group message without a senderStaffId, without an @ prefix, and still refuses a direct chat without one', async () => {
    writeFileSync(join(dir, 'clientId'), 'cli_bot\n')
    writeFileSync(join(dir, 'clientSecret'), 'supersecret')
    const calls: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ url: String(url), body })
      return { ok: true, status: 200, json: async () => ({ accessToken: 'at', expireIn: 7200 }), text: async () => JSON.stringify({}) } as Response
    }))
    const deployment = testDeployment({ dingtalk: { credentialDir: dir, clientId: 'cli_bot', robotCode: 'cli_bot' } })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const state = { get: () => undefined, set: () => {}, keys: () => [] }
    const message: OutboundMessage = { id: 'm1', kind: 'notice', text: 'Argo CD application demo Failed at revision r1',
      channel: { source: 'dingtalk', thread: 'dingtalk:cidG:cluster', address: { conversationId: 'cidG', senderNick: '' } } }
    await expect(sendDingtalk({ commands, deployment, state: state as never }, message)).resolves.toBe('sent')
    const send = calls.find(call => call.url.includes('groupMessages/send'))
    expect(send?.body).toMatchObject({ openConversationId: 'cidG', robotCode: 'cli_bot' })
    expect((send?.body.msgParam as string)).not.toContain('@')
    // A direct chat still needs the person it belongs to.
    const direct: OutboundMessage = { ...message, id: 'm2', channel: { source: 'dingtalk', thread: 'x', address: { direct: '1', senderStaffId: '', conversationId: '' } } }
    await expect(sendDingtalk({ commands, deployment, state: state as never }, direct)).rejects.toThrow('Missing DingTalk reply target')
  })
})
