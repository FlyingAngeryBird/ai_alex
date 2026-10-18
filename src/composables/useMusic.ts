import { MusicDucking } from '../services/musicDucking'
import { computed, getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import type { AppResult } from '@/types/electron-api'
import type { MusicAudioBands, MusicSourcePreference, MusicTrack, PlaybackState, ViewMode } from '@/types/app'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'
import type { MusicCommand, MusicReport, MusicSnapshot } from '../../electron/main/r1/music'

type UseMusicOptions = {
  createAudioContext?: () => AudioContext | null
  createAudioElement?: () => HTMLAudioElement
  configureOutput?: (target: HTMLMediaElement | AudioContext) => Promise<() => void>
}

type AudioEnergyRange = {
  max: number
  min: number
}

function createInitialPlayback(): PlaybackState {
  return {
    status: 'idle',
    track: null,
    positionMs: 0,
    durationMs: null
  }
}

function createInitialAudioBands(): MusicAudioBands {
  return {
    bass: 0,
    beat: 0,
    centroid: 0.32,
    flux: 0,
    mid: 0,
    treble: 0
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function createEnergyRange(initialValue: number): AudioEnergyRange {
  return {
    max: initialValue + 0.04,
    min: Math.max(0, initialValue - 0.04)
  }
}

function updateEnergyRange(range: AudioEnergyRange, value: number): void {
  const slowFollow = 0.006
  const fastFollow = 0.34

  range.min += (value - range.min) * (value < range.min ? fastFollow : slowFollow)
  range.max += (value - range.max) * (value > range.max ? fastFollow : slowFollow)

  if (range.max - range.min < 0.035) {
    const midpoint = (range.max + range.min) / 2
    range.min = Math.max(0, midpoint - 0.0175)
    range.max = Math.min(1, midpoint + 0.0175)
  }
}

function normalizeEnergy(value: number, range: AudioEnergyRange, floor = 0.08): number {
  const span = Math.max(0.035, range.max - range.min)
  const normalized = clamp01((value - range.min) / span)
  const perceived = Math.sqrt(normalized) * 0.72 + Math.sqrt(clamp01(value)) * 0.28

  return floor + perceived * (1 - floor)
}

function averageFrequencyRange(
  frequencyData: Uint8Array<ArrayBuffer>,
  start: number,
  end: number
): number {
  let total = 0
  const safeStart = Math.max(0, Math.min(start, frequencyData.length))
  const safeEnd = Math.max(safeStart + 1, Math.min(end, frequencyData.length))

  for (let index = safeStart; index < safeEnd; index += 1) {
    total += frequencyData[index] ?? 0
  }

  return total / Math.max(1, safeEnd - safeStart) / 255
}

function getDefaultAudioContext(): AudioContext | null {
  const AudioContextCtor = globalThis.AudioContext

  if (!AudioContextCtor) {
    return null
  }

  return new AudioContextCtor()
}

function toFiniteMilliseconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null
  }

  return Math.round(seconds * 1000)
}

export function useMusic(options: UseMusicOptions = {}) {
  const r1 = globalThis.window?.seamoR1?.music
  const volume = ref(100)
  const ducking = new MusicDucking()
  function setVolume(value: number): void {
    if (!Number.isFinite(value)) return
    volume.value = Math.max(0, Math.min(100, value))
    ducking.setVolume(volume.value / 100)
    if (r1 && r1Snapshot) {
      desiredVolume = { value: volume.value, expectedVersion: r1Snapshot.state.playerVersion }
      void syncVolume()
    }
  }
  const viewMode = ref<ViewMode>('conversation')
  const playback = ref<PlaybackState>(createInitialPlayback())
  const audioLevel = ref(0)
  const audioBands = ref<MusicAudioBands>(createInitialAudioBands())
  const searchResults = ref<MusicTrack[]>([])
  const searchResultsVisible = ref(false)
  const sourcePreference = ref<MusicSourcePreference>('all')
  const searchQuery = ref(r1 ? '' : '适合此刻的音乐')
  const playbackHistory = ref<MusicTrack[]>([])
  const playbackQueue = ref<MusicTrack[]>([])
  const favorites = ref<MusicTrack[]>([])
  const searchHistory = ref<string[]>([])
  const activeTab = ref<'search' | 'favorite' | 'queue'>('search')
  const musicNotice = ref('')
  const audioEnergyRanges = {
    average: createEnergyRange(0.18),
    bass: createEnergyRange(0.14),
    mid: createEnergyRange(0.14),
    treble: createEnergyRange(0.12)
  }
  let analyser: AnalyserNode | null = null
  let audioContext: AudioContext | null = null
  let releaseAudioOutput: (() => void) | null = null, releaseAnalysisOutput: (() => void) | null = null
  let analysisStarting: { audio: HTMLAudioElement; promise: Promise<void> } | null = null
  let audioElement: HTMLAudioElement | null = null
  let frequencyData: Uint8Array<ArrayBuffer> | null = null
  let mediaSource: MediaElementAudioSourceNode | null = null
  let previousFrequencyData: Uint8Array<ArrayBuffer> | null = null
  let removeAudioListeners: (() => void) | null = null
  let audioLevelTimer: ReturnType<typeof globalThis.setInterval> | undefined
  let activePlayRequestId = 0
  let silentAnalysisTicks = 0
  let r1Snapshot: MusicSnapshot | null = null, nonce: string | null = null
  let bridgeReady: Promise<boolean> | null = null, stopped = false, deviceVersion = 0, deviceRequest = ''
  let stopCommands: (() => void) | undefined, stopSnapshots: (() => void) | undefined
  let desiredVolume: { value: number; expectedVersion: number } | null = null, volumeBusy = false
  let searchGeneration = 0
  const queueEntries = ref<MusicSnapshot['queue']>([])
  const queueVersion = ref(0)

  function adopt(snapshot: MusicSnapshot): void {
    if (stopped || r1Snapshot && snapshot.state.playerVersion < r1Snapshot.state.playerVersion) return
    r1Snapshot = snapshot; playback.value = snapshot.playback
    favorites.value = snapshot.favorites; searchHistory.value = snapshot.searchHistory
    queueEntries.value = snapshot.queue; playbackQueue.value = snapshot.queue.map(entry => entry.track)
    queueVersion.value = snapshot.state.queueVersion
    if (!volumeBusy && !desiredVolume) { volume.value = snapshot.state.baseVolume; ducking.setVolume(volume.value / 100) }
  }
  async function ensureBridge(): Promise<boolean> {
    if (!r1 || stopped) return false
    if (bridgeReady) return bridgeReady
    stopSnapshots = r1.onChanged(adopt)
    stopCommands = r1.onCommand(command => { void ensureBridge().then(ready => { if (ready) void applyCommand(command) }) })
    bridgeReady = r1.attach().then(result => {
      if (!result.ok || stopped) return false
      nonce = result.data.nonce; adopt(result.data.snapshot); return true
    }).catch(() => false)
    return bridgeReady
  }
  function report(status: MusicReport['status'], commandId: string | null = null, request = deviceRequest): void {
    if (!r1 || !nonce || !request || stopped) return
    const audio = audioElement
    void r1.report({ nonce, report: { commandId, playbackRequestId: request, status,
      positionSec: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : playback.value.positionMs / 1000,
      durationSec: audio && Number.isFinite(audio.duration) ? audio.duration : playback.value.durationMs ? playback.value.durationMs / 1000 : null } }).catch(() => undefined)
  }
  async function applyCommand(command: MusicCommand): Promise<void> {
    if (stopped || command.playerVersion < deviceVersion) { report('failed', command.commandId, command.playbackRequestId); return }
    deviceVersion = command.playerVersion
    if (command.action !== 'volume') deviceRequest = command.playbackRequestId
    try {
      if (command.action === 'volume') {
        if (!desiredVolume) { volume.value = command.volume; ducking.setVolume(command.volume / 100) }
        report('volume', command.commandId, command.playbackRequestId); return
      }
      if (command.action === 'stop') { activePlayRequestId++; releaseAudioResources(); pauseAudioAnalysis(); report('stopped', command.commandId); return }
      if (command.action === 'pause') {
        activePlayRequestId++; audioElement?.pause(); pauseAudioAnalysis(); playback.value = { ...playback.value, status: 'paused' }
        report('paused', command.commandId); return
      }
      if (command.action === 'seek') {
        if (!audioElement) throw new Error('MUSIC_NO_AUDIO')
        audioElement.currentTime = command.positionSec; updatePlaybackFromAudio(audioElement); report('seeked', command.commandId); return
      }
      if (command.action === 'load' || !audioElement) {
        if (!command.track?.audioUrl) throw new Error('MUSIC_NO_AUDIO')
        const request = ++activePlayRequestId
        await startResolvedPlayback({ status: 'loading', track: command.track, positionMs: 0, durationMs: command.track.durationMs || null }, request)
        if (request !== activePlayRequestId || command.playbackRequestId !== deviceRequest || stopped) return
        report(playback.value.status === 'playing' ? 'playing' : 'failed', command.commandId)
      } else {
        const request = activePlayRequestId
        await audioElement.play()
        if (request !== activePlayRequestId || command.playbackRequestId !== deviceRequest || stopped) return
        playback.value = { ...playback.value, status: 'playing' }; await startAudioAnalysis(audioElement)
        report('playing', command.commandId)
      }
    } catch { report('failed', command.commandId, command.playbackRequestId) }
  }
  async function control(alias: string, args: Record<string, unknown>, temporarySaveConfirmed = false): Promise<boolean> {
    if (!r1 || !await ensureBridge()) return false
    const result = await r1.control({ alias, args, temporarySaveConfirmed })
    const current = await r1.snapshot(); if (current.ok) adopt(current.data)
    if (!result.ok) {
      playback.value = { ...playback.value, errorMessage: result.error.code === 'VERSION_CONFLICT' ? '播放器状态已变化，请重试。'
        : result.error.code === 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' ? '当前为临时对话，长期保存需要单独确认。' : '音乐操作未完成，请重试或选择其他音源。' }
      musicNotice.value = playback.value.errorMessage ?? '音乐操作未完成。'
    } else musicNotice.value = ''
    return result.ok
  }
  async function syncVolume(): Promise<void> {
    if (volumeBusy || !r1 || !await ensureBridge()) return
    if (volumeBusy) return
    volumeBusy = true
    try {
      while (desiredVolume && !stopped) {
        const submitted = desiredVolume; desiredVolume = null
        const result = await r1.control({ alias: 'music_set_volume', args: { expectedVersion: submitted.expectedVersion, volume: submitted.value } })
        const state = result.ok ? result.data.state as MusicSnapshot['state'] : null
        if (desiredVolume && state?.playerVersion === submitted.expectedVersion + 1 &&
          (desiredVolume as { expectedVersion: number }).expectedVersion === submitted.expectedVersion) (desiredVolume as { expectedVersion: number }).expectedVersion = state.playerVersion
        if (!result.ok && result.error.code !== 'VERSION_CONFLICT') break
      }
    } finally {
      volumeBusy = false
      const current = await r1.snapshot(); if (current.ok) adopt(current.data)
    }
  }

  const hasActiveTrack = computed(() => playback.value.track !== null)
  const isPlaying = computed(() => playback.value.status === 'playing')

  function resetAudioEnergyRanges(): void {
    audioEnergyRanges.average = createEnergyRange(0.18)
    audioEnergyRanges.bass = createEnergyRange(0.14)
    audioEnergyRanges.mid = createEnergyRange(0.14)
    audioEnergyRanges.treble = createEnergyRange(0.12)
    silentAnalysisTicks = 0
  }

  function smoothstep(value: number, min: number, max: number): number {
    const normalized = clamp01((value - min) / Math.max(0.0001, max - min))

    return normalized * normalized * (3 - 2 * normalized)
  }

  function setUnmeasuredAudioBands(): void {
    audioLevel.value = 0
    audioBands.value = createInitialAudioBands()
  }

  function getTrackKey(track: MusicTrack | null): string {
    return track ? `${track.source ?? 'unknown'}:${track.id}` : ''
  }

  function rememberCurrentTrack(nextTrack: MusicTrack): void {
    const currentTrack = playback.value.track

    if (!currentTrack || getTrackKey(currentTrack) === getTrackKey(nextTrack)) {
      return
    }

    playbackHistory.value = [...playbackHistory.value, currentTrack].slice(-20)
  }

  function mergeSelectedTrackMetadata(
    resolvedPlayback: PlaybackState,
    selectedTrack: MusicTrack
  ): PlaybackState {
    const resolvedTrack = resolvedPlayback.track

    if (!resolvedTrack) {
      return resolvedPlayback
    }

    return {
      ...resolvedPlayback,
      durationMs: resolvedPlayback.durationMs || selectedTrack.durationMs || resolvedTrack.durationMs,
      track: {
        ...resolvedTrack,
        album: selectedTrack.album ?? resolvedTrack.album,
        artist: selectedTrack.artist || resolvedTrack.artist,
        artworkId: selectedTrack.artworkId ?? resolvedTrack.artworkId,
        artworkUrl: resolvedTrack.artworkUrl ?? selectedTrack.artworkUrl,
        durationMs: resolvedTrack.durationMs || selectedTrack.durationMs,
        lyricId: selectedTrack.lyricId ?? resolvedTrack.lyricId,
        playbackId: selectedTrack.playbackId ?? resolvedTrack.playbackId,
        source: selectedTrack.source ?? resolvedTrack.source,
        title: selectedTrack.title || resolvedTrack.title
      }
    }
  }

  async function invokeMusic<T>(
    channel: Parameters<Window['lingli']['invoke']>[0],
    payload?: unknown
  ): Promise<AppResult<T>> {
    const api = globalThis.window?.lingli

    if (!api) {
      return {
        ok: false,
        error: {
          code: 'MUSIC_BRIDGE_UNAVAILABLE',
          message: '音乐通道不可用'
        }
      }
    }

    return invokeWithTimeout(
      api.invoke<T>(channel, payload),
      12000,
      '音乐服务响应超时。'
    )
  }

  function markMusicError(message: string): void {
    releaseAudioResources()
    playback.value = {
      durationMs: null,
      errorMessage: message,
      positionMs: 0,
      status: 'error',
      track: null
    }
  }
  function outputFailed(): void {
    if (!audioElement && !r1Snapshot?.state.track) return
    activePlayRequestId++
    if (r1) report('failed')
    markMusicError('输出设备不可用，音乐已停止。请重新选择设备后重试。')
    musicNotice.value = '输出设备不可用，音乐已停止。请重新选择设备后重试。'
  }

  function clearAudioLevelTimer(): void {
    if (audioLevelTimer !== undefined) {
      globalThis.clearInterval(audioLevelTimer)
      audioLevelTimer = undefined
    }
  }

  function pauseAudioAnalysis(): void {
    clearAudioLevelTimer()
    audioLevel.value = 0
    audioBands.value = createInitialAudioBands()
  }

  function stopAudioAnalysis(): void {
    pauseAudioAnalysis()
    resetAudioEnergyRanges()

    try {
      mediaSource?.disconnect()
      analyser?.disconnect()
    } catch {
      // The browser can throw when a node is already disconnected.
    }

    mediaSource = null
    analyser = null
    frequencyData = null
    previousFrequencyData = null
  }

  function closeAudioContext(): void {
    releaseAnalysisOutput?.(); releaseAnalysisOutput = null
    const context = audioContext
    audioContext = null

    try {
      const closeResult = context?.close()
      if (closeResult) {
        void closeResult.catch(() => undefined)
      }
    } catch {
      // Closing is best effort; the browser may reject if the context is already closed.
    }
  }

  function startAudioLevelTimer(): void {
    clearAudioLevelTimer()

    if (!analyser || !frequencyData) {
      return
    }

    audioLevelTimer = globalThis.setInterval(() => {
      if (!analyser || !frequencyData || playback.value.status !== 'playing') {
        audioLevel.value = 0
        audioBands.value = createInitialAudioBands()
        return
      }

      analyser.getByteFrequencyData(frequencyData)
      const bassEnd = Math.max(1, Math.floor(frequencyData.length * 0.08))
      const midEnd = Math.max(bassEnd + 1, Math.floor(frequencyData.length * 0.48))
      const bass = averageFrequencyRange(frequencyData, 0, bassEnd)
      const mid = averageFrequencyRange(frequencyData, bassEnd, midEnd)
      const treble = averageFrequencyRange(frequencyData, midEnd, frequencyData.length)
      let total = 0
      let weighted = 0
      let positiveDelta = 0

      for (let index = 0; index < frequencyData.length; index += 1) {
        const value = frequencyData[index] ?? 0
        total += value
        weighted += value * index

        if (previousFrequencyData) {
          positiveDelta += Math.max(0, value - (previousFrequencyData[index] ?? 0))
        }
      }

      const average = total / Math.max(1, frequencyData.length)
      const centroid = total > 0
        ? weighted / total / Math.max(1, frequencyData.length - 1)
        : 0.32
      const flux = previousFrequencyData
        ? positiveDelta / Math.max(1, frequencyData.length) / 255
        : 0
      const rawAverage = average / 255

      if (rawAverage < 0.003) {
        silentAnalysisTicks += 1
        if (silentAnalysisTicks >= 6) {
          setUnmeasuredAudioBands()
          previousFrequencyData = new Uint8Array(frequencyData)
          return
        }
      } else {
        silentAnalysisTicks = 0
      }

      updateEnergyRange(audioEnergyRanges.average, rawAverage)
      updateEnergyRange(audioEnergyRanges.bass, bass)
      updateEnergyRange(audioEnergyRanges.mid, mid)
      updateEnergyRange(audioEnergyRanges.treble, treble)

      const perceivedAverage = normalizeEnergy(rawAverage, audioEnergyRanges.average, 0.16)
      const perceivedBass = normalizeEnergy(bass, audioEnergyRanges.bass)
      const perceivedMid = normalizeEnergy(mid, audioEnergyRanges.mid)
      const perceivedTreble = normalizeEnergy(treble, audioEnergyRanges.treble)
      const rawBeat = Math.max(
        smoothstep(bass - audioEnergyRanges.bass.min, 0.018, 0.12),
        smoothstep(flux, 0.018, 0.13)
      )

      audioLevel.value = Math.min(0.94, 0.16 + perceivedAverage * 0.78)
      audioBands.value = {
        bass: perceivedBass,
        beat: clamp01(rawBeat),
        centroid: clamp01(centroid),
        flux: clamp01(flux * 2.8),
        mid: perceivedMid,
        treble: perceivedTreble
      }
      previousFrequencyData = new Uint8Array(frequencyData)
    }, 80)
  }

  async function startAudioAnalysis(audio: HTMLAudioElement): Promise<void> {
    if (analysisStarting?.audio === audio) return analysisStarting.promise
    const entry = { audio, promise: startAudioAnalysisImpl(audio).finally(() => { if (analysisStarting === entry) analysisStarting = null }) }
    analysisStarting = entry; return entry.promise
  }
  async function startAudioAnalysisImpl(audio: HTMLAudioElement): Promise<void> {
    clearAudioLevelTimer()
    resetAudioEnergyRanges()

    if (analyser && frequencyData && mediaSource) {
      await audioContext?.resume?.()
      startAudioLevelTimer()
      return
    }

    const createAudioContext = options.createAudioContext ?? getDefaultAudioContext
    audioContext = audioContext ?? createAudioContext()

    if (!audioContext) {
      clearAudioLevelTimer()
      setUnmeasuredAudioBands()
      return
    }

    const context = audioContext
    try {
      if (options.configureOutput && !releaseAnalysisOutput) {
        const release = await options.configureOutput(context)
        if (audio !== audioElement || context !== audioContext) { release(); return }
        releaseAnalysisOutput = release
      }
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.58
      mediaSource = audioContext.createMediaElementSource(audio)
      mediaSource.connect(analyser)
      analyser.connect(audioContext.destination)
      frequencyData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      previousFrequencyData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      await context.resume?.()
      if (audio !== audioElement || context !== audioContext) return
      startAudioLevelTimer()
    } catch {
      if (audio !== audioElement || context !== audioContext) return
      const graphWasBound = Boolean(mediaSource)
      stopAudioAnalysis()
      clearAudioLevelTimer()
      setUnmeasuredAudioBands()
      if (graphWasBound) throw new Error('MUSIC_OUTPUT_UNAVAILABLE')
    }
  }

  function updatePlaybackFromAudio(audio: HTMLAudioElement): void {
    const durationMs = toFiniteMilliseconds(audio.duration) ?? playback.value.durationMs
    const positionMs = toFiniteMilliseconds(audio.currentTime) ?? playback.value.positionMs
    const currentTrack = playback.value.track

    playback.value = {
      ...playback.value,
      durationMs,
      positionMs,
      track: currentTrack
        ? {
            ...currentTrack,
            durationMs: durationMs ?? currentTrack.durationMs
          }
        : currentTrack
    }
  }

  function attachAudioListeners(audio: HTMLAudioElement): () => void {
    const request = deviceRequest
    const handleLoadedMetadata = () => { if (audio !== audioElement) return; updatePlaybackFromAudio(audio); if (r1) report('progress', null, request) }
    const handleTimeUpdate = () => { if (audio !== audioElement) return; updatePlaybackFromAudio(audio); if (r1) report('progress', null, request) }
    const handleEnded = () => {
      if (audio !== audioElement) return
      updatePlaybackFromAudio(audio)
      playback.value = {
        ...playback.value,
        status: 'paused'
      }
      pauseAudioAnalysis()
      if (r1) report('ended', null, request)
    }
    const handleError = () => {
      if (audio !== audioElement) return
      if (r1) report('failed', null, request)
      markMusicError('这首歌暂时播放不了，请重试或选择其他音源。')
    }

    audio.addEventListener('loadedmetadata', handleLoadedMetadata)
    audio.addEventListener('timeupdate', handleTimeUpdate)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('error', handleError)
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('error', handleError)
      if (removeAudioListeners === cleanup) {
        removeAudioListeners = null
      }
    }
    removeAudioListeners = cleanup
    return cleanup
  }

  function releaseAudioResources(): void {
    releaseAudioOutput?.(); releaseAudioOutput = null
    ducking.attach(null)
    removeAudioListeners?.()
    stopAudioAnalysis()
    closeAudioContext()

    if (audioElement) {
      audioElement.pause()
      audioElement.removeAttribute?.('src')
      audioElement = null
    }
  }

  async function startResolvedPlayback(
    nextPlayback: PlaybackState,
    requestId: number
  ): Promise<void> {
    if (requestId !== activePlayRequestId) {
      return
    }

    const track = nextPlayback.track

    if (!track?.audioUrl) {
      markMusicError('找到了歌曲，但暂时没有可播放链接。')
      return
    }

    releaseAudioResources()
    playback.value = {
      ...nextPlayback,
      status: 'loading'
    }
    const createAudioElement = options.createAudioElement ?? (() => new Audio())
    const audio = createAudioElement()
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'
    audio.src = track.audioUrl
    audioElement = audio
    ducking.attach(audio)
    const cleanupAudioListeners = attachAudioListeners(audio)

    try {
      if (options.configureOutput) {
        const release = await options.configureOutput(audio)
        if (requestId !== activePlayRequestId) { release(); audio.pause(); return }
        releaseAudioOutput = release
      }
      await audio.play()
      if (requestId !== activePlayRequestId) {
        cleanupAudioListeners()
        audio.pause()
        audio.removeAttribute?.('src')
        if (audioElement === audio) {
          audioElement = null
        }
        return
      }
      playback.value = {
        ...nextPlayback,
        durationMs: nextPlayback.durationMs,
        positionMs: 0,
        status: 'playing'
      }
      searchResultsVisible.value = false
      await startAudioAnalysis(audio)
    } catch {
      if (requestId === activePlayRequestId) {
        markMusicError('这首歌暂时播放不了，请重试或选择其他音源。')
      }
    }
  }

  async function playRequest(
    keyword: string,
    sourcePreferenceOverride: MusicSourcePreference = sourcePreference.value
  ): Promise<PlaybackState> {
    if (r1) {
      const tracks = await searchMusic(keyword, sourcePreferenceOverride)
      const exact = tracks.filter(track => track.title.trim().toLocaleLowerCase() === keyword.trim().toLocaleLowerCase())
      if (exact.length > 1) { playback.value = { ...playback.value, errorMessage: '找到了同名歌曲，请在搜索结果中选择歌手和版本。' }; return playback.value }
      const track = exact[0] ?? tracks[0]
      if (track) return playSearchResult(track)
      return playback.value
    }
    const requestId = activePlayRequestId + 1
    activePlayRequestId = requestId
    const query = keyword.trim() || '轻松音乐'
    searchQuery.value = query
    sourcePreference.value = sourcePreferenceOverride
    playback.value = {
      durationMs: null,
      positionMs: 0,
      status: 'loading',
      track: null
    }
    const playResult = await invokeMusic<PlaybackState>('music.play', {
      query,
      sourcePreference: sourcePreference.value
    })

    if (requestId !== activePlayRequestId) {
      return playback.value
    }

    if (!playResult.ok) {
      markMusicError(playResult.error.message)
      return playback.value
    }

    if (playResult.data.status === 'error' || !playResult.data.track) {
      markMusicError(playResult.data.errorMessage ?? '没有找到可播放的音乐，请换个关键词或音源再试试。')
      return playback.value
    }

    await startResolvedPlayback(playResult.data, requestId)
    return playback.value
  }

  async function searchAndPlay(
    query: string,
    sourcePreferenceOverride: MusicSourcePreference = sourcePreference.value
  ): Promise<PlaybackState> {
    return playRequest(query, sourcePreferenceOverride)
  }

  async function searchMusic(
    query: string,
    sourcePreferenceOverride: MusicSourcePreference = sourcePreference.value
  ): Promise<MusicTrack[]> {
    const normalizedQuery = query.trim()
    const generation = ++searchGeneration

    if (!normalizedQuery) {
      return []
    }

    searchQuery.value = normalizedQuery
    sourcePreference.value = sourcePreferenceOverride
    if (r1) {
      await ensureBridge()
      const result = await r1.search({ keyword: normalizedQuery, sourcePreference: sourcePreferenceOverride })
      if (generation !== searchGeneration || stopped) return searchResults.value
      musicNotice.value = result.ok ? '' : `音乐搜索暂不可用（${result.error.code}），请重试或切换音源。`
      searchResults.value = result.ok ? result.data : []; searchResultsVisible.value = true
      return searchResults.value
    }
    const searchResult = await invokeMusic<{ tracks: MusicTrack[] }>('music.search', {
      query: normalizedQuery,
      sourcePreference: sourcePreference.value
    })
    if (generation !== searchGeneration || stopped) return searchResults.value

    if (!searchResult.ok) {
      musicNotice.value = `音乐搜索暂不可用（${searchResult.error.code}），请重试或切换音源。`
      searchResults.value = []
      searchResultsVisible.value = true
      return []
    }

    musicNotice.value = ''
    searchResults.value = searchResult.data.tracks
    searchResultsVisible.value = true
    void addSearchHistory(normalizedQuery)
    return searchResults.value
  }

  async function playSearchResult(track: MusicTrack): Promise<PlaybackState> {
    if (r1) {
      if (await ensureBridge() && r1Snapshot) {
        rememberCurrentTrack(track)
        await control('music_play', { trackKey: getTrackKey(track), expectedVersion: r1Snapshot.state.playerVersion })
      }
      return playback.value
    }
    const requestId = activePlayRequestId + 1
    activePlayRequestId = requestId
    rememberCurrentTrack(track)
    searchQuery.value = track.title
    if (track.source) {
      sourcePreference.value = track.source
    }
    const selectedIndex = searchResults.value.findIndex((candidate) => {
      return getTrackKey(candidate) === getTrackKey(track)
    })
    playbackQueue.value = selectedIndex >= 0 ? searchResults.value.slice(selectedIndex + 1) : []
    playback.value = {
      durationMs: null,
      positionMs: 0,
      status: 'loading',
      track: null
    }
    const payload = track.source
      ? {
          album: track.album,
          artist: track.artist,
          artworkId: track.artworkId,
          artworkUrl: track.artworkUrl,
          durationMs: track.durationMs,
          lyricId: track.lyricId,
          playbackId: track.playbackId ?? track.id,
          source: track.source,
          title: track.title,
          trackId: track.id
        }
      : {
          query: track.title,
          sourcePreference: sourcePreference.value
        }
    const playResult = await invokeMusic<PlaybackState>('music.play', payload)

    if (requestId !== activePlayRequestId) {
      return playback.value
    }

    if (!playResult.ok) {
      markMusicError(playResult.error.message)
      return playback.value
    }

    if (playResult.data.status === 'error' || !playResult.data.track) {
      markMusicError(playResult.data.errorMessage ?? '没有找到可播放的音乐，请换个关键词或音源再试试。')
      return playback.value
    }

    await startResolvedPlayback(mergeSelectedTrackMetadata(playResult.data, track), requestId)
    return playback.value
  }

  async function playQueuedTrack(track: MusicTrack, rememberCurrent = true): Promise<PlaybackState> {
    const requestId = activePlayRequestId + 1
    activePlayRequestId = requestId
    if (rememberCurrent) {
      rememberCurrentTrack(track)
    }
    searchQuery.value = track.title
    if (track.source) {
      sourcePreference.value = track.source
    }
    playback.value = {
      durationMs: null,
      positionMs: 0,
      status: 'loading',
      track: null
    }
    const playResult = await invokeMusic<PlaybackState>('music.play', {
      album: track.album,
      artist: track.artist,
      artworkId: track.artworkId,
      artworkUrl: track.artworkUrl,
      durationMs: track.durationMs,
      lyricId: track.lyricId,
      playbackId: track.playbackId ?? track.id,
      source: track.source,
      title: track.title,
      trackId: track.id
    })

    if (requestId !== activePlayRequestId) {
      return playback.value
    }

    if (!playResult.ok) {
      markMusicError(playResult.error.message)
      return playback.value
    }

    if (playResult.data.status === 'error' || !playResult.data.track) {
      markMusicError(playResult.data.errorMessage ?? '没有找到可播放的音乐，请换个关键词或音源再试试。')
      return playback.value
    }

    await startResolvedPlayback(playResult.data, requestId)
    return playback.value
  }

  async function nextTrack(): Promise<PlaybackState> {
    if (r1) { if (await ensureBridge() && r1Snapshot) await control('music_next', { expectedVersion: r1Snapshot.state.playerVersion }); return playback.value }
    const next = playbackQueue.value.shift()

    if (!next) {
      return playback.value
    }

    return playQueuedTrack(next)
  }

  async function previousTrack(): Promise<PlaybackState> {
    if (r1) { const previous = playbackHistory.value.pop(); return previous ? playSearchResult(previous) : playback.value }
    const previous = playbackHistory.value.pop()
    const currentTrack = playback.value.track

    if (!previous) {
      return playback.value
    }

    if (currentTrack) {
      playbackQueue.value = [currentTrack, ...playbackQueue.value]
    }

    return playQueuedTrack(previous, false)
  }

  async function togglePlayback(): Promise<void> {
    if (r1) {
      if (await ensureBridge() && r1Snapshot) await control(r1Snapshot.state.playState === 'playing' || r1Snapshot.state.playState === 'buffering' ? 'music_pause' : 'music_resume', { expectedVersion: r1Snapshot.state.playerVersion })
      return
    }
    const current = playback.value

    if (!current.track) {
      await playRequest(searchQuery.value, sourcePreference.value)
      return
    }

    if (current.status === 'playing') {
      audioElement?.pause()
      playback.value = {
        ...current,
        status: 'paused'
      }
      pauseAudioAnalysis()
      return
    }

    try {
      await audioElement?.play()
      playback.value = {
        ...current,
        status: 'playing'
      }
      if (audioElement) {
        await startAudioAnalysis(audioElement)
      }
    } catch {
      markMusicError('这首歌暂时播放不了，请重试或选择其他音源。')
    }
  }
  async function pauseTrack(trackKey: string): Promise<void> {
    if (r1) {
      if (!await ensureBridge() || !r1Snapshot) return
      const state = r1Snapshot.state
      if (state.track?.trackKey === trackKey && state.playState === 'playing') await control('music_pause', { expectedVersion: state.playerVersion })
      return
    }
    if (getTrackKey(playback.value.track) === trackKey && playback.value.status === 'playing') await togglePlayback()
  }

  function openImmersive(): void {
    viewMode.value = 'music'
  }

  function closeImmersive(): void {
    viewMode.value = 'conversation'
  }

  async function exitPlayback(): Promise<void> {
    if (r1) {
      if (!await ensureBridge() || !r1Snapshot) return
      const result = await r1.exit({ expectedVersion: r1Snapshot.state.playerVersion })
      if (!result.ok) { musicNotice.value = '未能退出播放，请重试。'; return }
      playbackHistory.value = []; searchResults.value = []; searchResultsVisible.value = false
      viewMode.value = 'conversation'; return
    }
    activePlayRequestId += 1
    releaseAudioResources()
    playback.value = createInitialPlayback()
    playbackHistory.value = []
    playbackQueue.value = []
    searchResults.value = []
    searchResultsVisible.value = false
    viewMode.value = 'conversation'
  }

  async function loadLibrary(): Promise<void> {
    if (r1) { await ensureBridge(); const result = await r1.snapshot(); if (result.ok) adopt(result.data); return }
    const result = await invokeMusic<{ favorites: MusicTrack[]; searchHistory: string[] }>(
      'music.getLibrary'
    )

    if (result.ok) {
      favorites.value = result.data.favorites
      searchHistory.value = result.data.searchHistory
    }
  }

  function isFavorite(track: MusicTrack): boolean {
    const key = getTrackKey(track)
    return favorites.value.some((item) => getTrackKey(item) === key)
  }

  async function toggleFavorite(track: MusicTrack, temporarySaveConfirmed = false): Promise<void> {
    if (r1) { await control('music_favorite', { trackKey: getTrackKey(track), favorite: !isFavorite(track) }, temporarySaveConfirmed); return }
    const result = await invokeMusic<MusicTrack[]>('music.toggleFavorite', track)

    if (result.ok) {
      favorites.value = result.data
    }
  }

  async function addSearchHistory(query: string): Promise<void> {
    if (r1) return
    const trimmed = query.trim()

    if (!trimmed) {
      return
    }

    const result = await invokeMusic<string[]>('music.addSearchHistory', { query: trimmed })

    if (result.ok) {
      searchHistory.value = result.data
    }
  }

  function removeSearchHistory(query: string): void {
    searchHistory.value = searchHistory.value.filter((item) => item !== query)
  }

  async function clearSearchHistory(): Promise<void> {
    if (r1) { const result = await r1.clearHistory(); if (result.ok) searchHistory.value = []; return }
    const result = await invokeMusic<string[]>('music.clearSearchHistory')

    if (result.ok) {
      searchHistory.value = result.data
    }
  }

  async function playFavorite(track: MusicTrack): Promise<PlaybackState> {
    if (r1) return playSearchResult(track)
    const index = favorites.value.findIndex((item) => getTrackKey(item) === getTrackKey(track))
    playbackQueue.value = index >= 0 ? favorites.value.slice(index + 1) : []
    return playQueuedTrack(track)
  }

  async function playAllFavorites(temporarySaveConfirmed = false): Promise<PlaybackState> {
    if (r1) {
      if (!await ensureBridge() || !r1Snapshot || !favorites.value.length) return playback.value
      if (!await control('music_queue', { action: 'clear', queueVersion: r1Snapshot.state.queueVersion, trackKeys: [], entryIds: [], orderedEntryIds: [] }, temporarySaveConfirmed)) return playback.value
      if (favorites.value.length > 1 && r1Snapshot && !await control('music_queue', { action: 'add', queueVersion: r1Snapshot.state.queueVersion, trackKeys: favorites.value.slice(1).map(getTrackKey), entryIds: [], orderedEntryIds: [] }, temporarySaveConfirmed)) return playback.value
      return playSearchResult(favorites.value[0])
    }
    const first = favorites.value[0]

    if (!first) {
      return playback.value
    }

    playbackQueue.value = favorites.value.slice(1)
    return playQueuedTrack(first)
  }

  function setActiveTab(tab: 'search' | 'favorite' | 'queue'): void {
    activeTab.value = tab
  }
  async function addToQueue(track: MusicTrack, expectedQueueVersion?: number, temporarySaveConfirmed = false): Promise<void> {
    if (!r1 || !await ensureBridge() || !r1Snapshot) return
    if (queueEntries.value.some(entry => getTrackKey(entry.track) === getTrackKey(track))) { musicNotice.value = '已经在队列中。'; return }
    await control('music_queue', { action: 'add', queueVersion: expectedQueueVersion ?? r1Snapshot.state.queueVersion, trackKeys: [getTrackKey(track)], entryIds: [], orderedEntryIds: [] }, temporarySaveConfirmed)
  }
  async function removeQueue(entryId: string, expectedQueueVersion: number, temporarySaveConfirmed = false): Promise<void> {
    await control('music_queue', { action: 'remove', queueVersion: expectedQueueVersion, trackKeys: [], entryIds: [entryId], orderedEntryIds: [] }, temporarySaveConfirmed)
  }
  async function moveQueue(entryId: string, expectedQueueVersion: number, temporarySaveConfirmed = false): Promise<void> {
    const ordered = queueEntries.value.map(entry => entry.entryId), index = ordered.indexOf(entryId)
    if (index < 1) return
    ;[ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]]
    await control('music_queue', { action: 'reorder', queueVersion: expectedQueueVersion, trackKeys: [], entryIds: [], orderedEntryIds: ordered }, temporarySaveConfirmed)
  }
  async function feedbackAndSkip(track: MusicTrack, feedback: 'skip' | 'dislike', temporarySaveConfirmed = false): Promise<void> {
    const version = r1Snapshot?.state.playerVersion, trackKey = getTrackKey(track)
    if (!await control('music_feedback', { trackKey, feedback, scene: null }, temporarySaveConfirmed)) return
    if (r1Snapshot?.state.playerVersion === version && r1Snapshot?.state.track?.trackKey === trackKey) await nextTrack()
  }

  function dispose(): void { stopped = true; searchGeneration++; stopCommands?.(); stopSnapshots?.(); ducking.dispose(); releaseAudioResources(); if (r1) void r1.detach().catch(() => undefined) }
  if (getCurrentInstance()) onBeforeUnmount(dispose)

  return {
    dispose,
    queueEntries,
    queueVersion, musicNotice,
    addToQueue, removeQueue, moveQueue, feedbackAndSkip,
    seek: async (positionSec: number) => { if (r1 && r1Snapshot?.state.track) await control('music_seek', { trackKey: r1Snapshot.state.track.trackKey, expectedVersion: r1Snapshot.state.playerVersion, positionSec }) },
    feedback: async (track: MusicTrack, feedback: 'like' | 'dislike' | 'skip', temporarySaveConfirmed = false) => control('music_feedback', { trackKey: getTrackKey(track), feedback, scene: null }, temporarySaveConfirmed),
    volume, setVolume, setSpeechActive: (active: boolean) => ducking.setSpeechActive(active),
    activeTab,
    addSearchHistory,
    audioBands,
    audioLevel,
    clearSearchHistory,
    closeImmersive,
    exitPlayback,
    favorites,
    hasActiveTrack,
    isFavorite,
    isPlaying,
    loadLibrary,
    nextTrack,
    openImmersive,
    playAllFavorites,
    playFavorite,
    playSearchResult,
    playRequest,
    playback,
    previousTrack,
    removeSearchHistory,
    searchAndPlay,
    searchHistory,
    searchMusic,
    searchQuery,
    searchResults,
    searchResultsVisible,
    setActiveTab,
    sourcePreference,
    toggleFavorite,
    togglePlayback,
    pauseTrack,
    outputFailed,
    viewMode
  }
}
