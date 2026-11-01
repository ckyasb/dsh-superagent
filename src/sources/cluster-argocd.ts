/** Argo CD applications: failed or unhealthy syncs as senderless cluster Triggers, and the Source id and reply channel they share. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'cluster'
/**
 * Replies to a cluster event go to the DingTalk group named by the Source's `reportTo`; without one the Trigger has no
 * channel, because a cluster event has no requester to answer in place.
 */
export const clusterChannel = (conversationId: string): ChannelRef | undefined => conversationId.trim()
  ? { source: 'dingtalk', thread: `dingtalk:${conversationId.trim()}:cluster`, address: { conversationId: conversationId.trim(), senderNick: '' } }
  : undefined
/** One Argo CD Application as `kubectl get applications.argoproj.io` prints it, read-only and lenient. */
export const ApplicationSchema = z.looseObject({
  metadata: z.looseObject({ name: z.string() }),
  status: z.looseObject({
    sync: z.looseObject({ status: z.string().nullish(), revision: z.string().nullish() }).nullish(),
    health: z.looseObject({ status: z.string().nullish() }).nullish(),
    operationState: z.looseObject({ phase: z.string().nullish(), message: z.string().nullish(),
      syncResult: z.looseObject({ revision: z.string().nullish() }).nullish() }).nullish(),
    conditions: z.array(z.looseObject({ type: z.string(), message: z.string().nullish() })).nullish(),
    resources: z.array(z.looseObject({ kind: z.string().nullish(), name: z.string().nullish(), namespace: z.string().nullish(),
      status: z.string().nullish(), health: z.looseObject({ status: z.string().nullish(), message: z.string().nullish() }).nullish() })).nullish(),
  }).nullish(),
})
export type Application = z.infer<typeof ApplicationSchema>
const FAILED_PHASES = ['Failed', 'Error']
const FAILED_HEALTH = ['Degraded', 'Missing']
/**
 * What makes an application failed: its last operation ended in `Failed` or `Error`, or its health is `Degraded` or
 * `Missing`. `Progressing` and `OutOfSync` are ordinary states of a sync under way and return no failure.
 */
export function argocdFailure(app: Application): string {
  const phase = app.status?.operationState?.phase ?? ''
  if (FAILED_PHASES.includes(phase)) return phase
  const health = app.status?.health?.status ?? ''
  return FAILED_HEALTH.includes(health) ? health : ''
}
/** The revision the application is at: the sync status's, or the last operation's sync result when the status has none. */
export const argocdRevision = (app: Application): string =>
  app.status?.sync?.revision ?? app.status?.operationState?.syncResult?.revision ?? ''
const resourceLine = (resource: NonNullable<NonNullable<Application['status']>['resources']>[number]): string => {
  const where = [resource.kind ?? '', resource.namespace ?? '', resource.name ?? ''].filter(Boolean).join('/')
  const state = [resource.status ?? '', resource.health?.status ?? ''].filter(Boolean).join(', ')
  return `${where}: ${state}${resource.health?.message ? ` — ${resource.health.message}` : ''}`
}
/**
 * The Trigger of one application that newly failed, or whose failure moved to another revision. `revision` counts the
 * failures reported for the application so each Trigger has its own ID.
 */
export function argocdTrigger(app: Application, revision: number, reportTo: string): Trigger {
  const name = app.metadata.name
  const failure = argocdFailure(app)
  const at = argocdRevision(app)
  const phase = app.status?.operationState?.phase ?? ''
  const health = app.status?.health?.status ?? ''
  const sync = app.status?.sync?.status ?? ''
  const resources = (app.status?.resources ?? []).filter(resource =>
    (resource.health?.status ?? '') !== 'Healthy' || (resource.status ?? '') !== 'Synced').slice(0, 15)
  const text = [`Argo CD application ${name} ${failure} at revision ${at}`, (app.status?.operationState?.message ?? '').slice(0, 500),
    ...(app.status?.conditions ?? []).map(condition => `${condition.type}: ${condition.message ?? ''}`),
    ...resources.map(resourceLine)].filter(line => line).join('\n')
  return {
    id: key('cluster-argocd', name, String(revision)), source: SOURCE,
    threads: [{ source: SOURCE, id: `argocd:${name}` }], actor: { source: SOURCE, id: '' }, human: false, at: new Date().toISOString(),
    text, ...(clusterChannel(reportTo) ? { channel: clusterChannel(reportTo)! } : {}),
    meta: { kind: 'argocd', app: name, revision: at, failure, phase, health, sync },
  }
}
