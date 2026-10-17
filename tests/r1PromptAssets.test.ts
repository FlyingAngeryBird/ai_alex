import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { modelContext } from './helpers/r1ModelFixtures'

describe('R1 released prompt assets', () => {
  it('loads registered and hashed assets with the active persona', () => {
    const db = openR1Database(':memory:')
    try {
      const persona = new R1PersonaStore(db)
      const saved = persona.update({ expectedVersion: 1, assistantName: 'Alex',
        userAddress: '海', style: '温和而简洁' })
      const assets = loadR1PromptAssets(resolve('r1-assets'))
      const text = assets.compose(saved, modelContext({ personaVersion: saved.version }))
      expect(assets.releaseId).toBe('seamo-ai-r1-agent-assets-3.5.0')
      expect(assets.memoryRecallPolicy()).toEqual({ limit: 5, budgetMs: 200 })
      expect(text).toContain('你是Seamo AI应用中的个人语音助手')
      expect(text).toContain('按assistantName称呼自己')
      expect(text).toContain('"assistantName":"Alex"')
      expect(text).toContain('"userAddress":"海"')
      expect(text).toContain('APP_CONTEXT_DATA')
      expect(text).toContain('"path":"/skills/work-discussion/SKILL.md"')
      expect(text).not.toMatch(/\{\{[a-z_]+\}\}/)
    } finally { db.close() }
  })
  it('validates variables without interpreting placeholders inside user data', () => {
    const assets = loadR1PromptAssets(resolve('r1-assets'))
    const persona = { assistantName: 'Alex', userAddress: '', style: '喜欢 {{persona_json}}', voiceId: '', version: 1 }
    expect(assets.compose(persona, modelContext())).toContain('喜欢 {{persona_json}}')
    expect(() => assets.compose(persona, { sessionId: 'partial' })).toThrow('PROMPT_ASSET_VARIABLE_INVALID:app-context')
    expect(() => assets.compose({ ...persona, assistantName: 'x'.repeat(21) }, modelContext()))
      .toThrow('PROMPT_ASSET_VARIABLE_INVALID:persona')
    expect(() => assets.compile('textOnly', { persona_json: persona, skill_index_json: [],
      app_context: modelContext() })).toThrow('PROMPT_ASSET_VARIABLE_INVALID:skill-index')
  })
  it('intersects channel, loaded skills and authorization, and validates exact tool schemas', () => {
    const assets = loadR1PromptAssets(resolve('r1-assets'))
    const grants = ['notes_create', 'web_search', 'memory_recall', 'start_task', 'read_file']
    const aliases = (channel: 'realtime' | 'task', loadedSkillIds: string[], temporary = false) =>
      assets.exposeTools({ channel, loadedSkillIds, authorizedAliases: grants, temporary })
        .map(tool => tool.function.name)
    expect(aliases('realtime', ['SK01'])).toEqual(['memory_recall', 'start_task'])
    expect(aliases('realtime', ['SK01', 'SK03'])).toEqual(['memory_recall', 'notes_create', 'start_task'])
    expect(aliases('task', ['SK02', 'SK03'])).toEqual(['memory_recall', 'web_search', 'notes_create', 'read_file'])
    expect(aliases('realtime', ['SK01'], true)).toEqual(['start_task'])
    const memoryGrants = ['memory_remember', 'memory_recall', 'memory_update', 'memory_forget']
    expect(assets.exposeTools({ channel: 'realtime', loadedSkillIds: ['SK01'], authorizedAliases: memoryGrants, temporary: true }).map(tool => tool.function.name)).toEqual(['memory_remember'])
    expect(assets.exposeTools({ channel: 'task', loadedSkillIds: [], authorizedAliases: memoryGrants, temporary: true })).toEqual([])
    expect(() => assets.exposeTools({ channel: 'task', loadedSkillIds: ['SK02'],
      authorizedAliases: ['execute'], temporary: false })).toThrow('MODEL_TOOL_ALIAS_UNKNOWN')
    expect(() => assets.exposeTools({ channel: 'task', loadedSkillIds: ['SK99'],
      authorizedAliases: [], temporary: false })).toThrow('PROMPT_ASSET_SKILL_SCOPE_INVALID')
    expect(() => assets.validateToolInput('memory_recall', { query: '偏好', extra: 'escape' }))
      .toThrow('MODEL_TOOL_INPUT_INVALID')
    expect(() => assets.validateToolInput('memory_recall', { query: '偏好' })).not.toThrow()
  })
  it('validates actual tool output owner and domain data, preserving failure and UI-wait lifecycles', () => {
    const assets = loadR1PromptAssets(resolve('r1-assets'))
    const receipt = { kind: 'receipt', actionId: 'action', tool: 'memory.recall', status: 'succeeded',
      entityId: null, entityVersion: null, data: { matchStatus: 'no_match', memories: [] }, errorCode: null, retryable: false, runId: null }
    expect(() => assets.validateToolOutput('memory_recall', receipt)).not.toThrow()
    expect(() => assets.validateToolOutput('memory_recall', { ...receipt, tool: 'notes.create' })).toThrow('MODEL_TOOL_OUTPUT_OWNER_INVALID')
    expect(() => assets.validateToolOutput('memory_recall', { kind: 'ui_action', uiActionId: 'pending', status: 'awaiting_user', action: 'confirm_memory', data: {} })).toThrow('MODEL_TOOL_OUTPUT_OWNER_INVALID')
    expect(() => assets.validateToolOutput('memory_recall', { ...receipt, data: {} })).toThrow('MODEL_TOOL_OUTPUT_DATA_INVALID')
    expect(() => assets.validateToolOutput('memory_recall', { ...receipt, status: 'failed', data: {}, errorCode: 'UNAVAILABLE' })).not.toThrow()
    expect(() => assets.validateToolOutput('start_task', { kind: 'task_control', taskId: 'task', status: 'failed',
      goalVersion: 1, queuePosition: null, data: {}, errorCode: 'TASK_QUEUE_FULL' })).not.toThrow()
    expect(() => assets.validateToolOutput('notes_export', { kind: 'ui_action', uiActionId: 'ui', status: 'awaiting_user',
      action: 'export', data: { requestedFormat: 'md' } })).not.toThrow()
    expect(() => assets.validateToolOutput('notes_export', { kind: 'ui_action', uiActionId: 'ui', status: 'awaiting_user',
      action: 'confirm_item_delete', data: {} })).toThrow('MODEL_TOOL_OUTPUT_OWNER_INVALID')
    expect(() => assets.validateToolOutput('notes_delete', { kind: 'ui_action', uiActionId: 'ui', status: 'awaiting_user',
      action: 'export', data: {} })).toThrow('MODEL_TOOL_OUTPUT_OWNER_INVALID')
    expect(() => assets.validateToolOutput('notes_delete', { kind: 'ui_action', uiActionId: 'ui', status: 'awaiting_user',
      action: 'confirm_item_delete', data: {} })).not.toThrow()
  })
})
