import type { Artifact, ArtifactRange, R1Artifacts } from './artifacts.js'
import type { R1SessionMode } from './sessionMode.js'

export type ArtifactEditingContext = Pick<Artifact, 'artifactId' | 'version' | 'kind' | 'title' | 'content'> & { selection: ArtifactRange | null }
export type ArtifactEditProposal = { artifactId: string; expectedVersion: number; scope: 'whole' | 'selection' | 'paragraph'; paragraphIndex: number | null }
export type ArtifactEditBinding = { artifact: Artifact; target: ArtifactRange | null }

export function assertArtifactRange(content: string, range: ArtifactRange): void {
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 ||
    range.end <= range.start || range.end > [...content].length) throw new Error('ARTIFACT_RANGE_INVALID')
}
/** Paragraph identity is a formatting boundary, not an intent router. Blank lines separate paragraphs. */
export function artifactParagraph(content: string, index: number): ArtifactRange {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('ARTIFACT_PARAGRAPH_INVALID')
  const parts: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const separator of content.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)) {
    if (content.slice(cursor, separator.index).trim()) parts.push({ start: cursor, end: separator.index })
    cursor = separator.index! + separator[0].length
  }
  if (content.slice(cursor).trim()) parts.push({ start: cursor, end: content.length })
  const selected = parts[index - 1]
  if (!selected) throw new Error('ARTIFACT_PARAGRAPH_INVALID')
  return { start: [...content.slice(0, selected.start)].length, end: [...content.slice(0, selected.end)].length }
}
export function currentArtifactContext(mode: R1SessionMode | undefined, artifacts: R1Artifacts): ArtifactEditingContext | null {
  const selected = mode?.selectedArtifact
  if (!selected) return null
  try {
    const artifact = artifacts.get(selected.artifactId, mode!.temporary ? mode!.sessionId || '__missing__' : null)
    if (artifact.version !== selected.version) return null
    if (selected.selection) assertArtifactRange(artifact.content, selected.selection)
    const { artifactId, version, kind, title, content } = artifact
    return { artifactId, version, kind, title, content, selection: selected.selection }
  } catch { return null }
}
export function bindArtifactEdit(observed: ArtifactEditingContext | null | undefined, proposal: ArtifactEditProposal,
  artifacts: R1Artifacts, owner: string | null): ArtifactEditBinding {
  if (!observed || proposal.artifactId !== observed.artifactId || proposal.expectedVersion !== observed.version) throw new Error('ARTIFACT_TARGET_NOT_OBSERVED')
  const artifact = artifacts.get(proposal.artifactId, owner)
  if (artifact.version !== observed.version || artifact.content !== observed.content) throw new Error('VERSION_CONFLICT')
  if (proposal.scope !== 'paragraph' && proposal.paragraphIndex !== null) throw new Error('ARTIFACT_RANGE_INVALID')
  const target = proposal.scope === 'paragraph' ? artifactParagraph(artifact.content, proposal.paragraphIndex!) :
    proposal.scope === 'selection' ? observed.selection : null
  if (proposal.scope === 'selection' && !target || !['whole', 'selection', 'paragraph'].includes(proposal.scope)) throw new Error('ARTIFACT_RANGE_INVALID')
  if (target) assertArtifactRange(artifact.content, target)
  if (observed.selection && (!target || target.start < observed.selection.start || target.end > observed.selection.end)) throw new Error('ARTIFACT_OUTSIDE_TARGET_CHANGED')
  return { artifact, target }
}
