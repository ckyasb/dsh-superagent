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
/** A commit as `repository/commits/<sha>` and `repository/compare` return it. */
export const CommitSchema = z.looseObject({ id: z.string(), short_id: z.string(), title: z.string(), message: z.string().nullish(),
  author_name: z.string().nullish(), created_at: z.string().nullish(), web_url: z.string().nullish(), parent_ids: z.array(z.string()).nullish() })
export type GitlabCommit = z.infer<typeof CommitSchema>
/** A file change as the diffs of a merge request, a commit, or a comparison return it. */
export const DiffSchema = z.looseObject({ old_path: z.string(), new_path: z.string(), diff: z.string().nullish(), new_file: z.boolean().nullish(),
  deleted_file: z.boolean().nullish(), renamed_file: z.boolean().nullish() })
export type GitlabDiff = z.infer<typeof DiffSchema>
/** A comparison of two commits: its commits and their combined diff. */
export const CompareSchema = z.looseObject({ commits: z.array(CommitSchema).nullish(), diffs: z.array(DiffSchema).nullish() })
export type GitlabCompare = z.infer<typeof CompareSchema>
/** A comment on a single commit; a commit comment carries no id, so its position in the list stands in for one. */
export const CommitCommentSchema = z.looseObject({ note: z.string().nullish(), author: UserSchema.nullish(), created_at: z.string().nullish() })
export type GitlabCommitComment = z.infer<typeof CommitCommentSchema>
/** The push payload of a project event. */
export const PushDataSchema = z.looseObject({ commit_count: z.number().nullish(), action: z.string().nullish(), ref_type: z.string().nullish(),
  commit_from: z.string().nullish(), commit_to: z.string().nullish(), ref: z.string().nullish(), commit_title: z.string().nullish() })
export type GitlabPushData = z.infer<typeof PushDataSchema>
/** A project event as `events?action=pushed` returns it. */
export const EventSchema = z.looseObject({ id: z.number(), action_name: z.string().nullish(), author: UserSchema.nullish(),
  author_username: z.string().nullish(), created_at: z.string(), push_data: PushDataSchema.nullish() })
export type GitlabEvent = z.infer<typeof EventSchema>
/** The Thread key of one commit, and the ref a commit Thread binds with. */
export const commitThreadKey = (sha: string): string => `${SOURCE}:commit:${sha}`
/** True when a commit `from` is absent or GitLab's all-zero "no parent" value. */
export const noCommit = (sha: string | null | undefined): boolean => !sha || /^0{40}$/.test(sha) || /^0+$/.test(sha)
/**
 * Builds the trigger for a push to the default branch; `commits` lists the pushed commits in order (one entry for a new
 * branch's single commit). Pushes have no person to mention, so they carry no `addressed`.
 */
export function pushTrigger(event: GitlabEvent, agent: GitlabAccount, commits: Pick<GitlabCommit, 'short_id' | 'title'>[],
  webUrl: string): Trigger {
  const push = event.push_data ?? {}
  const sha = push.commit_to ?? ''
  const before = push.commit_from ?? null
  const from = noCommit(before) ? undefined : before!
  const url = from ? `${webUrl.replace(/\/$/, '')}/-/compare/${from}...${sha}` : `${webUrl.replace(/\/$/, '')}/-/commit/${sha}`
  const lines = commits.slice(0, 20).map(commit => `${commit.short_id} ${commit.title}`)
  if (commits.length > 20) lines.push(`… and ${commits.length - 20} more`)
  const author: GitlabUser = event.author ?? { id: 0, username: event.author_username ?? '' }
  return { id: key('gitlab-push', String(event.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: `commit:${sha}` }], actor: { source: SOURCE, id: author.username },
    human: isHumanAuthor(author, agent), at: event.created_at,
    text: `${author.username} pushed ${push.commit_count ?? commits.length} commit(s) to ${push.ref ?? ''}\n${lines.join('\n')}`,
    channel: { source: SOURCE, thread: commitThreadKey(sha), address: { target: 'commit', sha, url } }, url,
    meta: { target: 'commit', kind: 'push', sha, before, ref: push.ref, count: push.commit_count } }
}
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
