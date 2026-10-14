import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import type { R1Persona } from './persona.js'

export type R1ToolDefinition = {
  name: string; alias: string; description: string; input_schema: Record<string, unknown>
  output_data_schema: Record<string, unknown>; output_schema: string
  contexts: string[]; skill_ids: string[]; effect: string
}
export type R1ModelTool = { type: 'function'; function: {
  name: string; description: string; parameters: Record<string, unknown>
} }
type Manifest = { releaseId: string; version: string; files: { path: string; sha256: string }[] }
type SkillEntry = { skillId: string; name: string; description: string; version: string;
  path: string; resourcePaths: string[]; allowedTools: string[] }
type Registry = { releaseId: string; entries: SkillEntry[] }
type PromptEntry = { id: string; path: string; variables: string[]; variableSchemas: Record<string, string> }
type PromptRegistry = { releaseId: string; composition: Record<string, string[]>; entries: PromptEntry[] }
type ToolCatalog = { schemaVersion: string; businessTools: R1ToolDefinition[]; internalTools: R1ToolDefinition[] }
type Runtime = { releaseId: string; schemaVersion: string; activation: {
  preloadedSkills: string[]; alwaysAllowedRealtimeTools: string[]; alwaysAllowedTaskTools: string[]
}; limits: Record<string, number> }
export type R1CompiledPrompt = { text: string; sha256: string; releaseId: string;
  promptIds: string[]; skillIds: string[] }
export type R1PromptAssets = {
  releaseId: string
  schemaVersion: string
  toolAliases: readonly string[]
  compose(persona: R1Persona, context: Record<string, unknown>, mode?: 'textOnly' | 'realtime'): string
  composeTask(persona: R1Persona, taskInput: Record<string, unknown>): R1CompiledPrompt
  validateStructured(schema: 'task-input' | 'task-draft' | 'tool-output', input: unknown): void
  structuredSchema(schema: 'task-draft'): Record<string, unknown>
  toolDefinition(alias: string): R1ToolDefinition
  validateToolOutput(alias: string, input: unknown): void
  taskBudget(complexity: 'light' | 'complex'): { decisionsRemaining: number; toolsRemaining: number;
    activeMsRemaining: number; searchQueriesRemaining: number; pagesRemaining: number }
  readSkillFile(filePath: string, offset?: number, limit?: number): {
    data: { path: string; content: string; offset: number; hasMore: boolean; assetReleaseId: string }; loadedSkillId: string | null
  }
  loadSkill(skillId: string): { skillId: string; name: string; version: string; body: string; resourcePaths: string[] }
  compile(mode: string, variables: Record<string, unknown>, loadedSkillIds?: string[]): R1CompiledPrompt
  exposeTools(input: { channel: 'realtime' | 'task'; loadedSkillIds: string[];
    authorizedAliases: string[]; temporary: boolean }): R1ModelTool[]
  validateToolInput(alias: string, input: unknown): void
}

