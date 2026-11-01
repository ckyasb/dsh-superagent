/** DingTalk source kind definition and Cordis plugin entry: @ mentions in configured groups become Triggers, replies go back to the group. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { DingtalkBotSchema } from '../deployment.ts'
import { dingtalkLink, sendDingtalk } from './dingtalk-channel.ts'
import { dingtalkTrigger, SOURCE } from './dingtalk-trigger.ts'
import { defaultClientFactory, runDingtalk } from './dingtalk-stream.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind, ThreadContext } from './kind.ts'

export { SOURCE, dingtalkTrigger, dingtalkTriggerId, dingtalkThreadId } from './dingtalk-trigger.ts'
export type { DingtalkMessage } from './dingtalk-trigger.ts'
export { sendDingtalk, dingtalkLink } from './dingtalk-channel.ts'
export { runDingtalk, defaultClientFactory } from './dingtalk-stream.ts'

export const DingtalkConfigSchema = DingtalkBotSchema.extend({
  chats: z.array(z.object({ conversationId: z.string().min(1), name: z.string().default(''), listen: z.enum(['mentions']).default('mentions') }).strict())
    .refine(chats => new Set(chats.map(chat => chat.conversationId)).size === chats.length, 'Duplicate conversation IDs')
    .default([]),
  directMessages: z.boolean().default(false),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type DingtalkConfig = z.infer<typeof DingtalkConfigSchema>

/** DingTalk keeps no group history a bot can read, so a Trigger's context is the Trigger itself. */
export const dingtalkThreadContext: ThreadContext<DingtalkConfig> = {
  messageId: trigger => String(trigger.meta.msgId ?? ''),
  read: async (_commands, trigger) => {
    const message = { id: String(trigger.meta.msgId ?? ''), from: String(trigger.meta.senderNick ?? ''), at: trigger.at, text: trigger.text }
    return { messages: [message], status: 'no_history', body: { messages: [message] } }
  },
}

export const dingtalkKind: SourceKind<DingtalkConfig> = {
  kind: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '接收配置的钉钉群里 @ 机器人的消息和私聊，回复发回原群或原对话。钉钉不给机器人读群历史，也没有话题。', en: 'Receives @ mentions of the bot in the configured DingTalk groups and direct messages, and replies there. DingTalk gives a bot no message history or threads.' },
  schema: DingtalkConfigSchema,
  fields: [
    { key: 'credentialDir', type: 'text', label: { zh: '凭据目录', en: 'Credential directory' },
      hint: { zh: '绝对路径；目录里的 clientId、clientSecret 两个文件各存一个值（由 Kubernetes Secret 挂载）。保存后重新检查部署。', en: 'An absolute path; the two files clientId and clientSecret in it each hold one value, mounted from a Kubernetes Secret. Saving checks the deployment again.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Groups' },
      hint: { zh: '只接收这些群里 @ 机器人的消息；conversationId 是 cid 开头的 openConversationId。把群里所有人都能 @ 机器人发起请求，用策略准入表对应行的“未列出、@ 机器人”一格设为 explicit。', en: 'Receives only messages that mention the bot in these groups; the conversationId is the openConversationId starting with cid. To let everyone in a group request work by mentioning the bot, set that row\'s "not on the list, addressing the agent" admission cell to explicit.' },
      columns: [
        { key: 'conversationId', type: 'text', label: { zh: '群', en: 'Group' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other groups' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。', en: 'Groups the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
  ],
  health: [SOURCE],
  scope({ meta }, config) {
    if (meta.conversationType === '1') return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_off' }
    const chat = config.chats.find(item => item.conversationId === meta.conversationId)
    if (chat) return { listened: true, observed: false, row: chat.conversationId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_listed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      dingtalkKind.scope!({ meta: { conversationType: address.direct === '1' ? '1' : '2', conversationId: address.conversationId ?? '' } }, config).listened,
    send: sendDingtalk, link: dingtalkLink,
  },
  threadContext: dingtalkThreadContext,
  find: () => ({ threads: [], terms: [] }),
  policy: {
    unnamed: { person: { zh: '钉钉用户', en: 'DingTalk user' }, bot: { zh: '钉钉机器人', en: 'DingTalk bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate staff IDs').default([]),
      bots: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot ids').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的钉钉用户', en: 'DingTalk users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'senderStaffId', en: 'senderStaffId' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '钉钉不会把机器人的消息推给机器人；这里保留与其它来源一致的形状。', en: 'DingTalk pushes no bot message to a bot; this keeps the shape the other Sources use.' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'ID', en: 'ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的人在配置的群里 @ 机器人，或私聊机器人。', en: 'Someone on the list who @-mentions the bot in a configured group, or messages it directly, always makes an explicit request.' },
    rows(stored) {
      const config = DingtalkConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        // DingTalk pushes only @ mentions of the bot, so a configured group observes no unaddressed message.
        ...config.chats.map(chat => ({ id: chat.conversationId, label: chat.name || chat.conversationId, note: mentions,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other groups' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    // DingTalk offers no member API, so the list is not synced from a group.
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_CONVERSATION', description: { zh: '接下工单的钉钉群 conversationId；工单不是从钉钉来的时为空', en: 'conversationId of the DingTalk group that started the ticket; empty when the ticket did not start on DingTalk' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_SENDER', description: { zh: '发起请求的人的钉钉昵称；工单不是从钉钉来的时为空', en: 'The requester\'s DingTalk nickname; empty when the ticket did not start on DingTalk' } },
    ],
    values: ({ trigger }) => ({ DSH_SUPERAGENT_DINGTALK_CONVERSATION: trigger?.source === SOURCE ? String(trigger.meta.conversationId ?? '') : '',
      DSH_SUPERAGENT_DINGTALK_SENDER: trigger?.source === SOURCE ? String(trigger.meta.senderNick ?? '') : '' }),
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.dingtalk
    ? { clientId: { zh: `当前机器人 ${deployment.dingtalk.clientId}`, en: `Current bot ${deployment.dingtalk.clientId}` } } : {},
}

export const name = 'dsh-superagent-dingtalk'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, dingtalkKind)
    const controller = new AbortController()
    const running = runDingtalk(source, controller.signal, defaultClientFactory)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
