/** Read-only GitLab issue, merge request, commit, and discussion inspection for assessments and workers. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { CommitCommentSchema, CommitSchema, CompareSchema, Description, DiffSchema, DiscussionSchema, IssueSchema, MergeRequestSchema,
  discussionNotes, isBotAuthor, noteUrl, type GitlabCommit, type GitlabCommitComment, type GitlabDiff, type GitlabDiscussion,
  type GitlabNote } from './gitlab-trigger.ts'

const PER_PAGE = 100
const resource = (target: 'issue' | 'mr', iid: number, suffix = ''): string =>
  `${target === 'issue' ? 'issues' : 'merge_requests'}/${iid}${suffix}`
/** Formats the description of an Issue or merge request as the first message of its Thread. */
const descriptionMessage = (item: z.infer<typeof Description>): ContextMessage =>
  ({ id: item.web_url, from: item.author.username, at: item.created_at, text: `${item.title}\n\n${item.description ?? ''}` })
/** Formats a comment as a model-facing message, marking bot and project/group bot accounts because their notes never authorize work. */
const noteMessage = (note: GitlabNote, base: string): ContextMessage => {
  const line = note.position?.new_line ?? note.position?.old_line
  return { id: noteUrl(base, note), from: note.author.username, at: note.created_at, text: note.body ?? '',
    ...isBotAuthor(note.author) ? { bot: true as const } : {},
    ...note.position?.new_path ? { path: note.position.new_path, ...(line != null ? { line } : {}) } : {} }
}
/** Formats a commit comment as a model-facing message; commit comments carry no id, so the position stands in for one. */
const commitCommentMessage = (comment: GitlabCommitComment, index: number, base: string): ContextMessage =>
  ({ id: `${base}#comment-${index + 1}`, from: comment.author?.username ?? '', at: comment.created_at ?? '', text: comment.note ?? '',
    ...isBotAuthor(comment.author ?? { id: 0, username: '' }) ? { bot: true as const } : {} })
const validDiscussions = (listed: unknown[]): GitlabDiscussion[] =>
  listed.flatMap(value => { const parsed = DiscussionSchema.safeParse(value); return parsed.success ? [parsed.data] : [] })
/** Reads one page of an Issue's or merge request's discussions, 100 discussions to a page. */
async function discussionPage(commands: Commands, target: 'issue' | 'mr', iid: number, page: number): Promise<GitlabDiscussion[]> {
  const listed = await commands.gitlabApi(z.array(z.unknown()),
    `${resource(target, iid, '/discussions')}?order_by=created_at&sort=asc&per_page=${PER_PAGE}&page=${page}`)
  return validDiscussions(listed)
}
/** Reads the pages of discussions up to the one that names the note; GitLab orders discussions by creation. */
async function discussionsOf(commands: Commands, target: 'issue' | 'mr', iid: number, noteId: number): Promise<GitlabDiscussion[]> {
  for (let page = 1; page <= 50; page += 1) {
    const discussions = await discussionPage(commands, target, iid, page)
    if (discussions.some(discussion => discussion.notes.some(note => note.id === noteId))) return discussions
    if (discussions.length < PER_PAGE) return []
  }
  return []
}
/** Reads every page of an Issue's or merge request's discussions. */
async function allDiscussions(commands: Commands, target: 'issue' | 'mr', iid: number): Promise<GitlabDiscussion[]> {
  const discussions: GitlabDiscussion[] = []
  for (let page = 1; page <= 50; page += 1) {
    const listed = await discussionPage(commands, target, iid, page)
    discussions.push(...listed)
    if (listed.length < PER_PAGE) return discussions
  }
  return discussions
}
/** Reads a commit and its comments, the commit itself as the first message of the Thread. */
async function commitMessages(commands: Commands, sha: string): Promise<ContextMessage[]> {
  const commit = await commands.gitlabApi(CommitSchema, `repository/commits/${encodeURIComponent(sha)}`)
  const base = commit.web_url ?? `gitlab:commit:${sha}`
  const comments = await commands.gitlabPages(CommitCommentSchema, `repository/commits/${encodeURIComponent(sha)}/comments`)
  return [{ id: base, from: commit.author_name ?? '', at: commit.created_at ?? '', text: `${commit.title}\n\n${commit.message ?? ''}` },
    ...comments.map((comment, index) => commitCommentMessage(comment, index, base))]
}
/**
 * Reads the description alone (`root`), the first comment of the Trigger's discussion (`parent`), or one page of the whole
 * Thread (`thread`, whose first page opens with the description). A commit Thread's root, parent, and every page are the
 * commit message followed by its comments.
 */
