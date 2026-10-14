import { createRequire } from 'node:module'
import {
  createVolcengineLlmProvider,
  VolcengineLlmError,
  type AssistantOutput,
  type ChatMessage,
  type LlmProvider
} from '../providers/llmProvider.js'
import { getDefaultConfigStore, type ConfigStore } from '../config/configStore.js'
import { randomUUID } from 'node:crypto'
import type { R1Conversations } from '../r1/conversations.js'
import type { R1PersonaStore } from '../r1/persona.js'
import type { R1PromptAssets } from '../r1/promptAssets.js'
import type { R1MemoryStore } from '../r1/memory.js'
import type { R1MemoryConfirmations } from '../r1/memoryConfirmations.js'
import type { R1TopicSummaries } from '../r1/topicSummaries.js'
import type { R1AutomaticMemory } from '../r1/automaticMemory.js'
import type { R1SessionMode } from '../r1/sessionMode.js'
import { R1ModelRequestBoundary } from '../r1/modelBoundary.js'
import type { R1ConversationDriver } from '../r1/conversationDriver.js'
import type { SessionMessage } from '../r1/conversations.js'

type AppResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

type ElectronRuntime = {
  ipcMain: IpcMainLike
}

type ChatPayload = {
  text: string
  requestId?: string
}

const MAX_MEMORY_MESSAGES = 40
const require = createRequire(import.meta.url)

const memory: ChatMessage[] = []

function ok<T>(data: T): AppResult<T> {
  return {
    ok: true,
    data
  }
}

function fail(code: string, message: string): AppResult<never> {
  return {
    ok: false,
    error: {
      code,
      message
    }
  }
}

function isChatPayload(payload: unknown): payload is ChatPayload {
  const value = payload as ChatPayload

  return typeof value?.text === 'string' && value.text.trim().length > 0 &&
    (value.requestId === undefined || typeof value.requestId === 'string' && value.requestId.length > 0 && value.requestId.length <= 160)
}

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

function appendMemory(message: ChatMessage): void {
  memory.push(message)

  if (memory.length > MAX_MEMORY_MESSAGES) {
    memory.splice(0, memory.length - MAX_MEMORY_MESSAGES)
  }
}

function clearMemory(): void {
  memory.splice(0, memory.length)
}

function createLlmMessages(text: string, systemPrompt: string): ChatMessage[] {
  return [
    {
      content: systemPrompt,
      role: 'system'
    },
    ...memory,
    {
      content: text,
      role: 'user'
    }
  ]
}

function normalizeChatError(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.message === 'RESPONSE_STOPPED') return { code: 'RESPONSE_STOPPED', message: '已停止当前回答。' }
  if (error instanceof Error && error.message === 'SESSION_CHANGED') {
    return { code: 'SESSION_CHANGED', message: '会话已切换，旧回答已丢弃。' }
  }
  if (error instanceof VolcengineLlmError) {
    return {
      code: error.code,
      message: error.message
    }
  }

  return {
    code: 'CHAT_FAILED',
    message: error instanceof Error ? error.message : '对话生成失败'
  }
}

