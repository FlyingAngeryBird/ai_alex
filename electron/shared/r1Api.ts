import type { ActionReceipt, Item, R1Items, Reminder } from '../main/r1/items.js'
import type { CredentialPatch, CredentialStatus } from '../main/r1/credentials.js'
import type { ReminderDueEvent } from '../main/r1/reminderScheduler.js'
import type { SearchResult } from '../main/providers/braveSearchProvider.js'
import type { R1Persona, R1PersonaStore } from '../main/r1/persona.js'
import type { R1Memory, R1MemoryPage, R1MemorySource, R1MemoryStore } from '../main/r1/memory.js'
import type { HistoryPage, R1Conversations, SessionMessage } from '../main/r1/conversations.js'
import type { FocusCommand, FocusEvent, FocusState, R1Focus } from '../main/r1/focus.js'
import type { R1ServiceDiagnostics, ServiceCheckReport } from '../main/r1/serviceDiagnostics.js'
import type { R1Task, TaskEvent } from '../main/r1/taskSupervisor.js'
import type { Artifact, R1Artifacts } from '../main/r1/artifacts.js'
import type { AutomaticMemoryState } from '../main/r1/automaticMemory.js'
import type { MemoryPolicy } from '../main/r1/memoryPolicy.js'
import type { ConfirmedMemory, MemoryConfirmation } from '../main/r1/memoryConfirmations.js'

export type R1Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

type MethodInput<K extends keyof R1Items> = R1Items[K] extends (input: infer I) => unknown ? I : never
type MethodOutput<K extends keyof R1Items> = R1Items[K] extends (...args: never[]) => infer O ? O : never

export type R1Api = {
  tasks: {
    selectCandidate(input: { taskId: string; expectedGoalVersion: number; candidateId: string }): Promise<R1Result<{ type: 'candidate'; id: string; version: number }>>
    saveCandidate(input: { taskId: string; expectedGoalVersion: number; candidateId: string; title: string; temporarySaveConfirmed?: boolean }): Promise<R1Result<{ itemId: string; title: string; version: number }>>
    openSource(input: { taskId: string; sourceRef: string }): Promise<R1Result<null>>
    list(): Promise<R1Result<R1Task[]>>
    get(taskId: string): Promise<R1Result<R1Task>>
    pause(input: { taskId: string; expectedGoalVersion: number }): Promise<R1Result<R1Task>>
    resume(input: { taskId: string; expectedGoalVersion: number }): Promise<R1Result<R1Task>>
    cancel(input: { taskId: string; expectedGoalVersion: number }): Promise<R1Result<R1Task>>
    onChanged(handler: (event: TaskEvent) => void): () => void
  }
  artifacts: {
    export(input: { artifactId: string; expectedVersion: number; format: 'txt' | 'md' }): Promise<R1Result<{ cancelled: true } | { cancelled: false; artifactId: string; version: number; path: string }>>
    get(input: { artifactId: string; version?: number }): Promise<R1Result<Artifact>>
    revise(input: Omit<Parameters<R1Artifacts['revise']>[0], 'temporaryOwner'>): Promise<R1Result<Artifact>>
    undo(input: Omit<Parameters<R1Artifacts['undo']>[0], 'temporaryOwner'>): Promise<R1Result<Artifact>>
    save(input: Omit<Parameters<R1Artifacts['save']>[0], 'temporaryOwner'>): Promise<R1Result<ReturnType<R1Artifacts['save']>>>
  }
  persona: {
    get(): Promise<R1Result<R1Persona>>
    update(input: Parameters<R1PersonaStore['update']>[0]): Promise<R1Result<R1Persona>>
  }
  memory: {
    policy(): Promise<R1Result<MemoryPolicy & AutomaticMemoryState>>
    setPolicy(input: { enabled: boolean; expectedVersion: number }): Promise<R1Result<MemoryPolicy & AutomaticMemoryState>>
    onPolicyChanged(handler: (value: MemoryPolicy & AutomaticMemoryState) => void): () => void
    onChanged(handler: () => void): () => void
    prepareSelection(input: { confirmationId: string; content: string; category: R1Memory['category'] }): Promise<R1Result<MemoryConfirmation>>
    confirmSave(confirmationId: string): Promise<R1Result<ConfirmedMemory>>
    cancelSave(confirmationId: string): Promise<R1Result<null>>
    onConfirmation(handler: (value: MemoryConfirmation | null) => void): () => void
    list(input?: Parameters<R1MemoryStore['list']>[0]): Promise<R1Result<R1MemoryPage>>
    addManual(input: Parameters<R1MemoryStore['addManual']>[0]): Promise<R1Result<R1Memory>>
    update(input: Parameters<R1MemoryStore['update']>[0]): Promise<R1Result<R1Memory>>
    sources(memoryId: string): Promise<R1Result<R1MemorySource[]>>
    forget(memoryId: string, expectedVersion: number): Promise<R1Result<{ memoryId: string; deletionEpoch: number }>>
    onInvalidated(handler: (event: { deletionEpoch: number }) => void): () => void
  }
  history: {
    list(input?: Parameters<R1Conversations['history']>[0]): Promise<R1Result<HistoryPage>>
    messages(sessionId: string): Promise<R1Result<SessionMessage[]>>
  }
  focus: {
    reportMusicSelection(input: { trackKey: string | null }): Promise<R1Result<null>>
    getState(): Promise<R1Result<FocusState | null>>
    start(input: Parameters<R1Focus['start']>[0]): Promise<R1Result<ReturnType<R1Focus['start']>>>
    pause(input: FocusCommand): Promise<R1Result<ReturnType<R1Focus['pause']>>>
    resume(input: FocusCommand): Promise<R1Result<ReturnType<R1Focus['resume']>>>
    stop(input: FocusCommand): Promise<R1Result<ReturnType<R1Focus['stop']>>>
    onChanged(handler: (event: FocusEvent) => void): () => void
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
  services: {
    check(input: Parameters<R1ServiceDiagnostics['check']>[1]): Promise<R1Result<ServiceCheckReport>>
    cancel(requestId: string): Promise<R1Result<null>>
  }
  search: {
    web(query: string): Promise<R1Result<SearchResult>>
    open(candidateId: string): Promise<R1Result<{ candidateId: string }>>
  }
}

export type { Item, Reminder, ActionReceipt }
