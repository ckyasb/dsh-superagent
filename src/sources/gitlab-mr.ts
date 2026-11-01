/** Merge request binding, lifecycle observation, and terminal IM notification helpers, mirroring `github-pull.ts`. */
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { ticketBranch } from './branch.ts'
import type { SourceContext } from './host.ts'
import { MergeRequestSchema, SOURCE, threadId, threadKey, type GitlabMergeRequest } from './gitlab-trigger.ts'

export type MergeRequest = GitlabMergeRequest & { iid: number; source_branch: string }
export const readMergeRequest = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<MergeRequest> =>
  ({ ...await ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`), iid }) as MergeRequest
const mrNumber = (thread: string): number | undefined => {
  const iid = /^gitlab:mr:(\d+)$/.exec(thread)?.[1]
  return iid === undefined ? undefined : Number(iid)
}
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined =>
  mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** True when the MR was opened by the agent account from the configured project (not a fork). */
export const agentMergeRequest = (mr: { author: { id: number }; source_project_id?: number | null },
  deployment: Pick<Deployment, 'gitlab'>): boolean =>
  mr.author.id === deployment.gitlab!.userId && mr.source_project_id === deployment.gitlab!.projectId
/**
 * Validates and binds an open MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR on the ticket's branch, enforcing that one MR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the MR is bound or when the MR is not open (which is not an error).
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && source.meta.target === 'mr' && Number(source.meta.iid) === mr.iid
  const opened = agentMergeRequest(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const { login } = ctx.deployment.gitlab!
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadKey('mr', mr.iid))
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/**
 * Reconciles a polled MR's open/merged/closed state with any bound or branch-matching ticket.
 * An open agent MR auto-binds to the single open ticket on its branch unless that ticket already follows another open MR
 * (which only the Executor's report changes).
 * @returns whether the MR has ended.
 */
export async function observeMergeRequest(ctx: SourceContext, mr: MergeRequest): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed'
  if (ended) closeMergeRequest(ctx, mr)
  else {
    const candidates = agentMergeRequest(mr, ctx.deployment)
      ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // An MR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === threadKey('mr', mr.iid) && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(iid => iid === mr.iid))) claimMergeRequest(ctx, ticket.id, mr)
  }
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadId('mr', mr.iid) }, own)
    ctx.threads.patch(threadKey('mr', mr.iid), { target: 'mr', iid: mr.iid, url: mr.web_url, mrAuthor: mr.author.username })
  })
}
/**
 * Reports a merged or closed MR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the MR stays so a later human comment there resumes the ticket.
 */
function closeMergeRequest(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: threadId('mr', mr.iid) }, mr.state as 'merged' | 'closed', at)
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its MR (selecting the last-closed MR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function mergeRequestEndNotices(ticket: Ticket, request: string, webUrl: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const iid = mrNumber(follow.thread)!
  const url = `${webUrl.replace(/\/$/, '')}/-/merge_requests/${iid}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  // GitLab timelines and linked issues already show the merge or closure, so GitLab channels are skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
