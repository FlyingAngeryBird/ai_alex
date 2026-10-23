import type { R1Focus } from './focus.js'
export const focusToolAliases = ['focus_start', 'focus_get_state', 'focus_pause', 'focus_resume', 'focus_stop'] as const
export type FocusToolServices = { focus: R1Focus; currentTrackKey(): string | null }
export class R1FocusTools {
  readonly selectedTrackKey: string | null
  private knownFocusIds = new Set<string>()
  constructor(private readonly services: FocusToolServices, private readonly source: { body: string }, private readonly assertCurrent: () => void) { this.selectedTrackKey = services.currentTrackKey() }
  execute(alias: string, args: Record<string, unknown>, actionId: string): {
    data: Record<string, unknown>; entityId?: string; entityVersion?: number
  } {
    this.assertCurrent()
    const focus = this.services.focus
    if (alias === 'focus_get_state') {
      const state = focus.getState()
      if (state) this.knownFocusIds.add(state.focusId)
      return { data: { focus: state } }
    }
    let result: ReturnType<R1Focus['start']>
    if (alias === 'focus_start') {
      const rule = args.endMusicRule as 'none' | 'pause_user_selected_track'
      let trackKey: string | null = null
      if (rule === 'pause_user_selected_track') {
        const text = this.source.body
        if (!/结束|到点|完成/.test(text) || !/音乐|歌|曲/.test(text) || !/暂停|停|关闭/.test(text) ||
          /(?:不要|别|不).{0,5}(?:停|暂停|关闭)/.test(text)) throw new Error('FOCUS_MUSIC_CONFIRMATION_REQUIRED')
        trackKey = this.selectedTrackKey
        if (!trackKey) throw new Error('FOCUS_REQUIRES_SELECTED_TRACK')
      }
      result = focus.start({ actionId, durationSec: args.durationSec as number, endMusicRule: rule, endTargetTrackKey: trackKey })
    } else {
      if (!this.knownFocusIds.has(args.focusId as string)) throw new Error('FOCUS_NOT_OBSERVED')
      const method = alias === 'focus_pause' ? 'pause' : alias === 'focus_resume' ? 'resume' : alias === 'focus_stop' ? 'stop' : null
      if (!method) throw new Error('FOCUS_TOOL_UNAVAILABLE')
      result = focus[method]({ actionId, focusId: args.focusId as string, expectedVersion: args.expectedVersion as number })
    }
    this.assertCurrent(); this.knownFocusIds.add(result.focus.focusId)
    return { data: { focus: result.focus }, entityId: result.focus.focusId, entityVersion: result.focus.version }
  }
}