export function registerChatHandlers(
  ipc: IpcMainLike = getIpcMain(),
  provider: LlmProvider = createVolcengineLlmProvider(),
  configStore: ConfigStore = getDefaultConfigStore(),
  conversations?: R1Conversations,
  personaStore?: R1PersonaStore,
  promptAssets?: R1PromptAssets,
  memoryStore?: R1MemoryStore,
  sessionMode?: R1SessionMode,
  onSessionEnded: (sessionId: string, temporary: boolean) => void = () => undefined,
  conversationDriver?: R1ConversationDriver,
  onMemoryInvalidated: (deletionEpoch: number) => void = () => undefined,
  memoryConfirmations?: R1MemoryConfirmations,
  automaticMemory?: R1AutomaticMemory,
  topicSummaries?: R1TopicSummaries
): void {
  clearMemory()
  let activeSystemPrompt: string | null = null
  let activePersonaVersion: number | null = null
  let activeDeletionEpoch: number | null = null
  let temporary = false
  if (sessionMode) sessionMode.temporary = false
  let sessionId = conversations?.start(false) ?? null
  if (sessionMode) sessionMode.sessionId = sessionId
  let sessionEpoch = 0
  let responseGeneration = 0
  let responseController: AbortController | null = null
  memoryConfirmations?.bindTemporaryExit(nextSessionId => {
    const previousSessionId = sessionId, previousTemporary = temporary
    clearMemory(); responseController?.abort(); sessionEpoch++
    temporary = false; sessionId = nextSessionId
    if (sessionMode) { sessionMode.temporary = false; sessionMode.sessionId = sessionId; sessionMode.selectedCandidate = null; sessionMode.selectedTopic = null; sessionMode.selectedArtifact = null }
    if (previousSessionId && conversations) {
      try { onSessionEnded(previousSessionId, previousTemporary) } finally { conversations.end(previousSessionId) }
    }
  })
  function beginResponse(): void {
    responseController?.abort(); responseController = new AbortController(); responseGeneration++
  }
  function endCurrentSession(): void {
    if (conversations && sessionId) {
      onSessionEnded(sessionId, temporary)
      conversations.end(sessionId)
    }
  }

  const topicSelectionKey = () => sessionMode?.selectedTopic ? `${sessionMode.selectedTopic.topicId}:${sessionMode.selectedTopic.version}` : null
  const artifactSelectionKey = () => JSON.stringify(sessionMode?.selectedArtifact ?? null)
  function captureRequest() {
    return { artifactSelection: artifactSelectionKey(), topicSelection: topicSelectionKey(), epoch: sessionEpoch, responseGeneration, signal: responseController?.signal, personaVersion: personaStore?.get().version,
      deletionEpoch: memoryStore?.currentDeletionEpoch() }
  }
  function requestIsCurrent(request: ReturnType<typeof captureRequest>): boolean {
    return request.artifactSelection === artifactSelectionKey() && request.topicSelection === topicSelectionKey() && request.epoch === sessionEpoch && request.responseGeneration === responseGeneration &&
      request.personaVersion === personaStore?.get().version &&
      request.deletionEpoch === memoryStore?.currentDeletionEpoch()
  }
  function staleError(request: ReturnType<typeof captureRequest>): Error {
    return new Error(request.epoch === sessionEpoch && request.personaVersion === personaStore?.get().version &&
      request.deletionEpoch === memoryStore?.currentDeletionEpoch() ? 'RESPONSE_STOPPED' : 'SESSION_CHANGED')
  }

  function persistTurn(text: string, reply: string, turnId: string, userStored = false): void {
    if (!conversations || !sessionId) return
    if (!userStored) conversations.append({ sessionId, turnId, role: 'user', body: text, status: 'final' })
    conversations.append({ sessionId, turnId, responseId: randomUUID(), role: 'assistant',
      body: reply, status: 'generated' })
  }
  function extractMemory(source: SessionMessage | undefined, event: unknown, request: ReturnType<typeof captureRequest>): void {
    if (!source || !automaticMemory || !memoryConfirmations) return
    const ownerId = (event as { sender?: { id?: number } })?.sender?.id
    if (!ownerId || memoryConfirmations.hasPendingForSource(source.messageId)) return
    automaticMemory.enqueue({ source, temporary, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      assertSession() { if (request.epoch !== sessionEpoch || sessionId !== source.sessionId || temporary) throw new Error('AUTO_MEMORY_SESSION_REVOKED') },
      assertLatest() { if (!requestIsCurrent(request)) throw staleError(request) },
      confirmSensitive() {
        const authorizationVersion = automaticMemory.getPolicy().version
        memoryConfirmations.offerSelection({ source, ownerId, temporary: false, sensitive: true, automatic: true, assertCurrent() {
          if (!requestIsCurrent(request)) throw staleError(request)
          automaticMemory.assertAuthorized(authorizationVersion)
        } })
      } })
  }

  function getSystemPrompt(turnId: string | null = null): { text: string; boundary?: R1ModelRequestBoundary; context?: Record<string, unknown> } {
    if (personaStore && promptAssets) {
      const persona = personaStore.get()
      const deletionEpoch = memoryStore?.currentDeletionEpoch() ?? 0
      if ((activePersonaVersion !== null && activePersonaVersion !== persona.version) ||
        (activeDeletionEpoch !== null && activeDeletionEpoch !== deletionEpoch)) {
        clearMemory()
        sessionEpoch += 1
        if (conversations && sessionId) {
          endCurrentSession()
          sessionId = conversations.start(temporary)
          if (sessionMode) sessionMode.sessionId = sessionId
        }
      }
      activePersonaVersion = persona.version
      activeDeletionEpoch = deletionEpoch
      const currentArtifact = conversationDriver?.artifactContext?.(sessionMode) ?? null
      const context = {
        sessionId, sessionGeneration: sessionEpoch + 1, turnId,
        currentTime: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        temporary, contextVersion: sessionEpoch + 1,
        personaVersion: persona.version,
        deletionEpoch,
        selectedEntity: currentArtifact ? { type: 'artifact', id: currentArtifact.artifactId, version: currentArtifact.version } : conversationDriver?.topicContext(sessionMode).selected ?? conversationDriver?.selectedEntity?.(sessionMode) ?? null, availableToolAliases: [], loadedSkillIds: ['SK01'],
        recentTurns: [], memories: [], activeTasks: [],
        topics: conversationDriver?.topicContext(sessionMode).topics ?? [], currentArtifact
      }
      const boundary = new R1ModelRequestBoundary(promptAssets, persona, context)
      return { text: boundary.systemText, boundary, context }
    }
    const systemPrompt = configStore.getConfig().persona.systemPrompt

    if (activeSystemPrompt !== null && activeSystemPrompt !== systemPrompt) {
      clearMemory()
      sessionEpoch += 1
      if (conversations && sessionId) {
        endCurrentSession()
        sessionId = conversations.start(temporary)
        if (sessionMode) sessionMode.sessionId = sessionId
      }
    }

    activeSystemPrompt = systemPrompt
    return { text: systemPrompt }
  }
  function storeUser(text: string, turnId: string): SessionMessage | undefined {
    return conversationDriver && conversations && sessionId
      ? conversations.append({ sessionId, turnId, role: 'user', body: text, status: 'final' }) : undefined
  }
  async function controlledReply(source: SessionMessage, messages: ChatMessage[], context: Record<string, unknown>,
    request: ReturnType<typeof captureRequest>, event: unknown): Promise<AssistantOutput> {
    const ownerId = (event as { sender?: { id?: number } })?.sender?.id
    if (ownerId) memoryConfirmations?.revoke(ownerId)
    const sharedMessages = conversations!.modelTurns(source.sessionId)
      .filter(message => message.text.trim())
      .map(message => ({ role: message.role as 'user' | 'assistant', content: message.text }))
    return conversationDriver!.reply({ messages: sharedMessages.length ? sharedMessages : messages, context: { ...context,
      recentTurns: conversations!.modelTurns(source.sessionId) }, scope: { source, sourceMessages: conversations!.messages(source.sessionId).slice(-20), temporary, timezone: context.timezone as string, persistenceConfirmed: false,
      signal: request.signal, assertCurrent() { if (!requestIsCurrent(request)) throw staleError(request) },
      requestMemoryConfirmation: memoryConfirmations && ownerId ? (candidate, sensitive) => memoryConfirmations.offer(candidate, {
        ownerId, source, temporary, sensitive, assertCurrent() { if (!requestIsCurrent(request)) throw staleError(request) }
      }) : undefined,
      onMemoryInvalidated(deletionEpoch) {
        request.deletionEpoch = deletionEpoch
        activeDeletionEpoch = deletionEpoch
        clearMemory()
        onMemoryInvalidated(deletionEpoch)
        // Only the local acknowledgement of our committed mutation adopts the
        // selection reset; the revoked model request is never used again.
        request.artifactSelection = artifactSelectionKey()
        request.topicSelection = topicSelectionKey()
      } } })
  }

  ipc.handle('chat.setTemporary', (_event, payload) => {
    if (!conversations || typeof (payload as { enabled?: unknown })?.enabled !== 'boolean') {
      return fail('INVALID_TEMPORARY_MODE', '临时对话状态不可用')
    }
    const enabled = (payload as { enabled: boolean }).enabled
    if (enabled === temporary) return ok({ temporary })
    clearMemory()
    responseController?.abort()
    sessionEpoch += 1
    endCurrentSession()
    temporary = enabled
    if (sessionMode) { sessionMode.selectedCandidate = null; sessionMode.selectedTopic = null; sessionMode.selectedArtifact = null }
    if (sessionMode) sessionMode.temporary = enabled
    sessionId = conversations.start(temporary)
    if (sessionMode) sessionMode.sessionId = sessionId
    return ok({ temporary })
  })
  ipc.handle('chat.stopResponse', () => {
    responseController?.abort(); responseGeneration++
    return ok({ stopped: true })
  })

  ipc.handle('chat.greeting', async (): Promise<AppResult<AssistantOutput>> => {
    beginResponse()
    const instructions = getSystemPrompt()
    const request = captureRequest()
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: instructions.text },
        { role: 'user', content: 'APP_EVENT_DATA\n{"type":"session_started","purpose":"opening_greeting"}' }
      ]
      const result = instructions.boundary ? await provider.sendMessage(messages, instructions.boundary)
        : await provider.sendMessage(messages)
      if (!requestIsCurrent(request)) throw new Error('SESSION_CHANGED')
      return ok({ intent: 'chat', music: null, reply: result.reply })
    } catch (error) {
      const normalized = normalizeChatError(requestIsCurrent(request) ? error : staleError(request))
      return fail(normalized.code, normalized.message)
    }
  })

  ipc.handle('chat.sendMessage', async (_event, payload): Promise<AppResult<AssistantOutput>> => {
    if (!isChatPayload(payload)) {
      return fail('CHAT_INVALID_PAYLOAD', '对话内容不能为空')
    }

    const text = payload.text.trim()
    beginResponse()
    const turnId = randomUUID()
    const instructions = getSystemPrompt(turnId)
    const request = captureRequest()

    try {
      const messages = createLlmMessages(text, instructions.text)
      const source = storeUser(text, turnId)
      const result = source && instructions.context ? await controlledReply(source, messages, instructions.context, request, _event)
        : instructions.boundary ? await provider.sendMessage(messages, instructions.boundary)
        : await provider.sendMessage(messages)
      if (!requestIsCurrent(request)) throw new Error('SESSION_CHANGED')
      persistTurn(text, result.reply, turnId, Boolean(source))
      extractMemory(source, _event, request)
      if (source) topicSummaries?.enqueue({ source, temporary, assertSession() { if (request.epoch !== sessionEpoch || sessionId !== source.sessionId || temporary) throw new Error('SUMMARY_CONTEXT_REVOKED') } })

      appendMemory({
        content: text,
        role: 'user'
      })
      appendMemory({
        content: result.reply,
        role: 'assistant'
      })

      return ok(result)
    } catch (error) {
      const normalized = normalizeChatError(requestIsCurrent(request) ? error : staleError(request))
      return fail(normalized.code, normalized.message)
    }
  })

  ipc.handle('chat.streamMessage', async (event, payload): Promise<AppResult<AssistantOutput>> => {
    if (!isChatPayload(payload)) {
      return fail('CHAT_INVALID_PAYLOAD', '对话内容不能为空')
    }

    const text = payload.text.trim()
    beginResponse()
    const turnId = randomUUID()
    const instructions = getSystemPrompt(turnId)
    const request = captureRequest()
    const sender = (event as { sender?: { send(channel: string, data: unknown): void } } | null)?.sender
    const requestId = payload.requestId

    function pushChunk(chunk: unknown): void {
      if (requestIsCurrent(request)) sender?.send('chat.streamChunk', requestId
        ? { ...(chunk as object), requestId } : chunk)
    }

    try {
      const messages = createLlmMessages(text, instructions.text)
      const source = storeUser(text, turnId)
      const callbacks = {
        onChunk: (delta: string) => pushChunk({ delta }),
        onRawChunk: () => pushChunk({ diagnostic: 'llm_raw_delta' }),
        onResponseStart: () => pushChunk({ diagnostic: 'llm_response_start' })
      }
      const result = source && instructions.context ? await controlledReply(source, messages, instructions.context, request, event)
        : instructions.boundary ? await provider.streamMessage(messages, callbacks, instructions.boundary)
        : await provider.streamMessage(messages, callbacks)
      if (!requestIsCurrent(request)) throw new Error('SESSION_CHANGED')
      persistTurn(text, result.reply, turnId, Boolean(source))
      extractMemory(source, event, request)
      if (source) topicSummaries?.enqueue({ source, temporary, assertSession() { if (request.epoch !== sessionEpoch || sessionId !== source.sessionId || temporary) throw new Error('SUMMARY_CONTEXT_REVOKED') } })

      appendMemory({
        content: text,
        role: 'user'
      })
      appendMemory({
        content: result.reply,
        role: 'assistant'
      })

      pushChunk({
        done: true,
        intent: result.intent,
        music: result.music,
        reply: result.reply
      })

      return ok(result)
    } catch (error) {
      const normalized = normalizeChatError(requestIsCurrent(request) ? error : staleError(request))
      sender?.send('chat.streamChunk', { done: true, error: normalized, ...(payload.requestId ? { requestId: payload.requestId } : {}) })
      return fail(normalized.code, normalized.message)
    }
  })
}
