import { topicContext, type R1Topics } from './topics.js'
import type { SessionMessage } from './conversations.js'
import { R1MemoryStore, type R1Memory } from './memory.js'

export const memoryToolAliases = ['memory_recall', 'memory_remember', 'memory_update', 'memory_forget'] as const
export const memoryView = ({ memoryId, content, category, version, sourceRefs }: R1Memory) => ({ memoryId, content, category, version, sourceRefs })
export type MemorySaveCandidate = { operation: 'remember' | 'update'; content: string; category: R1Memory['category'];
  validUntil: string | null; memoryId?: string; expectedVersion?: number }
export const isSensitiveMemory = (source: string, content: string): boolean =>
  /健康|病|诊断|药|疼|痛|发烧|发热|咳嗽|失眠|眩晕|晕厥|呕吐|腹泻|就诊|就医|住院|体检|过敏|怀孕|抑郁|焦虑症|手术|血压|血糖|财务|收入|薪资|工资|存款|负债|欠款|资产|银行卡|身份证|护照|密码|密钥|验证码|住址|手机号|电话|邮箱|性取向|宗教|政治|\b\d{11,}\b/.test(`${source}\n${content}`)

/** Authorization check after the model proposes a tool; it does not select or route actions.
 * Ambiguous/quoted instructions and sensitive writes require a separate confirmation flow. */
export class R1MemoryTools {
  private readonly known = new Map<string, R1Memory>()
  constructor(private readonly store: R1MemoryStore, private readonly source: SessionMessage, private readonly topics?: R1Topics) {}
  private authorize(action: 'remember' | 'update' | 'forget'): void {
    const text = this.source.body.trim()
    const prefix = /^(?:请(?:你)?(?:帮我)?|麻烦(?:你)?(?:帮我)?|帮我)?\s*/
    const command = text.replace(prefix, '')
    const allowed = action === 'remember' ? /^(?:记住|记一下|记下来)(?:[\s，,:：]|我|以后|下次|这|喜|正在)/ :
      action === 'update' ? /^(?:更正|纠正|更新|修改)(?:[\s，,:：]|我|记忆|这|一下|关于)/ : /^(?:忘记|遗忘|删除)(?:[\s，,:：]|我|这|记忆|关于)/
    if (!allowed.test(command) || /不要(?:再)?(?:记住|保存|修改|删除|忘记)|别(?:再)?(?:记住|保存|修改|删除|忘记)/.test(text)) throw new Error('MEMORY_EXPLICIT_AUTHORIZATION_REQUIRED')
  }
  private sensitive(content: string): void {
    if (isSensitiveMemory(this.source.body, content)) throw new Error('MEMORY_SENSITIVE_CONFIRMATION_REQUIRED')
  }
  private target(id: string, version: number): R1Memory {
    const known = this.known.get(id)
    if (!known) throw new Error('MEMORY_TARGET_NOT_OBSERVED')
    if (known.version !== version) throw new Error('VERSION_CONFLICT')
    return known
  }
  private expiry(expiry: string | null | undefined): void {
    if (expiry && !this.source.body.includes(expiry)) throw new Error('MEMORY_EXPIRY_CONFIRMATION_REQUIRED')
  }
  prepare(alias: 'memory_remember' | 'memory_update', args: Record<string, unknown>): MemorySaveCandidate {
    this.authorize(alias === 'memory_remember' ? 'remember' : 'update')
    this.expiry(args.validUntil as string | null)
    if (alias === 'memory_remember') {
      if ((args.sourceRefs as string[]).some(ref => ![this.source.messageId, this.source.turnId].includes(ref))) throw new Error('MEMORY_SOURCE_NOT_AVAILABLE')
      return { operation: 'remember', content: args.content as string, category: args.category as R1Memory['category'], validUntil: args.validUntil as string | null ?? null }
    }
    const current = this.target(args.memoryId as string, args.expectedVersion as number)
    return { operation: 'update', content: args.content as string, category: current.category, memoryId: current.memoryId,
      expectedVersion: current.version, validUntil: args.validUntil === undefined ? current.expiresAt : args.validUntil as string | null }
  }
  execute(alias: string, args: Record<string, unknown>): { data: Record<string, unknown>; entityId?: string; entityVersion?: number; invalidatedEpoch?: number } {
    if (alias === 'memory_recall') {
      const memories = this.store.recall(args.query as string, false, args.category as R1Memory['category'] | null ?? null)
      for (const memory of memories) this.known.set(memory.memoryId, memory)
      const topics = this.topics?.list({ query: args.query as string }).entries.slice(0, 5).map(topicContext) ?? []
      return { data: { matchStatus: memories.length || topics.length ? 'matched' : 'no_match', memories: memories.map(memoryView), ...(this.topics ? { topics } : {}) } }
    }
    if (alias === 'memory_remember') {
      this.authorize('remember'); this.sensitive(args.content as string); this.expiry(args.validUntil as string | null)
      const refs = args.sourceRefs as string[]
      if (refs.some(ref => ![this.source.messageId, this.source.turnId].includes(ref))) throw new Error('MEMORY_SOURCE_NOT_AVAILABLE')
      const previous = this.store.recall(args.content as string, false, args.category as R1Memory['category']).find(memory => memory.content === (args.content as string).trim())
      const memory = this.store.remember({ content: args.content as string, category: args.category as R1Memory['category'],
        sourceMessageIds: [this.source.messageId], expiresAt: args.validUntil as string | null ?? null })
      this.known.set(memory.memoryId, memory)
      return { entityId: memory.memoryId, entityVersion: memory.version, data: { memory: memoryView(memory), validUntil: memory.expiresAt, merged: Boolean(previous) } }
    }
    if (alias === 'memory_update') {
      this.authorize('update'); this.sensitive(args.content as string); this.expiry(args.validUntil as string | null)
      const current = this.target(args.memoryId as string, args.expectedVersion as number)
      const memory = this.store.update({ memoryId: current.memoryId, expectedVersion: current.version, content: args.content as string,
        category: current.category, sourceMessageIds: [this.source.messageId], expiresAt: args.validUntil as string | null | undefined })
      return { entityId: memory.memoryId, entityVersion: memory.version, invalidatedEpoch: memory.deletionEpoch,
        data: { memory: memoryView(memory), validUntil: memory.expiresAt, merged: false } }
    }
    this.authorize('forget')
    if (args.scope === 'all_memories') throw new Error('MEMORY_ALL_CONFIRMATION_REQUIRED')
    const current = this.target(args.memoryId as string, args.expectedVersion as number)
    const forgotten = this.store.forget(current.memoryId, current.version)
    return { entityId: current.memoryId, entityVersion: current.version + 1, invalidatedEpoch: forgotten.deletionEpoch,
      data: { scope: 'one', invalidatedMemoryIds: [current.memoryId], deletionEpoch: forgotten.deletionEpoch, propagationStatus: 'refreshing' } }
  }
}

/** Copy is based solely on a committed domain receipt, without reusing revoked model context. */
export function memoryMutationReply(receipt: Record<string, unknown>): string {
  if (receipt.status !== 'succeeded') throw new Error('MEMORY_RECEIPT_NOT_COMMITTED')
  return receipt.tool === 'memory.forget' ? '已忘记这条记忆，旧对话上下文已停止使用。' : '已更正这条记忆，旧对话上下文已停止使用。'
}