async function readPart(commands: Commands, target: 'issue' | 'mr', iid: number, part: string, cursor: string | undefined,
  noteId: number | undefined, base: string): Promise<{ messages: ContextMessage[]; next?: string }> {
  if (part === 'root') {
    const item = await commands.gitlabApi(Description, resource(target, iid))
    return { messages: [descriptionMessage(item)] }
  }
  if (part === 'parent') {
    const discussions = await discussionsOf(commands, target, iid, noteId ?? 0)
    const discussion = discussions.find(item => item.notes.some(note => note.id === noteId))
    const [first] = discussion ? discussionNotes(discussion) : []
    return { messages: first ? [noteMessage(first, base)] : [] }
  }
  const page = Math.max(1, Number(cursor ?? '1') || 1)
  const discussions = await discussionPage(commands, target, iid, page)
  const messages: ContextMessage[] = []
  if (page === 1) {
    const item = await commands.gitlabApi(Description, resource(target, iid))
    messages.push(descriptionMessage(item))
  }
  for (const discussion of discussions) for (const note of discussionNotes(discussion)) messages.push(noteMessage(note, base))
  // A full page may have a next one; the reader asks for it only through this cursor.
  return { messages, ...discussions.length === PER_PAGE ? { next: String(page + 1) } : {} }
}
/** Context reader for a GitLab Trigger: an Issue's or merge request's discussions flattened into time order, or one commit's message and comments. */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    if (trigger.meta.target === 'commit' && typeof trigger.meta.sha === 'string') {
      const messages = await commitMessages(commands, trigger.meta.sha)
      return { messages, body: { messages } }
    }
    const target = trigger.meta.target === 'mr' ? 'mr' : 'issue'
    const iid = Number(trigger.meta.iid)
    const noteId = typeof trigger.meta.noteId === 'number' ? trigger.meta.noteId : undefined
    // The base of the Trigger's own web address names every message of its Thread, so page 2 keeps the ids page 1 used.
    const base = trigger.url?.split('#')[0] ?? `gitlab:${target}:${iid}`
    const read = await readPart(commands, target, iid, part, cursor, noteId, base)
    return { messages: read.messages, ...read.next ? { next: read.next } : {}, body: { messages: read.messages } }
  },
}

