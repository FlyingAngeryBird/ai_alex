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
import type { R1Topics, R1Topic, TopicSource } from '../main/r1/topics.js'
import type { TopicSummaryState } from '../main/r1/topicSummaries.js'
import type { AutomaticMemoryState } from '../main/r1/automaticMemory.js'
import type { MemoryPolicy } from '../main/r1/memoryPolicy.js'
import type { ConfirmedMemory, MemoryConfirmation } from '../main/r1/memoryConfirmations.js'
import type { MusicCommand, MusicReport, MusicSnapshot } from '../main/r1/music.js'
import type { MusicTrack, MusicSourcePreference } from '../main/music/gdstudioMusicProvider.js'
import type { AppPreferences, PreferencesPatch } from '../main/r1/preferences.js'
import type { R1DataManagement, FileAction, RestorePreview, CleanupPreview } from '../main/r1/dataManagement.js'
import type { CleanupSelection } from '../main/r1/dataCleanup.js'

export type R1Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

type MethodInput<K extends keyof R1Items> = R1Items[K] extends (input: infer I) => unknown ? I : never
type MethodOutput<K extends keyof R1Items> = R1Items[K] extends (...args: never[]) => infer O ? O : never

export type R1Api = {
  onboarding: {
    get(): Promise<R1Result<import('../main/r1/onboarding.js').OnboardingState>>
    complete(input: { skipped: boolean }): Promise<R1Result<import('../main/r1/onboarding.js').OnboardingState>>
  }
  data: {
    prepareCleanup(input: CleanupSelection): Promise<R1Result<CleanupPreview>>
    confirmCleanup(input: { ticket: string; confirmed: true }): Promise<R1Result<{ operationId: string; restartRequired: true }>>
    exportCleanupBackup(): Promise<R1Result<FileAction>>
    summary(): Promise<R1Result<ReturnType<R1DataManagement['summary']>>>
    exportBackup(): Promise<R1Result<FileAction>>
    prepareRestore(): Promise<R1Result<{ cancelled: true } | { cancelled: false; preview: RestorePreview }>>
    cancelRestore(): Promise<R1Result<null>>
    confirmRestore(input: { ticket: string; confirmed: true }): Promise<R1Result<{ operationId: string; restartRequired: true }>>
    exportDiagnostics(input: { voiceTrace: unknown }): Promise<R1Result<FileAction>>
  }
  preferences: {
    get(): Promise<R1Result<AppPreferences>>
    update(input: PreferencesPatch): Promise<R1Result<AppPreferences>>
    onChanged(handler: (value: AppPreferences) => void): () => void
  }
  music: {
    attach(): Promise<R1Result<{ nonce: string; snapshot: MusicSnapshot }>>
    detach(): Promise<R1Result<null>>
    snapshot(): Promise<R1Result<MusicSnapshot>>
    report(input: { nonce: string; report: MusicReport }): Promise<R1Result<null>>
    search(input: { keyword: string; sourcePreference?: MusicSourcePreference }): Promise<R1Result<MusicTrack[]>>
    clearHistory(): Promise<R1Result<null>>
    exit(input: { expectedVersion: number }): Promise<R1Result<Record<string, unknown>>>
    control(input: { alias: string; args: Record<string, unknown>; temporarySaveConfirmed?: boolean }): Promise<R1Result<Record<string, unknown>>>
    onCommand(handler: (command: MusicCommand) => void): () => void
    onChanged(handler: (snapshot: MusicSnapshot) => void): () => void
  }
  topics: {
    list(input?: { query?: string; page?: number }): Promise<R1Result<ReturnType<R1Topics['list']> & { preparation: TopicSummaryState }>>
    details(topicId: string): Promise<R1Result<{ topic: R1Topic; versions: Array<R1Topic & { origin: string }>; sources: TopicSource[]; related: ReturnType<R1Topics['related']> }>>
    update(input: Parameters<R1Topics['update']>[0]): Promise<R1Result<R1Topic>>
    forget(input: { topicId: string; expectedVersion: number }): Promise<R1Result<{ topicId: string; deletionEpoch: number }>>
    select(input: { topicId: string; expectedVersion: number }): Promise<R1Result<R1Topic>>
  }
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
    select(input: { artifactId: string; expectedVersion: number; selection: import('../main/r1/artifacts.js').ArtifactRange | null } | { artifactId: null; expectedVersion: null; selection: null }): Promise<R1Result<Artifact | null>>
    materials(artifactId: string): Promise<R1Result<import('../main/r1/conversations.js').SessionMessage[]>>
    onChanged(handler: (event: { artifactId: string; version: number }) => void): () => void
    export(input: { artifactId: string; expectedVersion: number; format: 'txt' | 'md' }): Promise<R1Result<{ cancelled: true } | { cancelled: false; artifactId: string; version: number; path: string }>>
    get(input: { artifactId: string; version?: number }): Promise<R1Result<Artifact>>
    revise(input: Omit<Parameters<R1Artifacts['revise']>[0], 'temporaryOwner' | 'sourceRefs'>): Promise<R1Result<Artifact>>
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
