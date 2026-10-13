import { computed, getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import type { AppResult } from '@/types/electron-api'
import type { MusicAudioBands, MusicSourcePreference, MusicTrack, PlaybackState, ViewMode } from '@/types/app'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'

type UseMusicOptions = {
  createAudioContext?: () => AudioContext | null
  createAudioElement?: () => HTMLAudioElement
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
    bass: 0.14,
    beat: 0,
    centroid: 0.32,
    flux: 0,
    mid: 0.14,
    treble: 0.14
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
  const viewMode = ref<ViewMode>('conversation')
  const playback = ref<PlaybackState>(createInitialPlayback())
  const audioLevel = ref(0.14)
  const audioBands = ref<MusicAudioBands>(createInitialAudioBands())
  const searchResults = ref<MusicTrack[]>([])
  const searchResultsVisible = ref(false)
  const sourcePreference = ref<MusicSourcePreference>('all')
  const searchQuery = ref('适合此刻的音乐')
  const playbackHistory = ref<MusicTrack[]>([])
  const playbackQueue = ref<MusicTrack[]>([])
  const favorites = ref<MusicTrack[]>([])
  const searchHistory = ref<string[]>([])
  const activeTab = ref<'search' | 'favorite'>('search')
  const audioEnergyRanges = {
    average: createEnergyRange(0.18),
    bass: createEnergyRange(0.14),
    mid: createEnergyRange(0.14),
    treble: createEnergyRange(0.12)
  }
  let analyser: AnalyserNode | null = null
  let audioContext: AudioContext | null = null
  let audioElement: HTMLAudioElement | null = null
  let frequencyData: Uint8Array<ArrayBuffer> | null = null
  let mediaSource: MediaElementAudioSourceNode | null = null
  let previousFrequencyData: Uint8Array<ArrayBuffer> | null = null
  let removeAudioListeners: (() => void) | null = null
  let audioLevelTimer: ReturnType<typeof globalThis.setInterval> | undefined
  let activePlayRequestId = 0
  let fallbackBeatMemory = 0
  let silentAnalysisTicks = 0

  const hasActiveTrack = computed(() => playback.value.track !== null)
  const isPlaying = computed(() => playback.value.status === 'playing')

  function resetAudioEnergyRanges(): void {
    audioEnergyRanges.average = createEnergyRange(0.18)
    audioEnergyRanges.bass = createEnergyRange(0.14)
    audioEnergyRanges.mid = createEnergyRange(0.14)
    audioEnergyRanges.treble = createEnergyRange(0.12)
    fallbackBeatMemory = 0
    silentAnalysisTicks = 0
  }

  function smoothstep(value: number, min: number, max: number): number {
    const normalized = clamp01((value - min) / Math.max(0.0001, max - min))

    return normalized * normalized * (3 - 2 * normalized)
  }

  function emitFallbackAudioBands(): void {
    if (playback.value.status !== 'playing') {
      audioLevel.value = 0.14
      audioBands.value = createInitialAudioBands()
      return
    }

    const audioSeconds = audioElement?.currentTime ?? Number.NaN
    const seconds = Number.isFinite(audioSeconds) && audioSeconds >= 0
      ? audioSeconds
      : performance.now() / 1000
    const beatCarrier = (Math.sin(seconds * Math.PI * 1.72 - Math.PI / 2) + 1) / 2
    const beat = Math.pow(beatCarrier, 4)
    const phrase = (Math.sin(seconds * 0.74 + 0.6) + 1) / 2
    const shimmer = (Math.sin(seconds * 5.8 + Math.sin(seconds * 0.9)) + 1) / 2
    const flux = Math.max(0, beat - fallbackBeatMemory)

    fallbackBeatMemory = beat
    audioLevel.value = Math.min(0.82, 0.24 + beat * 0.28 + phrase * 0.18)
    audioBands.value = {
      bass: Math.min(0.78, 0.24 + beat * 0.42),
      beat: Math.min(0.86, beat * 0.72 + flux * 0.28),
      centroid: 0.34 + shimmer * 0.18,
      flux: Math.min(0.62, flux * 1.8),
      mid: Math.min(0.72, 0.26 + phrase * 0.34 + beat * 0.08),
      treble: Math.min(0.62, 0.18 + shimmer * 0.24 + flux * 0.16)
    }
  }

  function startFallbackAudioLevelTimer(): void {
    clearAudioLevelTimer()
    emitFallbackAudioBands()
    audioLevelTimer = globalThis.setInterval(emitFallbackAudioBands, 80)
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

  function clearAudioLevelTimer(): void {
    if (audioLevelTimer !== undefined) {
      globalThis.clearInterval(audioLevelTimer)
      audioLevelTimer = undefined
    }
  }

  function pauseAudioAnalysis(): void {
    clearAudioLevelTimer()
    audioLevel.value = 0.14
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
        audioLevel.value = 0.14
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
          emitFallbackAudioBands()
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

  function startAudioAnalysis(audio: HTMLAudioElement): void {
    clearAudioLevelTimer()
    resetAudioEnergyRanges()

    if (analyser && frequencyData && mediaSource) {
      startAudioLevelTimer()
      return
    }

    const createAudioContext = options.createAudioContext ?? getDefaultAudioContext
    audioContext = audioContext ?? createAudioContext()

    if (!audioContext) {
      startFallbackAudioLevelTimer()
      return
    }

    try {
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.58
      mediaSource = audioContext.createMediaElementSource(audio)
      mediaSource.connect(analyser)
      analyser.connect(audioContext.destination)
      frequencyData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      previousFrequencyData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      void audioContext.resume?.()
      startAudioLevelTimer()
    } catch {
      stopAudioAnalysis()
      startFallbackAudioLevelTimer()
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
    const handleLoadedMetadata = () => updatePlaybackFromAudio(audio)
    const handleTimeUpdate = () => updatePlaybackFromAudio(audio)
    const handleEnded = () => {
      updatePlaybackFromAudio(audio)
      playback.value = {
        ...playback.value,
        status: 'paused'
      }
      pauseAudioAnalysis()
    }
    const handleError = () => {
      markMusicError('这首歌暂时播放不了，我换一首再试试。')
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
    viewMode.value = 'music'

    const createAudioElement = options.createAudioElement ?? (() => new Audio())
    const audio = createAudioElement()
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'
    audio.src = track.audioUrl
    audioElement = audio
    const cleanupAudioListeners = attachAudioListeners(audio)

    try {
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
      startAudioAnalysis(audio)
    } catch {
      if (requestId === activePlayRequestId) {
        markMusicError('这首歌暂时播放不了，我换一首再试试。')
      }
    }
  }

  async function playRequest(
    keyword: string,
    sourcePreferenceOverride: MusicSourcePreference = sourcePreference.value
  ): Promise<PlaybackState> {
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
    viewMode.value = 'music'

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

    if (!normalizedQuery) {
      return []
    }

    searchQuery.value = normalizedQuery
    sourcePreference.value = sourcePreferenceOverride
    const searchResult = await invokeMusic<{ tracks: MusicTrack[] }>('music.search', {
      query: normalizedQuery,
      sourcePreference: sourcePreference.value
    })

    if (!searchResult.ok) {
      searchResults.value = []
      searchResultsVisible.value = true
      return []
    }

    searchResults.value = searchResult.data.tracks
    searchResultsVisible.value = true
    void addSearchHistory(normalizedQuery)
    return searchResults.value
  }

  async function playSearchResult(track: MusicTrack): Promise<PlaybackState> {
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
    viewMode.value = 'music'

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
    viewMode.value = 'music'

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
    const next = playbackQueue.value.shift()

    if (!next) {
      return playback.value
    }

    return playQueuedTrack(next)
  }

  async function previousTrack(): Promise<PlaybackState> {
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
        startAudioAnalysis(audioElement)
      }
    } catch {
      markMusicError('这首歌暂时播放不了，我换一首再试试。')
    }
  }

  function openImmersive(): void {
    viewMode.value = 'music'
  }

  function closeImmersive(): void {
    viewMode.value = 'conversation'
  }

  async function exitPlayback(): Promise<void> {
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

  async function toggleFavorite(track: MusicTrack): Promise<void> {
    console.log('[lingmo] useMusic.toggleFavorite start', track?.id, track?.title)
    // track 是 Vue reactive Proxy，IPC structured clone 无法序列化，需转普通对象
    const plainTrack = JSON.parse(JSON.stringify(track)) as MusicTrack
    const result = await invokeMusic<MusicTrack[]>('music.toggleFavorite', plainTrack)
    console.log('[lingmo] useMusic.toggleFavorite result', {
      ok: result.ok,
      error: result.ok ? null : result.error,
      dataLen: result.ok ? result.data.length : 0
    })

    if (result.ok) {
      favorites.value = result.data
      console.log('[lingmo] favorites updated, len', favorites.value.length)
    }
  }

  async function addSearchHistory(query: string): Promise<void> {
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
    const result = await invokeMusic<string[]>('music.clearSearchHistory')

    if (result.ok) {
      searchHistory.value = result.data
    }
  }

  async function playFavorite(track: MusicTrack): Promise<PlaybackState> {
    const index = favorites.value.findIndex((item) => getTrackKey(item) === getTrackKey(track))
    playbackQueue.value = index >= 0 ? favorites.value.slice(index + 1) : []
    return playQueuedTrack(track)
  }

  async function playAllFavorites(): Promise<PlaybackState> {
    const first = favorites.value[0]

    if (!first) {
      return playback.value
    }

    playbackQueue.value = favorites.value.slice(1)
    return playQueuedTrack(first)
  }

  function setActiveTab(tab: 'search' | 'favorite'): void {
    activeTab.value = tab
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(releaseAudioResources)
  }

  return {
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
    viewMode
  }
}