/** The conversation of an Issue or merge request: its description and every non-system comment, with discussion ids and diff positions. */
async function conversation(commands: Commands, target: 'issue' | 'mr', iid: number): Promise<unknown> {
  const item = target === 'mr'
    ? await commands.gitlabApi(MergeRequestSchema, resource(target, iid))
    : await commands.gitlabApi(IssueSchema, resource(target, iid))
  const discussions = await allDiscussions(commands, target, iid)
  const comments = discussions.flatMap(discussion => discussionNotes(discussion).map(note => {
    const line = note.position?.new_line ?? note.position?.old_line
    return { id: note.id, discussion_id: discussion.id, author: note.author.username, at: note.created_at, text: note.body ?? '',
      ...note.position?.new_path ? { path: note.position.new_path, ...(line != null ? { line } : {}) } : {} }
  }))
  return { iid, title: item.title, state: item.state,
    ...target === 'mr' ? { source_branch: (item as z.infer<typeof MergeRequestSchema>).source_branch,
      target_branch: (item as z.infer<typeof MergeRequestSchema>).target_branch,
      draft: (item as z.infer<typeof MergeRequestSchema>).draft } : {},
    author: item.author.username, created_at: item.created_at, web_url: item.web_url, description: item.description ?? '', comments }
}
/** Reads the diffs of a merge request, a commit, or a comparison as plain file changes. */
async function diffs(commands: Commands, path: string): Promise<unknown> {
  const listed = await commands.gitlabApi(z.array(z.unknown()), path)
  return listed.flatMap(value => { const parsed = DiffSchema.safeParse(value); return parsed.success ? [plainDiff(parsed.data)] : [] })
}
const plainDiff = (diff: GitlabDiff) => ({ old_path: diff.old_path, new_path: diff.new_path, diff: diff.diff ?? '',
  new_file: diff.new_file === true, deleted_file: diff.deleted_file === true, renamed_file: diff.renamed_file === true })
/**
 * Reads an Issue or merge request with its comments, a merge request's diffs, a commit with its diff, or a comparison as
 * model-facing records rather than raw GitLab API responses.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const issue = /^gitlab\/issues\/([1-9]\d*)$/.exec(resource)
  if (issue) return conversation(commands, 'issue', Number(issue[1]))
  const mr = /^gitlab\/merge_requests\/([1-9]\d*)(?:\/(diffs))?$/.exec(resource)
  if (mr) {
    const iid = Number(mr[1])
    if (mr[2]) return { iid, diffs: await diffs(commands, `merge_requests/${iid}/diffs?per_page=100`) }
    return conversation(commands, 'mr', iid)
  }
  const commit = /^gitlab\/commits\/([0-9a-f]{7,40})$/.exec(resource)
  if (commit) {
    const sha = commit[1]!
    const item = await commands.gitlabApi(CommitSchema, `repository/commits/${sha}`)
    return { id: item.id, short_id: item.short_id, title: item.title, message: item.message ?? '', author: item.author_name ?? '',
      created_at: item.created_at ?? '', web_url: item.web_url ?? '', parents: item.parent_ids ?? [],
      diffs: await diffs(commands, `repository/commits/${sha}/diff`) }
  }
  const compare = /^gitlab\/compare\/([0-9a-f]{7,40})\.\.\.([0-9a-f]{7,40})$/.exec(resource)
  if (compare) {
    const body = await commands.gitlabApi(CompareSchema, `repository/compare?from=${compare[1]}&to=${compare[2]}`)
    return { commits: (body.commits ?? []).map(item => ({ id: item.id, short_id: item.short_id, title: item.title,
      author: item.author_name ?? '', created_at: item.created_at ?? '' })), diffs: (body.diffs ?? []).map(plainDiff) }
  }
  throw new Error('Use gitlab/issues/<iid>, gitlab/merge_requests/<iid>[/diffs], gitlab/commits/<sha>, or gitlab/compare/<from>...<to>')
}
/** Reads a non-hidden file or directory listing from the repository's default branch via the GitLab API; hidden entries and `node_modules` are rejected. */
export async function readGitlabRepositoryPath(commands: Commands, gitlab: { defaultBranch: string }, path: string,
  kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const ref = encodeURIComponent(gitlab.defaultBranch)
  if (kind === 'file') {
    return commands.gitlabApi(`repository/files/${parts.map(encodeURIComponent).join('%2F')}/raw?ref=${ref}`)
  }
  const entries = await commands.gitlabApi(z.array(z.looseObject({ name: z.string(), type: z.string() })),
    `repository/tree?path=${encodeURIComponent(parts.join('/'))}&ref=${ref}`)
  return entries.map(entry => entry.type === 'tree' ? `${entry.name}/` : entry.name)
    .filter(name => !name.split('/').at(-1)!.startsWith('.') && name !== 'node_modules').sort().join('\n')
}
