/** GitLab outbound channel: posts issue/merge-request comments and discussion replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { DiscussionSchema, discussionNotes, type GitlabNote } from './gitlab-trigger.ts'

const SendNoteSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), author: z.looseObject({ id: z.number() }) })
/** True when the issue, merge request, or discussion was deleted; a missing one (404) never accepts replies again. */
const gone = (error: unknown): boolean => error instanceof CliError && error.code === 404
const resource = (target: 'issue' | 'mr', iid: number, suffix = ''): string =>
  `${target === 'issue' ? 'issues' : 'merge_requests'}/${iid}${suffix}`
/** Posts a comment or discussion reply with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source is not configured')
  const target = message.channel.address.target
  const iid = Number(message.channel.address.iid)
  if ((target !== 'issue' && target !== 'mr') || !iid) throw new Error('Missing GitLab reply target')
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const discussions = await commands.gitlabPages(DiscussionSchema, resource(target, iid, '/discussions'))
    // An agent comment carrying this message's marker means an earlier attempt reached GitLab; sending again would duplicate it.
    const mine = (note: GitlabNote) => note.author.id === gitlab.userId && (note.body ?? '').includes(marker)
    if (discussions.some(discussion => discussionNotes(discussion).some(mine))) return 'sent'
    const discussionId = message.channel.address.discussionId
    const path = discussionId
      ? resource(target, iid, `/discussions/${encodeURIComponent(discussionId)}/notes`)
      : resource(target, iid, '/notes')
    await commands.gitlabApi(z.unknown(), path, '-X', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const iid = address.iid ?? ''
  return { url: address.url ?? '',
    label: address.target === 'mr' ? { zh: `GitLab MR !${iid}`, en: `GitLab MR !${iid}` } : { zh: `GitLab Issue #${iid}`, en: `GitLab Issue #${iid}` } }
}
