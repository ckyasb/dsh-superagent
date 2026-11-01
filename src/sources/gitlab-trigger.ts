/** Normalizes GitLab issues, merge requests, and discussion notes into domain Triggers. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'
import type { GitlabAccount } from '../deployment.ts'

export const SOURCE = 'gitlab'
/** Issue and merge-request numbers are two independent sequences in GitLab, so a Thread names which kind its `iid` counts. */
export const threadId = (target: 'issue' | 'mr', iid: number): string => `${target}:${iid}`
export const threadKey = (target: 'issue' | 'mr', iid: number): string => `${SOURCE}:${threadId(target, iid)}`
/** GitLab reply address: an Issue's or merge request's conversation, or one discussion (thread) of it. */
export const gitlabChannel = (target: 'issue' | 'mr', iid: number, url?: string, discussionId?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(target, iid),
    address: { target, iid: String(iid), ...(discussionId ? { discussionId } : {}), ...(url ? { url } : {}) } })
/** A GitLab user; `bot` marks a user account GitLab itself created for a bot. */
export const UserSchema = z.looseObject({ id: z.number(), username: z.string(), name: z.string().nullish(), bot: z.boolean().nullish() })
export type GitlabUser = z.infer<typeof UserSchema>
/** One comment of a discussion; a diff comment carries the file and line it was left on. */
export const NoteSchema = z.looseObject({ id: z.number(), type: z.string().nullish(), body: z.string().nullish(), author: UserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), system: z.boolean(),
  position: z.looseObject({ new_path: z.string().nullish(), new_line: z.number().nullish(), old_path: z.string().nullish(),
    old_line: z.number().nullish() }).nullish() })
export type GitlabNote = z.infer<typeof NoteSchema>
/** One discussion of an Issue or merge request; `individual_note` is false exactly when replies to it stay in the discussion. */
export const DiscussionSchema = z.looseObject({ id: z.string(), individual_note: z.boolean().nullish(), notes: z.array(NoteSchema) })
export type GitlabDiscussion = z.infer<typeof DiscussionSchema>
/** An Issue as the `issues` list prints it. */
export const IssueSchema = z.looseObject({ iid: z.number(), title: z.string(), description: z.string().nullish(),
  state: z.string(), author: UserSchema, created_at: z.string(), updated_at: z.string(), web_url: z.string() })
export type GitlabIssue = z.infer<typeof IssueSchema>
/** A merge request as the `merge_requests` list prints it. */
export const MergeRequestSchema = IssueSchema.extend({ draft: z.boolean().nullish(), source_branch: z.string().nullish(),
  target_branch: z.string().nullish(), source_project_id: z.number().nullish(), merged_at: z.string().nullish(),
  closed_at: z.string().nullish(), sha: z.string().nullish() })
export type GitlabMergeRequest = z.infer<typeof MergeRequestSchema>
/** The body of the description part of an Issue or merge request, as both APIs return it. */
export const Description = z.looseObject({ title: z.string(), description: z.string().nullish(), author: z.looseObject({ username: z.string() }),
  created_at: z.string(), web_url: z.string() })
/** The non-system notes of one discussion, oldest first; system notes (label and description changes) never become Triggers. */
export const discussionNotes = (discussion: GitlabDiscussion): GitlabNote[] => discussion.notes.filter(note => !note.system)
/** True when a reply can join this discussion (GitLab sets `individual_note` on a single-note discussion that takes none). */
export const isThreaded = (discussion: GitlabDiscussion): boolean => discussion.individual_note !== true
/** True when GitLab reports the account as a regular user rather than a bot or a project/group access bot account. */
export const isBotAuthor = (author: GitlabUser): boolean =>
  author.bot === true || /^(project|group)_\d+_bot(_[0-9a-f]+)?$/.test(author.username)
/** True when the note, Issue, or merge request was written by the agent account itself; its own content produces no Trigger. */
export const isSelf = (author: GitlabUser, agent: GitlabAccount): boolean =>
  author.id === agent.userId || author.username === agent.login
export const isHumanAuthor = (author: GitlabUser, agent: GitlabAccount): boolean => !isBotAuthor(author) && !isSelf(author, agent)
/** True when the text mentions `@username`, case-insensitively, not followed or preceded by a character a GitLab username may contain. */
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9._@-])@${escapeRegExp(username)}(?![a-zA-Z0-9._-])`, 'i').test(text)
/** The web address of one note, which GitLab anchors as `#note_<id>`. */
export const noteUrl = (webUrl: string, note: GitlabNote): string => `${webUrl}#note_${note.id}`
/** The first twelve hex digits of the body's SHA-256, so an edited comment makes a new Trigger while a resolved discussion does not. */
export const bodyVersion = (body: string): string => createHash('sha256').update(body).digest('hex').slice(0, 12)
/** Builds the trigger for a comment; the note's `updated_at` changes the `at` only when the comment was edited. */
export function noteTrigger(note: GitlabNote, ref: { target: 'issue' | 'mr'; iid: number; url?: string; mrAuthor?: string },
  discussionId: string | undefined, agent: GitlabAccount): Trigger {
  const body = note.body ?? ''
  const url = ref.url ? noteUrl(ref.url, note) : undefined
  const line = note.position?.new_line ?? note.position?.old_line
  return { id: key('gitlab-note', String(note.id), bodyVersion(body)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId(ref.target, ref.iid) }],
    actor: { source: SOURCE, id: note.author.username }, human: isHumanAuthor(note.author, agent), at: note.updated_at ?? note.created_at,
    text: body, ...(mentions(body, agent.login) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.target, ref.iid, url, discussionId), url,
    meta: { target: ref.target, iid: ref.iid, kind: 'note', noteId: note.id, ...(discussionId ? { discussionId } : {}),
      ...(note.type ? { noteType: note.type } : {}),
      ...note.position?.new_path ? { path: note.position.new_path, ...(line != null ? { line } : {}) } : {},
      ...ref.mrAuthor ? { mrAuthor: ref.mrAuthor } : {} } }
}
/** Builds the trigger for a newly opened Issue's title and description. */
export function issueTrigger(issue: GitlabIssue, agent: GitlabAccount): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId('issue', issue.iid) }],
    actor: { source: SOURCE, id: issue.author.username }, human: isHumanAuthor(issue.author, agent), at: issue.created_at,
    text: `${issue.title}\n\n${body}`, ...(mentions(body, agent.login) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel('issue', issue.iid, issue.web_url), url: issue.web_url,
    meta: { target: 'issue', iid: issue.iid, kind: 'issue' } }
}
/** Builds the trigger for a newly opened merge request's title and description. */
export function mergeRequestTrigger(mr: GitlabMergeRequest, agent: GitlabAccount): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid)), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId('mr', mr.iid) }],
    actor: { source: SOURCE, id: mr.author.username }, human: isHumanAuthor(mr.author, agent), at: mr.created_at,
    text: `${mr.title}\n\n${body}`, ...(mentions(body, agent.login) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel('mr', mr.iid, mr.web_url), url: mr.web_url,
    meta: { target: 'mr', iid: mr.iid, kind: 'mr', mrAuthor: mr.author.username } }
}
