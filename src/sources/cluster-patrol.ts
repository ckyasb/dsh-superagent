/** The daily patrol: finished Jobs of the `dsh-patrol` CronJob whose logs hold an ALERT report or a failure, as cluster Triggers. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { clusterChannel, SOURCE } from './cluster-argocd.ts'

/** One patrol Job as `kubectl get jobs` prints it, read-only and lenient. */
export const PatrolJobSchema = z.looseObject({
  metadata: z.looseObject({ name: z.string(), creationTimestamp: z.string().nullish(),
    ownerReferences: z.array(z.looseObject({ kind: z.string().nullish(), name: z.string().nullish() })).nullish() }),
  status: z.looseObject({ succeeded: z.number().nullish(), failed: z.number().nullish(), completionTime: z.string().nullish() }).nullish(),
})
export type PatrolJob = z.infer<typeof PatrolJobSchema>
/** True for the CronJob's own Jobs and for the ones `kubectl create job --from=cronjob/…` starts (named `<cronJob>-…`). */
export function patrolOfCronJob(job: PatrolJob, cronJob: string): boolean {
  const owners = job.metadata.ownerReferences ?? []
  if (owners.some(owner => owner.kind === 'CronJob' && owner.name === cronJob)) return true
  return job.metadata.name.startsWith(`${cronJob}-`)
}
/** True once the Job ended, with at least one pod succeeded or failed. */
export const patrolFinished = (job: PatrolJob): boolean => (job.status?.succeeded ?? 0) >= 1 || (job.status?.failed ?? 0) >= 1
/** When the Job ended: its completion time, or its creation time when Kubernetes recorded none. */
export const patrolEndedAt = (job: PatrolJob): number =>
  Date.parse(job.status?.completionTime ?? job.metadata.creationTimestamp ?? '')
/** A Job end time as a Beijing (UTC+8) calendar date, which names the patrol's Thread. */
export const patrolDate = (at: number): string => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10)
/** The Trigger of one patrol report; `text` is the report itself, cut to a size an assessment can still read. */
export function patrolTrigger(jobName: string, text: string, status: 'ALERT' | 'FAILED', endedAt: number, reportTo: string): Trigger {
  const at = new Date(Number.isFinite(endedAt) ? endedAt : Date.now()).toISOString()
  return {
    id: key('cluster-patrol', jobName), source: SOURCE,
    threads: [{ source: SOURCE, id: `patrol:${patrolDate(endedAt)}` }], actor: { source: SOURCE, id: '' }, human: false, at,
    text: text.slice(0, 20000),
    ...clusterChannel(reportTo) ? { channel: clusterChannel(reportTo)! } : {},
    meta: { kind: 'patrol', job: jobName, status },
  }
}
/**
 * Reads one Job's log: the report between `----- report (ALERT) -----` and the next line that is exactly `-----`,
 * or, when the patrol itself failed, the lines after its `patrol failed:` line. A clean `(OK)` log produces none.
 */
export function patrolReport(log: string): { status: 'ALERT' | 'FAILED'; text: string } | undefined {
  const lines = log.split('\n')
  const start = lines.findIndex(line => line.trim() === '----- report (ALERT) -----')
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && line === '-----')
    return { status: 'ALERT', text: lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim() }
  }
  const failed = lines.findIndex(line => line.includes('patrol failed:'))
  if (failed >= 0) return { status: 'FAILED', text: lines.slice(failed + 1).join('\n').trim() }
  return undefined
}