const requiredPromptIds = Array.from({ length: 10 }, (_, index) => `PR${String(index + 1).padStart(2, '0')}`)
const requiredSkillIds = Array.from({ length: 6 }, (_, index) => `SK${String(index + 1).padStart(2, '0')}`)
const placeholder = /\{\{([a-z_]+)\}\}/g
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function loadR1PromptAssets(root: string): R1PromptAssets {
  const manifest = JSON.parse(readFileSync(join(root, 'asset-manifest.json'), 'utf8')) as Manifest
  if (!Array.isArray(manifest.files) || !manifest.releaseId || !manifest.version ||
    new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) {
    throw new Error('PROMPT_ASSET_MANIFEST_INVALID')
  }
  const manifestByPath = new Map(manifest.files.map(file => [file.path, file.sha256]))
  const values = new Map<string, string>()
  function readVerified(path: string): string {
    if (!/^(?:config|contracts|prompts|skills|schemas)\/[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)*$/.test(path) ||
      path.includes('..')) throw new Error('PROMPT_ASSET_PATH_INVALID')
    if (values.has(path)) return values.get(path) as string
    const content = readFileSync(join(root, path), 'utf8')
    if (manifestByPath.get(path) !== sha256(content)) throw new Error(`PROMPT_ASSET_INTEGRITY_FAILED:${path}`)
    values.set(path, content)
    return content
  }
  const prompts = JSON.parse(readVerified('config/prompt-registry.json')) as PromptRegistry
  const skills = JSON.parse(readVerified('config/skill-registry.json')) as Registry
  const catalog = JSON.parse(readVerified('contracts/tool-catalog.json')) as ToolCatalog
  const runtime = JSON.parse(readVerified('config/runtime.defaults.json')) as Runtime
  if (![prompts.releaseId, skills.releaseId, runtime.releaseId].every(id => id === manifest.releaseId) ||
    catalog.schemaVersion !== runtime.schemaVersion ||
    prompts.entries.length !== 10 || skills.entries.length !== 6 ||
    new Set(prompts.entries.map(entry => entry.id)).size !== 10 ||
    new Set(skills.entries.map(entry => entry.skillId)).size !== 6 ||
    requiredPromptIds.some(id => !prompts.entries.some(entry => entry.id === id)) ||
    requiredSkillIds.some(id => !skills.entries.some(entry => entry.skillId === id))) {
    throw new Error('PROMPT_ASSET_REGISTRY_INVALID')
  }
  const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false,
    useDefaults: false, removeAdditional: false })
  const validators = new Map<string, ValidateFunction>()
  function validator(schemaName: string): ValidateFunction {
    if (!validators.has(schemaName)) validators.set(schemaName,
      ajv.compile(JSON.parse(readVerified(`schemas/${schemaName}.schema.json`))))
    return validators.get(schemaName) as ValidateFunction
  }
  function validate(schemaName: string, value: unknown): void {
    if (!validator(schemaName)(value)) throw new Error(`PROMPT_ASSET_VARIABLE_INVALID:${schemaName}`)
  }
  const promptById = new Map(prompts.entries.map(entry => [entry.id, entry]))
  const skillById = new Map(skills.entries.map(entry => [entry.skillId, entry]))
  for (const entry of prompts.entries) {
    const found = [...readVerified(entry.path).matchAll(placeholder)].map(match => match[1])
    if (new Set(found).size !== entry.variables.length ||
      entry.variables.some(key => !found.includes(key) || !entry.variableSchemas[key])) {
      throw new Error('PROMPT_ASSET_TEMPLATE_INVALID')
    }
    Object.values(entry.variableSchemas).forEach(validator)
  }
  for (const entry of skills.entries) {
    readVerified(entry.path)
    entry.resourcePaths.forEach(readVerified)
  }
  validator('app-context')
  const tools = [...catalog.businessTools, ...catalog.internalTools]
  if (catalog.businessTools.length !== 38 || catalog.internalTools.length !== 3 ||
    new Set(tools.map(tool => tool.alias)).size !== tools.length ||
    new Set(tools.map(tool => tool.name)).size !== tools.length ||
    tools.some(tool => !/^[a-z][a-z0-9_]*$/.test(tool.alias) || !tool.description)) {
    throw new Error('PROMPT_ASSET_TOOL_CATALOG_INVALID')
  }
  const toolByAlias = new Map(tools.map(tool => [tool.alias, tool]))
  const toolValidators = new Map(tools.map(tool => [tool.alias, ajv.compile(tool.input_schema)]))
  const outputValidators = new Map(tools.map(tool => [tool.alias, ajv.compile(tool.output_data_schema)]))
  const skillIndex = skills.entries.map(({ skillId, name, description, version, path }) =>
    ({ skillId, name, description, version, path: `/${path}` }))
  validate('skill-index', skillIndex)
  for (const entry of skills.entries) {
    if (entry.allowedTools.some(name => !tools.some(tool => tool.name === name))) {
      throw new Error('PROMPT_ASSET_SKILL_SCOPE_INVALID')
    }
  }
  for (const alias of [...runtime.activation.alwaysAllowedRealtimeTools,
    ...runtime.activation.alwaysAllowedTaskTools]) {
    if (!toolByAlias.has(alias)) throw new Error('PROMPT_ASSET_ACTIVATION_INVALID')
  }
  function checkedSkills(ids: string[]): string[] {
    if (!Array.isArray(ids) || ids.some(id => !skillById.has(id)) ||
      new Set(ids).size !== ids.length) throw new Error('PROMPT_ASSET_SKILL_SCOPE_INVALID')
    return ids
  }
  function compile(mode: string, variables: Record<string, unknown>, loadedSkillIds: string[] = []): R1CompiledPrompt {
    const composition = prompts.composition[mode]
    if (!composition || !variables || typeof variables !== 'object' || Array.isArray(variables)) {
      throw new Error('PROMPT_ASSET_COMPOSITION_INVALID')
    }
    checkedSkills(loadedSkillIds)
    const expected = new Set<string>()
    const promptIds: string[] = []
    const skillIds: string[] = []
    const parts = composition.map(component => {
      if (component.startsWith('PR')) {
        const entry = promptById.get(component)
        if (!entry) throw new Error('PROMPT_ASSET_COMPOSITION_INVALID')
        promptIds.push(component)
        for (const key of entry.variables) {
          expected.add(key)
          validate(entry.variableSchemas[key], variables[key])
        }
        // One pass over the registered template. Braces within JSON data are never interpreted.
        return readVerified(entry.path).replace(placeholder, (_match, key: string) => JSON.stringify(variables[key]))
      }
      if (skillById.has(component)) {
        skillIds.push(component)
        return readVerified(skillById.get(component)!.path)
      }
      if (component === 'app-context') {
        expected.add('app_context')
        validate('app-context', variables.app_context)
        const context = variables.app_context as { temporary: boolean; memories: unknown[] }
        if (context.temporary && context.memories.length) throw new Error('TEMPORARY_CONTEXT_CONTAINS_MEMORY')
        return `APP_CONTEXT_DATA\n${JSON.stringify(context)}`
      }
      throw new Error('PROMPT_ASSET_COMPOSITION_INVALID')
    })
    if (Object.keys(variables).length !== expected.size || Object.keys(variables).some(key => !expected.has(key))) {
      throw new Error('PROMPT_ASSET_VARIABLE_SET_INVALID')
    }
    let insertion = composition.indexOf('app-context')
    if (insertion < 0) insertion = parts.length
    for (const id of loadedSkillIds) {
      if (!skillIds.includes(id)) {
        skillIds.push(id)
        parts.splice(insertion++, 0, readVerified(skillById.get(id)!.path))
      }
    }
    const text = parts.join('\n\n')
    return { text, sha256: sha256(text), releaseId: manifest.releaseId, promptIds, skillIds }
  }
  return {
    releaseId: manifest.releaseId,
    schemaVersion: catalog.schemaVersion,
    toolAliases: Object.freeze(tools.map(tool => tool.alias)),
    compile,
    compose(persona, context, mode = 'textOnly') {
      return compile(mode, { persona_json: persona, skill_index_json: skillIndex,
        app_context: context }, (context.loadedSkillIds ?? ['SK01']) as string[]).text
    },
    composeTask(persona, taskInput) {
      return compile('task', { persona_json: persona, skill_index_json: skillIndex,
        task_input_json: taskInput }, (taskInput.loadedSkillIds ?? []) as string[])
    },
    validateStructured(schema, input) { validate(schema, input) },
    structuredSchema(schema) { return JSON.parse(readVerified(`schemas/${schema}.schema.json`)) as Record<string, unknown> },
    toolDefinition(alias) {
      const tool = toolByAlias.get(alias)
      if (!tool) throw new Error('MODEL_TOOL_ALIAS_UNKNOWN')
      return structuredClone(tool)
    },
    taskBudget(complexity) {
      if (!['light', 'complex'].includes(complexity)) throw new Error('TASK_COMPLEXITY_INVALID')
      const limits = runtime.limits
      const budget = { decisionsRemaining: limits[complexity === 'light' ? 'lightTaskDecisions' : 'complexTaskDecisions'],
        toolsRemaining: limits[complexity === 'light' ? 'lightTaskTools' : 'complexTaskTools'], activeMsRemaining: limits.complexTaskActiveMs,
        searchQueriesRemaining: limits[complexity === 'light' ? 'simpleSearchQueries' : 'complexSearchQueries'],
        pagesRemaining: limits[complexity === 'light' ? 'simpleSearchPages' : 'complexSearchPages'] }
      if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('TASK_BUDGET_CONFIG_INVALID')
      return budget
    },
    validateToolOutput(alias, input) {
      const tool = toolByAlias.get(alias)
      if (!tool) throw new Error('MODEL_TOOL_ALIAS_UNKNOWN')
      validate('tool-output', input)
      const value = input as { kind: string; tool?: string; status: string; data: Record<string, unknown> }
      if (value.kind === 'receipt' && value.tool !== tool.name) throw new Error('MODEL_TOOL_OUTPUT_OWNER_INVALID')
      const required = (value.kind === 'task_control' && value.status !== 'failed') ||
        (value.kind === 'receipt' && (value.status === 'succeeded' || Object.keys(value.data).length > 0))
      if (required && !outputValidators.get(alias)!(value.data)) throw new Error('MODEL_TOOL_OUTPUT_DATA_INVALID')
    },
    readSkillFile(filePath, offset = 0, limit = 2000) {
      if (typeof filePath !== 'string' || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('SKILL_FILE_INPUT_INVALID')
      const entry = skills.entries.find(skill => [`/${skill.path}`, ...skill.resourcePaths.map(path => `/${path}`)].includes(filePath))
      if (!entry) throw new Error('SKILL_FILE_SCOPE_INVALID')
      const lines = readVerified(filePath.slice(1)).split('\n')
      const content = lines.slice(offset, offset + limit).join('\n')
      if ([...content].length > 20000) throw new Error('SKILL_FILE_SLICE_TOO_LARGE')
      const hasMore = offset + limit < lines.length
      return { data: { path: filePath, content, offset, hasMore, assetReleaseId: manifest.releaseId },
        loadedSkillId: filePath === `/${entry.path}` && offset === 0 && !hasMore ? entry.skillId : null }
    },
    loadSkill(skillId) {
      const skill = skillById.get(skillId)
      if (!skill) throw new Error('PROMPT_ASSET_SKILL_SCOPE_INVALID')
      return { skillId, name: skill.name, version: skill.version, body: readVerified(skill.path), resourcePaths: skill.resourcePaths.map(path => `/${path}`) }
    },
    exposeTools({ channel, loadedSkillIds, authorizedAliases, temporary }) {
      if (!['realtime', 'task'].includes(channel)) throw new Error('MODEL_TOOL_CHANNEL_UNKNOWN')
      checkedSkills(loadedSkillIds)
      if (!Array.isArray(authorizedAliases) || authorizedAliases.some(alias => !toolByAlias.has(alias))) {
        throw new Error('MODEL_TOOL_ALIAS_UNKNOWN')
      }
      const always = channel === 'realtime' ? runtime.activation.alwaysAllowedRealtimeTools
        : runtime.activation.alwaysAllowedTaskTools
      const allowed = new Set(always)
      for (const id of loadedSkillIds) {
        const skill = skillById.get(id)!
        for (const tool of tools) {
          if (skill.allowedTools.includes(tool.name) && tool.skill_ids.includes(id)) allowed.add(tool.alias)
        }
      }
      const grants = new Set(authorizedAliases)
      return tools.filter(tool => tool.contexts.includes(channel) && allowed.has(tool.alias) && grants.has(tool.alias) &&
        !(temporary && tool.name.startsWith('memory.'))).map(tool => ({ type: 'function', function: {
        name: tool.alias, description: tool.description, parameters: structuredClone(tool.input_schema)
      } }))
    },
    validateToolInput(alias, input) {
      const check = toolValidators.get(alias)
      if (!check) throw new Error('MODEL_TOOL_ALIAS_UNKNOWN')
      if (!check(input)) throw new Error('MODEL_TOOL_INPUT_INVALID')
    }
  }
}
