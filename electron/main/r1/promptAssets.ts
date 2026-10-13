import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { R1Persona } from './persona.js'

type Manifest = { files: { path: string; sha256: string }[] }
type Registry = { releaseId: string; entries: { skillId: string; name: string;
  description: string; version: string; path: string }[] }
type PromptRegistry = { releaseId: string; entries: { id: string; path: string }[] }
type ToolCatalog = { schemaVersion: string; businessTools: { name: string; alias: string }[] }

const requiredPromptIds = Array.from({ length: 10 }, (_, index) =>
  `PR${String(index + 1).padStart(2, '0')}`)
const requiredSkillIds = Array.from({ length: 6 }, (_, index) =>
  `SK${String(index + 1).padStart(2, '0')}`)

export type R1PromptAssets = {
  releaseId: string
  toolAliases: readonly string[]
  compose(persona: R1Persona, context: Record<string, unknown>): string
}

export function loadR1PromptAssets(root: string): R1PromptAssets {
  const manifest = JSON.parse(readFileSync(join(root, 'asset-manifest.json'), 'utf8')) as Manifest
  if (!Array.isArray(manifest.files)) throw new Error('PROMPT_ASSET_MANIFEST_INVALID')
  const manifestByPath = new Map(manifest.files.map((file) => [file.path, file.sha256]))
  const values = new Map<string, string>()
  function readVerified(path: string): string {
    if (!/^(?:config|contracts|prompts|skills|schemas)\/[a-zA-Z0-9/_-]+(?:\.[a-zA-Z0-9]+)?$/.test(path) ||
      path.includes('..')) throw new Error('PROMPT_ASSET_PATH_INVALID')
    if (values.has(path)) return values.get(path) as string
    const content = readFileSync(join(root, path), 'utf8')
    const hash = createHash('sha256').update(content).digest('hex')
    if (manifestByPath.get(path) !== hash) {
      throw new Error(`PROMPT_ASSET_INTEGRITY_FAILED:${path}`)
    }
    values.set(path, content)
    return content
  }
  const promptRegistry = JSON.parse(readVerified('config/prompt-registry.json')) as PromptRegistry
  const registry = JSON.parse(readVerified('config/skill-registry.json')) as Registry
  const toolCatalog = JSON.parse(readVerified('contracts/tool-catalog.json')) as ToolCatalog
  if (!promptRegistry.releaseId || !registry.releaseId ||
    promptRegistry.releaseId !== registry.releaseId ||
    promptRegistry.entries.length !== 10 || registry.entries.length !== 6 ||
    new Set(promptRegistry.entries.map((entry) => entry.id)).size !== 10 ||
    new Set(registry.entries.map((entry) => entry.skillId)).size !== 6 ||
    requiredPromptIds.some((id) => !promptRegistry.entries.some((entry) => entry.id === id)) ||
    requiredSkillIds.some((id) => !registry.entries.some((entry) => entry.skillId === id))) {
    throw new Error('PROMPT_ASSET_REGISTRY_INVALID')
  }
  for (const entry of promptRegistry.entries) readVerified(entry.path)
  for (const entry of registry.entries) readVerified(entry.path)
  if (!toolCatalog.schemaVersion || !Array.isArray(toolCatalog.businessTools) ||
    new Set(toolCatalog.businessTools.map((tool) => tool.alias)).size !== toolCatalog.businessTools.length) {
    throw new Error('PROMPT_ASSET_TOOL_CATALOG_INVALID')
  }
  const skillIndex = registry.entries.map(({ skillId, name, description, version, path }) =>
    ({ skillId, name, description, version, path }))
  const personaTemplate = values.get('prompts/persona.md') as string
  const conversationTemplate = values.get('prompts/conversation.md') as string
  if (!personaTemplate.includes('{{persona_json}}') ||
    !conversationTemplate.includes('{{skill_index_json}}')) {
    throw new Error('PROMPT_ASSET_TEMPLATE_INVALID')
  }

  return {
    releaseId: registry.releaseId,
    toolAliases: toolCatalog.businessTools.map((tool) => tool.alias),
    compose(persona, context) {
      const parts = [
        values.get('prompts/shared-policy.md') as string,
        personaTemplate.replace('{{persona_json}}', JSON.stringify(persona)),
        conversationTemplate.replace('{{skill_index_json}}', JSON.stringify(skillIndex)),
        values.get('skills/companion-chat/SKILL.md') as string,
        `APP_CONTEXT_DATA\n${JSON.stringify(context)}`
      ]
      const text = parts.join('\n\n')
      if (/\{\{[a-z_]+\}\}/.test(text)) throw new Error('PROMPT_ASSET_UNRESOLVED_VARIABLE')
      return text
    }
  }
}
