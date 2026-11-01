/** Read-only GitLab issue, merge request, and discussion inspection for assessments. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { Description, DiscussionSchema, discussionNotes, isBotAuthor, noteUrl, type GitlabDiscussion, type GitlabNote } from './gitlab-trigger.ts'

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
/**
 * Reads the description alone (`root`), the first comment of the Trigger's discussion (`parent`), or one page of the whole
 * Thread (`thread`, whose first page opens with the description).
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
/** Context reader for a GitLab Trigger: its Thread is an Issue's or merge request's discussions, flattened into time order. */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    const target = trigger.meta.target === 'mr' ? 'mr' : 'issue'
    const iid = Number(trigger.meta.iid)
    const noteId = typeof trigger.meta.noteId === 'number' ? trigger.meta.noteId : undefined
    // The base of the Trigger's own web address names every message of its Thread, so page 2 keeps the ids page 1 used.
    const base = trigger.url?.split('#')[0] ?? `gitlab:${target}:${iid}`
    const read = await readPart(commands, target, iid, part, cursor, noteId, base)
    return { messages: read.messages, ...read.next ? { next: read.next } : {}, body: { messages: read.messages } }
  },
}
