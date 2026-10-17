import type { R1Items } from './items.js'

export const itemMutationAliases = ['notes_update', 'notes_complete'] as const
type Item = ReturnType<R1Items['toolView']>
/** An ID mentioned by the model is not an observed, versioned Item. */
export class R1ItemTools {
  private observed = new Map<string, Item>()
  constructor(private readonly items: R1Items, private readonly scope: {
    assertCurrent(): void; requirePersistence(): void
  }) {}
  observe(output: Record<string, unknown>): void {
    if (output.status !== 'succeeded') return
    const data = output.data as { item?: Item; items?: Item[] } | undefined
    for (const item of [...(data?.items ?? []), ...(data?.item ? [data.item] : [])]) {
      if (item.itemId && Number.isSafeInteger(item.version)) this.observed.set(item.itemId, structuredClone(item))
    }
  }
  execute(alias: string, args: Record<string, unknown>, actionId: string) {
    this.scope.assertCurrent(); this.scope.requirePersistence()
    const id = args.itemId as string, version = args.expectedVersion as number
    const seen = this.observed.get(id)
    if (!seen) throw new Error('ITEM_NOT_OBSERVED')
    if (seen.version !== version) throw new Error('VERSION_CONFLICT')
    // Also compare with SQLite: a page edit after the tool observation wins.
    const current = this.items.toolView(id)
    if (current.version !== version) throw new Error('VERSION_CONFLICT')
    if (alias === 'notes_update') {
      const patch = args.patch as { title?: string; content?: string }
      const saved = this.items.update({ actionId, itemId: id, expectedVersion: version, kind: current.type,
        title: patch.title ?? current.title, body: patch.content ?? current.content })
      return { entityId: id, entityVersion: saved.item.version, data: { item: this.items.toolView(id) } }
    }
    if (alias === 'notes_complete') {
      const saved = this.items.complete({ actionId, itemId: id, expectedVersion: version, completed: args.completed as boolean })
      return { entityId: id, entityVersion: saved.item.version,
        data: { item: this.items.toolView(id), reminderReceipts: saved.reminderReceipts } }
    }
    throw new Error('ITEM_TOOL_UNAVAILABLE')
  }
}
