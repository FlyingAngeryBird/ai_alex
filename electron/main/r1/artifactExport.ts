import { writeFile } from 'node:fs/promises'
import type { R1Artifacts } from './artifacts.js'
export type ArtifactExportInput = { artifactId: string; expectedVersion: number; format: 'txt' | 'md' }
export async function exportArtifact(artifacts: R1Artifacts, input: ArtifactExportInput,
  owner: () => string | null, choose: (name: string, extension: string) => Promise<string | null>) {
  if (!input || !['txt', 'md'].includes(input.format) || !Number.isSafeInteger(input.expectedVersion)) throw new Error('INVALID_EXPORT_INPUT')
  const scope = owner()
  const snapshot = artifacts.get(input.artifactId, scope)
  if (snapshot.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
  const name = snapshot.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || '工作稿'
  const path = await choose(`${name}.${input.format}`, input.format)
  if (!path) return { cancelled: true as const }
  if (owner() !== scope) throw new Error('SESSION_CHANGED')
  // Recheck access and version after the native dialog returns; never substitute newer text.
  const current = artifacts.get(input.artifactId, scope)
  if (current.version !== snapshot.version) throw new Error('VERSION_CONFLICT')
  const content = input.format === 'md' ? `# ${snapshot.title}\n\n${snapshot.content}\n` : `${snapshot.title}\n\n${snapshot.content}\n`
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
  return { cancelled: false as const, artifactId: snapshot.artifactId, version: snapshot.version, path }
}
