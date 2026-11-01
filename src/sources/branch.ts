/** The shared branch rule both forges use to tell which ticket a branch the agent pushed belongs to. */
import type { Ticket } from '../core/index.ts'

/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
