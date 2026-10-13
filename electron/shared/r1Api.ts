import type { ActionReceipt, Item, R1Items, Reminder } from '../main/r1/items.js'
import type { CredentialPatch, CredentialStatus } from '../main/r1/credentials.js'
import type { ReminderDueEvent } from '../main/r1/reminderScheduler.js'
import type { SearchResult } from '../main/providers/braveSearchProvider.js'
import type { R1Persona, R1PersonaStore } from '../main/r1/persona.js'
import type { R1Memory, R1MemoryPage, R1MemorySource, R1MemoryStore } from '../main/r1/memory.js'

export type R1Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

type MethodInput<K extends keyof R1Items> = R1Items[K] extends (input: infer I) => unknown ? I : never
type MethodOutput<K extends keyof R1Items> = R1Items[K] extends (...args: never[]) => infer O ? O : never

export type R1Api = {
  persona: {
    get(): Promise<R1Result<R1Persona>>
    update(input: Parameters<R1PersonaStore['update']>[0]): Promise<R1Result<R1Persona>>
  }
  memory: {
    list(input?: Parameters<R1MemoryStore['list']>[0]): Promise<R1Result<R1MemoryPage>>
    addManual(input: Parameters<R1MemoryStore['addManual']>[0]): Promise<R1Result<R1Memory>>
    update(input: Parameters<R1MemoryStore['update']>[0]): Promise<R1Result<R1Memory>>
    sources(memoryId: string): Promise<R1Result<R1MemorySource[]>>
    forget(memoryId: string, expectedVersion: number): Promise<R1Result<{ memoryId: string; deletionEpoch: number }>>
  }
  items: {
    list(): Promise<R1Result<Item[]>>
    create(input: MethodInput<'create'>): Promise<R1Result<MethodOutput<'create'>>>
    update(input: MethodInput<'update'>): Promise<R1Result<MethodOutput<'update'>>>
    complete(input: MethodInput<'complete'>): Promise<R1Result<MethodOutput<'complete'>>>
    deletionPreview(itemId: string): Promise<R1Result<MethodOutput<'deletionPreview'>>>
    delete(input: MethodInput<'delete'>): Promise<R1Result<MethodOutput<'delete'>>>
  }
  reminders: {
    list(): Promise<R1Result<Reminder[]>>
    create(input: MethodInput<'createReminder'>): Promise<R1Result<MethodOutput<'createReminder'>>>
    reschedule(input: MethodInput<'reschedule'>): Promise<R1Result<MethodOutput<'reschedule'>>>
    cancel(input: MethodInput<'cancelReminder'>): Promise<R1Result<MethodOutput<'cancelReminder'>>>
    onDue(handler: (event: ReminderDueEvent) => void): () => void
  }
  credentials: {
    status(): Promise<R1Result<CredentialStatus>>
    save(patch: CredentialPatch): Promise<R1Result<CredentialStatus>>
  }
  search: {
    web(query: string): Promise<R1Result<SearchResult>>
    open(candidateId: string): Promise<R1Result<{ candidateId: string }>>
  }
}

export type { Item, Reminder, ActionReceipt }
