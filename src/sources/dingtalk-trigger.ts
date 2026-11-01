/** Normalizes DingTalk robot push messages into domain Triggers. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { DingtalkBot } from '../deployment.ts'

export const SOURCE = 'dingtalk'
/** One message as the Stream connection pushes it (`JSON.parse(res.data)`); only `text` messages become Triggers. */
export const MessageSchema = z.looseObject({
  msgId: z.string().min(1), msgtype: z.string(), text: z.looseObject({ content: z.string() }).optional(),
  conversationId: z.string(), conversationType: z.string(), conversationTitle: z.string().nullish(),
  senderStaffId: z.string(), senderNick: z.string().nullish(), isAdmin: z.boolean().nullish(),
  createAt: z.number().int().nonnegative(), robotCode: z.string().nullish(),
})
export type DingtalkMessage = z.infer<typeof MessageSchema>
/** A group Thread belongs to the sender in the group; a direct chat has one per person, so the sender alone names it. */
export const dingtalkThreadId = (message: Pick<DingtalkMessage, 'conversationId' | 'conversationType' | 'senderStaffId'>): string =>
  message.conversationType === '1' ? `direct:${message.senderStaffId}` : `${message.conversationId}:${message.senderStaffId}`
/** Deterministic Trigger ID for a DingTalk message; DingTalk redelivers the same `msgId` after a missed receipt. */
export const dingtalkTriggerId = (msgId: string): string => key('dingtalk', msgId)
/** Converts a pushed message into a Trigger; non-text messages produce none, and the bot's own messages are never pushed. */
export function dingtalkTrigger(input: unknown, bot: DingtalkBot): Trigger | undefined {
  void bot
  const message = MessageSchema.parse(input)
  if (message.msgtype !== 'text') return
  const direct = message.conversationType === '1'
  const thread = dingtalkThreadId(message)
  return {
    id: dingtalkTriggerId(message.msgId), source: SOURCE, threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: message.senderStaffId }, human: true,
    // Only messages that mention the bot reach the Source in a group, so every group message is addressed.
    addressed: direct ? 'direct' as const : 'mention' as const,
    at: new Date(message.createAt).toISOString(), text: (message.text?.content ?? '').trim(),
    channel: { source: SOURCE, thread: `dingtalk:${thread}`,
      address: { conversationId: message.conversationId, senderStaffId: message.senderStaffId,
        senderNick: message.senderNick ?? '', ...(direct ? { direct: '1' } : {}) } },
    meta: { conversationId: message.conversationId, conversationType: message.conversationType,
      title: message.conversationTitle ?? '', senderNick: message.senderNick ?? '', isAdmin: message.isAdmin ?? false,
      msgId: message.msgId },
  }
}
