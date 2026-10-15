import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversation } from '../src/composables/useConversation'
import { useMusic } from '../src/composables/useMusic'

describe('UI prototype state', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('moves through the simulated conversation and detects music intent', async () => {
    vi.stubGlobal('window', {
      lingli: {
        invoke: vi.fn(async () => ({
          ok: true,
          data: {
            intent: 'play_music',
            music: {
              keyword: '轻松音乐'
            },
            reply: '我给你找一首适合放松的音乐。'
          }
        })),
        on: vi.fn(() => () => undefined)
      }
    })
    const conversation = useConversation({ delayMs: 0 })

    conversation.startListening()
    const result = await conversation.stopListening('想听一点音乐')

    expect(result.intent).toBe('play_music')
    expect(conversation.particleState.value).toBe('idle')
    expect(conversation.messages.value.map((message) => message.role)).toEqual([
      'user',
      'assistant'
    ])
  })

  it('drops a stopped reply arriving after the user stops generation', async () => {
    let finish!: (result: unknown) => void
    vi.stubGlobal('window', { lingli: {
      invoke: vi.fn(() => new Promise(resolve => { finish = resolve })),
      on: vi.fn(() => () => undefined)
    } })
    const conversation = useConversation({ delayMs: 0 })
    const pending = conversation.stopListening('请继续')
    conversation.stopCurrentReply()
    finish({ ok: true, data: { intent: 'chat', music: null, reply: '迟到的回答' } })
    expect((await pending).reply).toBe('')
    expect(conversation.messages.value.map(message => message.text)).toEqual(['请继续'])
    expect(conversation.particleState.value).toBe('idle')
  })

  it('does not fabricate assistant replies when the desktop bridge is unavailable', async () => {
    vi.stubGlobal('window', {})
    const conversation = useConversation({ delayMs: 0 })

    conversation.startListening()
    const result = await conversation.stopListening('我今天有点累')

    expect(result.intent).toBe('chat')
    expect(result.music).toBeNull()
    expect(result.reply).toBe('')
    expect(conversation.messages.value.at(-1)).toEqual(
      expect.objectContaining({
        role: 'system',
        text: '对话通道不可用，请重新启动 Seamo AI R1 后再试。'
      })
    )
  })

  it('arms auto listen and pauses it while the assistant speaks', async () => {
    const conversation = useConversation({ delayMs: 0 })

    conversation.toggleAutoListen()
    expect(conversation.autoListenState.value).toBe('armed')

    conversation.startListening()
    expect(conversation.autoListenState.value).toBe('recording')

    await conversation.stopListening('我今天想聊聊天')
    expect(conversation.autoListenState.value).toBe('armed')
    expect(conversation.particleState.value).toBe('idle')
  })

  it('returns to an error state with a clear message when voice capture cannot start', () => {
    const conversation = useConversation({ delayMs: 0 })

    conversation.startListening()
    conversation.markVoiceError('没有拿到麦克风权限，请在系统设置里允许 lingmo 使用麦克风。')

    expect(conversation.isListening.value).toBe(false)
    expect(conversation.particleState.value).toBe('error')
    expect(conversation.messages.value.at(-1)).toEqual(
      expect.objectContaining({
        role: 'system',
        text: '没有拿到麦克风权限，请在系统设置里允许 lingmo 使用麦克风。'
      })
    )
  })

  it('does not send a fallback demo message when the user releases without recognized speech', async () => {
    const conversation = useConversation({ delayMs: 0 })

    const result = await conversation.cancelVoiceInput('刚刚没有识别到声音，请再按住 Space 说一遍。')

    expect(result).toEqual({
      intent: 'chat',
      music: null,
      reply: '刚刚没有识别到声音，请再按住 Space 说一遍。',
      text: ''
    })
    expect(conversation.messages.value.at(-1)).toEqual(
      expect.objectContaining({
        role: 'system',
        text: '刚刚没有识别到声音，请再按住 Space 说一遍。'
      })
    )
  })

  it('can silently cancel filtered automatic listening noise without adding chat history', async () => {
    const conversation = useConversation({ delayMs: 0 })

    conversation.enableAutoListen()
    conversation.startListening()
    const result = await conversation.cancelVoiceInput('我听到一点声音，但不像完整的一句话。', {
      silent: true
    })

    expect(result).toEqual({
      intent: 'chat',
      music: null,
      reply: '我听到一点声音，但不像完整的一句话。',
      text: ''
    })
    expect(conversation.autoListenState.value).toBe('armed')
    expect(conversation.messages.value).toEqual([])
  })

  it('routes automatic listening transcripts through the quality gate without affecting Space mode', () => {
    const app = readFileSync('src/App.vue', 'utf8')

    expect(app).toContain('evaluateAutoListenTranscript')
    expect(app).toContain("activeVoiceInputMode === 'auto_listen'")
    expect(app).toContain('silent: true')
    expect(app).toContain("activeVoiceInputMode = manualCapture ? 'push_to_talk' : 'auto_listen'")
  })

  it('uses a short cooldown after filtered automatic listening so one noise does not loop captures', () => {
    const app = readFileSync('src/App.vue', 'utf8')

    expect(app).toContain('AUTO_LISTEN_REJECTION_COOLDOWN_MS')
    expect(app).toContain('scheduleAutoListenRecovery()')
    expect(app).toContain('clearAutoListenRecoveryTimer()')
    expect(app).toContain("shouldGateAutoTranscript ? scheduleAutoListenRecovery() : recoverAutoListenAfterVoiceCancel()")
    expect(app).toContain("conversation.setAutoListenState('paused_for_tts')")
    expect(app).toContain('autoListenSession.pauseForAssistant()')
  })

  it('exposes automatic listening recovery cooldown through the debug bridge', () => {
    const app = readFileSync('src/App.vue', 'utf8')

    expect(app).toContain('getAutoListenRecoveryMs')
    expect(app).toContain('autoListenRecoveryUntilMs')
    expect(app).toContain('Math.max(0, autoListenRecoveryUntilMs - performance.now())')
  })

  it('uses chat IPC replies when the desktop bridge is available', async () => {
    vi.stubGlobal('window', {
      lingli: {
        invoke: vi.fn(async () => ({
          ok: true,
          data: {
            intent: 'chat',
            music: null,
            reply: '我听见了，我们慢慢聊。'
          }
        })),
        on: vi.fn(() => () => undefined)
      }
    })
    const conversation = useConversation({ delayMs: 0 })

    conversation.startListening()
    const result = await conversation.stopListening('我今天有点累')

    expect(result.reply).toBe('我听见了，我们慢慢聊。')
    expect(conversation.messages.value.at(-1)?.text).toBe('我听见了，我们慢慢聊。')
    expect(globalThis.window.lingli.invoke).toHaveBeenCalledWith('chat.streamMessage', {
      text: '我今天有点累', requestId: expect.any(String)
    })
  })

  it('generates the opening greeting from the current persona instead of a hard-coded assistant name', () => {
    const file = readFileSync('electron/main/ipc/chatHandlers.ts', 'utf8')

    expect(file).toContain("ipc.handle('chat.greeting'")
    expect(file).toContain('getSystemPrompt()')
    expect(file).not.toContain('为桌面语音伙伴 lingmo 生成')
  })

  it('uses whole-reply TTS for main voice playback instead of streaming TTS chunks', () => {
    const file = readFileSync('src/App.vue', 'utf8')
    const finishVoiceCapture = file.slice(
      file.indexOf('async function finishVoiceCapture'),
      file.indexOf('async function finishActiveVoiceCapture')
    )

    expect(finishVoiceCapture).not.toContain('streamingTts.begin')
    expect(finishVoiceCapture).not.toContain('ttsController?.feed')
    expect(finishVoiceCapture).toContain('await speakAssistantReply(result.reply)')
    expect(finishVoiceCapture.indexOf("markVoiceTrace('llm_done')")).toBeLessThan(
      finishVoiceCapture.indexOf('await speakAssistantReply(result.reply)')
    )
  })

  it('documents diagnostic latency fields that separate raw provider timing from user-visible timing', () => {
    const file = readFileSync('src/types/app.ts', 'utf8')

    expect(file).toContain('llm_response_start?: number')
    expect(file).toContain('llm_first_raw_delta?: number')
    expect(file).toContain('llm_first_delta?: number')
    expect(file).toContain('tts_play_invoked?: number')
    expect(file).toContain('tts_play_start?: number')
  })

  it('does not expose demo music wording in the conversation controls', () => {
    const file = readFileSync('src/components/ConversationView.vue', 'utf8')

    expect(file).not.toContain('演示音乐页')
    expect(file).toContain('播放音乐')
  })

  it('does not keep unused demo music tracks in the music state module', () => {
    const file = readFileSync('src/composables/useMusic.ts', 'utf8')

    expect(file).not.toContain('demoTrack')
    expect(file).not.toContain('startDemoTrack')
  })

  it('uses the approved v10 music page controls instead of the old fixed lyric demo', () => {
    const component = readFileSync('src/components/MusicImmersiveView.vue', 'utf8')
    const styles = readFileSync('src/style.css', 'utf8')

    expect(component).toContain('搜索歌曲、歌手或专辑')
    expect(component).toContain('全部')
    expect(component).toContain('netease')
    expect(component).toContain('kuwo')
    expect(component).toContain('joox')
    expect(component).toContain('没有播放成功')
    expect(component).toContain('data-error')
    expect(component).toContain('searchResultsVisible')
    expect(component).toContain('search-result-list')
    expect(component).toContain('displayedLyrics')
    expect(component).toContain('LYRIC_CONTEXT_BEFORE = 8')
    expect(component).toContain('LYRIC_CONTEXT_AFTER = 8')
    expect(component).toContain('targetSize = LYRIC_CONTEXT_BEFORE + LYRIC_CONTEXT_AFTER + 1')
    expect(component).toContain('end = Math.min(lyrics.length, start + targetSize)')
    expect(component).toContain('start = Math.max(0, end - targetSize)')
    expect(component).toContain('track-head')
    expect(component).not.toContain('index === 1')
    expect(component).not.toContain('演示音乐页')
    expect(component).not.toContain('Apple Music')
    expect(styles).toContain('.search-glass')
    expect(styles).toContain('.music-layout-v10')
    expect(styles).toContain('.lyrics')
    expect(styles).toContain('.icon-play-button')
    expect(styles).toContain('.search-glass[data-results="true"]')
    expect(styles).toContain('right: 0.4vw')
    expect(styles).toContain('left: 13.2vw')
    expect(styles).toContain('height: min(680px, 72vh)')
    expect(styles).toContain('overflow: hidden')
    expect(styles).toContain('font-size: clamp(2.45rem, 3.7vw, 4.05rem)')
  })

  it('uses the v11 immersive lyric drift model with the artist under the song title', () => {
    const component = readFileSync('src/components/MusicImmersiveView.vue', 'utf8')
    const styles = readFileSync('src/style.css', 'utf8')

    expect(component).toContain('distance: sourceIndex - currentIndex')
    expect(component).toContain('<TransitionGroup')
    expect(component).toContain('name="lyric-drift"')
    expect(component).toContain(':data-distance="item.distance"')
    expect(component).toContain(`<h2
            class="track-title"
            :data-full-title="playback.track.title"
            :data-truncated="isTrackTitleTruncated"
            :title="playback.track.title"
          >
            {{ displayTrackTitle }}
          </h2>
          <p class="artist">{{ playback.track.artist }}</p>`)
    expect(styles).toContain('.music-layout-v10 .track-head')
    expect(styles).toContain('display: grid')
    expect(styles).toContain('.lyric-drift-move')
    expect(styles).toContain('cubic-bezier(0.22, 0.61, 0.36, 1)')
    expect(styles).toContain('calc(-50% + var(--lyric-distance) * 3.08rem)')
    expect(styles).toContain('.music-layout-v10 .lyric-line[data-distance="0"]')
    expect(styles).toContain('.music-layout-v10 .lyric-line[data-distance="-1"],')
    expect(styles).toContain('.music-layout-v10 .lyric-line[data-distance="1"]')
    expect(styles).toContain('transform: translate3d(0, -50%, 0) scale(1)')
  })

  it('keeps long music titles restrained with hover reveal and caps the search result list', () => {
    const component = readFileSync('src/components/MusicImmersiveView.vue', 'utf8')
    const styles = readFileSync('src/style.css', 'utf8')

    expect(component).toContain('TITLE_PREVIEW_LENGTH = 5')
    expect(component).toContain('displayTrackTitle')
    expect(component).toContain('isTrackTitleTruncated')
    expect(component).toContain('class="track-title"')
    expect(component).toContain(':data-full-title="playback.track.title"')
    expect(component).toContain(':title="playback.track.title"')
    expect(styles).toContain('font-size: clamp(2.45rem, 3.7vw, 4.05rem)')
    expect(styles).toContain('.track-title[data-truncated="true"]::after')
    expect(styles).toContain('max-height: min(330px, 38vh)')
    expect(styles).toContain('overflow-y: auto')
  })

  it('renders previous and next track controls in the music player', () => {
    const component = readFileSync('src/components/MusicImmersiveView.vue', 'utf8')

    expect(component).toContain('previousTrack')
    expect(component).toContain('nextTrack')
    expect(component).toContain("aria-label=\"上一首\"")
    expect(component).toContain("aria-label=\"下一首\"")
    expect(component).toContain("@click=\"$emit('previousTrack')\"")
    expect(component).toContain("@click=\"$emit('nextTrack')\"")
  })

  it('drives music particles from real music audio analysis instead of a fake sine timer', () => {
    const file = readFileSync('src/App.vue', 'utf8')
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(file).toContain('return music.audioLevel.value')
    expect(file).toContain(':audio-bands="music.audioBands.value"')
    expect(particle).toContain('audioBands')
    expect(particle).toContain('bass')
    expect(particle).toContain('mid')
    expect(particle).toContain('treble')
    expect(file).not.toContain('Math.abs(Math.sin(position * 1.7))')
  })

  it('shows voice preparation before waiting and does not label it microphone capture', () => {
    const file = readFileSync('src/App.vue', 'utf8')
    const startCapture = file.slice(
      file.indexOf('async function startVoiceCapture'),
      file.indexOf('async function finishVoiceCapture')
    )

    expect(startCapture.indexOf('voicePreparing.value = true')).toBeLessThan(startCapture.indexOf('await openVoiceCapture('))
    expect(file).toContain('正在准备语音，松开可取消…')
    expect(startCapture.indexOf('await ensureMicrophoneAccess(')).toBeLessThan(startCapture.indexOf('conversation.startListening()'))
    expect(file).toContain("microphoneCapturing ? '正在收音' : '麦克风未开启'")
  })

  it('routes automatic listening through a turn session and grace window', () => {
    const file = readFileSync('src/App.vue', 'utf8')

    expect(file).toContain('createAutoListenSession')
    expect(file).toContain('autoListenSession.speechStart()')
    expect(file).toContain('scheduleAutoListenGraceFinish')
    expect(file).toContain("conversation.setAutoListenState('grace')")
    expect(file).toContain("conversation.setAutoListenState('paused_for_tts')")
    expect(file).toContain('assistantSpeaking: assistantAudioPlaying.value')
    expect(file).toContain('manualVoiceActive: pushToTalk.isBusy() || Boolean(voiceCancelPromise)')
    expect(file).toContain("musicActive: viewMode === 'music'")
  })

  it('passes automatic listening prebuffer audio into realtime ASR startup', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    const autoListen = readFileSync('src/composables/useAutoListen.ts', 'utf8')
    const recorder = readFileSync('src/composables/useRealtimeVoiceRecorder.ts', 'utf8')

    expect(autoListen).toContain('createPcmRingBuffer')
    expect(autoListen).toContain('consumeBufferedAudio')
    expect(app).toContain('autoListen.consumeBufferedAudio()')
    expect(app).toContain('realtimeRecorder.start({ initialAudio, stream: autoListenStream')
    expect(recorder).toContain('initialAudio?: ArrayBuffer')
    expect(recorder).toContain('sendChunk(startOptions.initialAudio')
  })

  it('reuses the auto-listen microphone stream for realtime ASR startup', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    const autoListen = readFileSync('src/composables/useAutoListen.ts', 'utf8')
    const recorder = readFileSync('src/composables/useRealtimeVoiceRecorder.ts', 'utf8')

    expect(autoListen).toContain('getMediaStream')
    expect(app).toContain('autoListen.getMediaStream()')
    expect(app).toContain('stream: autoListenStream')
    expect(recorder).toContain('stream?: MediaStream')
    expect(recorder).toContain('ownsStream')
  })

  it('uses adaptive voice activity thresholds for automatic listening by default', () => {
    const voiceActivity = readFileSync('src/services/voiceActivity.ts', 'utf8')
    const autoListen = readFileSync('src/composables/useAutoListen.ts', 'utf8')

    expect(voiceActivity).toContain('adaptiveNoise: true')
    expect(voiceActivity).toContain('noiseFloorMargin')
    expect(voiceActivity).toContain('getThresholds')
    expect(autoListen).toContain('createVoiceActivityDetector(options.thresholds ?? defaultVoiceActivityThresholds)')
  })

  it('exposes automatic listening diagnostics without showing tuning numbers in the conversation UI', () => {
    const autoListen = readFileSync('src/composables/useAutoListen.ts', 'utf8')
    const conversation = readFileSync('src/components/ConversationView.vue', 'utf8')

    expect(autoListen).toContain('diagnostics')
    expect(autoListen).toContain('detector.getDiagnostics()')
    expect(conversation).not.toContain('noiseFloor')
    expect(conversation).not.toContain('speechStartLevel')
  })

  it('installs a runtime debug bridge for automatic listening diagnostics', () => {
    const app = readFileSync('src/App.vue', 'utf8')

    expect(app).toContain('__lingmoDebug')
    expect(app).toContain('getAutoListenDiagnostics')
    expect(app).toContain('autoListen.diagnostics.value')
    expect(app).toContain('delete debugWindow.__lingmoDebug')
  })

  it('smooths music particle bands so playback feels musical instead of erratic', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(particle).toContain('smoothedMusicBands')
    expect(particle).toContain('updateSmoothedMusicBands')
    expect(particle).toContain('followBand')
    expect(particle).toContain('const musicalBreath')
    expect(particle).toContain('const trebleGlint')
    expect(particle).toContain('bass * 0.018')
    expect(particle).toContain('mid * 0.0048')
    expect(particle).toContain('treble * 0.0012')
    expect(particle).toContain('isPlaying ? 0 : level * 0.026')
    expect(particle).not.toContain('bass * 0.15')
    expect(particle).not.toContain('mid * 0.038')
    expect(particle).not.toContain('treble * 0.012')
  })

  it('uses a layered music motion engine rather than a single music pulse', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(particle).toContain('type MusicMotionState')
    expect(particle).toContain('musicMotion')
    expect(particle).toContain('updateMusicMotion')
    expect(particle).toContain('beatOnset')
    expect(particle).toContain('beatImpulse')
    expect(particle).toContain('beatTravel')
    expect(particle).toContain('melodyPhase')
    expect(particle).toContain('innerLight')
    expect(particle).toContain('innerPresence')
    expect(particle).toContain('glowBloom')
    expect(particle).toContain('ringPhase')
    expect(particle).toContain('trebleAfterglow')
    expect(particle).toContain('bodyBreath')
    expect(particle).toContain('shellFlow')
    expect(particle).toContain('warmth')
    expect(particle).toContain('updateMusicColors')
    expect(particle).toContain('updateMusicGlow')
    expect(particle).toContain('createGlowTexture')
    expect(particle).toContain('new THREE.SpriteMaterial')
    expect(particle).toContain('new THREE.Sprite')
    expect(particle).toContain('MUSIC_LAYER_CORE')
    expect(particle).toContain('MUSIC_LAYER_CLOUD')
    expect(particle).toContain('const deltaSeconds')
    expect(particle).toContain('centroid')
    expect(particle).toContain('flux')
    expect(particle).toContain('beatOnset + flux * 0.36')
    expect(particle).toContain('Math.max(0, bass - musicMotion.previousBass)')
    expect(particle).toContain('const beatDecay')
    expect(particle).toContain('musicMotion.melodyPhase += deltaSeconds *')
    expect(particle).toContain('musicMotion.ringPhase += deltaSeconds *')
    expect(particle).toContain('musicMotion.trebleAfterglow * Math.pow')
    expect(particle).toContain('sphereRotationY += deltaSeconds *')
    expect(particle).toContain('coreGlowMaterial.opacity')
    expect(particle).toContain('innerGlowMaterial.opacity')
    expect(particle).toContain('calculateAuraParticleLight')
    expect(particle).toContain('melodyRibbon')
    expect(particle).toContain('const coreBeatWave')
    expect(particle).toContain('const beatFront')
  })

  it('keeps music particles visibly luminous without shaking the sphere', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(particle).toContain('lanternBreath')
    expect(particle).toContain('lanternWarmth')
    expect(particle).toContain('innerConstellation')
    expect(particle).toContain('perceptualBrightness')
    expect(particle).toContain('musicLightExposure')
    expect(particle).toContain('rotationVelocityY')
    expect(particle).toContain('rotationVelocityX')
    expect(particle).toContain('targetRotationVelocityY')
    expect(particle).toContain('targetRotationTilt')
    expect(particle).toContain('MUSIC_SOFT_LIGHT_CEILING')
    expect(particle).not.toContain('const brightness = clamp01(')
  })

  it('drives music playback with internal beat light instead of whole-sphere jumping', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(particle).toContain('beatGate')
    expect(particle).toContain('resonanceWave')
    expect(particle).toContain('afterglowBands')
    expect(particle).toContain('softCoreBreath')
    expect(particle).toContain('hazeGlow')
    expect(particle).toContain('createDiffuseGlowTexture')
    expect(particle).toContain('outerGlow')
    expect(particle).toContain('const innerRhythmLight')
    expect(particle).toContain('const coreBeatWave')
    expect(particle).toContain('const cloudAfterglow')
    expect(particle).toContain('const shellTint')
    expect(particle).toContain('musicLayerFlow = isPlaying')
    expect(particle).not.toContain("gradient.addColorStop(0, 'rgba(255,255,255,0.92)')")
  })

  it('keeps music beat detection crisp while releasing particle light softly', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')
    const music = readFileSync('src/composables/useMusic.ts', 'utf8')
    const types = readFileSync('src/types/app.ts', 'utf8')

    expect(types).toContain('beat?: number')
    expect(music).toContain('const rawBeat')
    expect(music).toContain('beat: clamp01(rawBeat)')
    expect(particle).toContain('visualBeatRelease')
    expect(particle).toContain('luminousCore')
    expect(particle).toContain('orbitalDrift')
    expect(particle).toContain('const rawBeat = clamp01(props.audioBands.beat ??')
    expect(particle).toContain('rawBeat > current ? 0.22 : 0.045')
    expect(particle).toContain('motion.visualBeatRelease')
    expect(particle).toContain('motion.orbitalDrift')
    expect(particle).not.toContain('motion.beatImpulse * 0.004')
  })

  it('softens the music core light so rhythm reads as glow instead of a hard white dot', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(particle).toContain('MUSIC_SOFT_LIGHT_CEILING')
    expect(particle).toContain('MUSIC_CORE_MILK_MIX')
    expect(particle).toContain('Math.min(MUSIC_SOFT_LIGHT_CEILING')
    expect(particle).toContain("gradient.addColorStop(0, 'rgba(255,255,255,0.44)')")
    expect(particle).toContain("gradient.addColorStop(0.28, 'rgba(255,246,218,0.24)')")
    expect(particle).toContain('const reactor = calculateCoreReactor')
    expect(particle).toContain('const coreOpacity = reactor.opacity')
    expect(particle).toContain('coreGlow.scale.setScalar(reactor.scale)')
    expect(particle).toContain('innerOpacity = clamp01(0.08')
    expect(particle).toContain('MUSIC_CORE_MILK_MIX')
    expect(particle).not.toContain('Math.min(1.72')
    expect(particle).not.toContain("gradient.addColorStop(0, 'rgba(255,255,255,0.58)')")
  })

  it('lights internal music particles in distinct core cloud and shell layers', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')
    const lighting = readFileSync('src/utils/musicParticleLighting.ts', 'utf8')

    expect(particle).toContain('calculateAuraParticleLight')
    expect(particle).toContain('@/utils/musicParticleLighting')
    expect(lighting).toContain('const coreMask')
    expect(lighting).toContain('const cloudMask')
    expect(lighting).toContain('const shellMask')
    expect(lighting).toContain('const layeredBeatLight')
    expect(lighting).toContain('const layeredMelodyLight')
    expect(lighting).toContain('const layeredTrebleLight')
    expect(lighting).toContain('layeredInternalLight')
    expect(particle).toContain('layeredInternalLight *')
    expect(particle).toContain('lerp(musicMilk, layeredInternalLight')
  })

  it('uses a beat-triggered aura pulse queue for musical particle constellations', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')
    const engine = readFileSync('src/utils/musicAuraEngine.ts', 'utf8')
    const lighting = readFileSync('src/utils/musicParticleLighting.ts', 'utf8')

    expect(lighting).toContain('export type MusicAuraPulse')
    expect(engine).toContain('advanceMusicAuraEngine')
    expect(engine).toContain('calculateCoreReactor')
    expect(engine).toContain('beatIntervalSeconds')
    expect(engine).toContain('groups: [mainGroup, secondGroup, thirdGroup]')
    expect(lighting).toContain('calculateAuraParticleLight')
    expect(lighting).toContain('auraPulseLight')
    expect(lighting).toContain('auraMelodyLight')
    expect(lighting).toContain('auraTrebleLight')
    expect(lighting).toContain('auraBloom')
    expect(particle).toContain('musicAuraEngine = createMusicAuraEngineState()')
    expect(particle).toContain('musicAuraEngine = advanceMusicAuraEngine')
    expect(particle).toContain('calculateCoreReactor(musicAuraEngine')
    expect(particle).toContain('pulses: musicAuraEngine.pulses')
    expect(particle).toContain('musicRhythmGroups')
    expect(particle).toContain('group: musicRhythmGroups[index]')
  })

  it('maps music analyser energy through adaptive ranges for visible low-volume rhythm', () => {
    const music = readFileSync('src/composables/useMusic.ts', 'utf8')

    expect(music).toContain('type AudioEnergyRange')
    expect(music).toContain('createEnergyRange')
    expect(music).toContain('updateEnergyRange')
    expect(music).toContain('normalizeEnergy')
    expect(music).toContain('Math.sqrt(normalized)')
    expect(music).toContain('resetAudioEnergyRanges')
    expect(music).toContain('averageFrequencyRange')
    expect(music).toContain('perceivedBass')
    expect(music).toContain('perceivedMid')
    expect(music).toContain('perceivedTreble')
    expect(music).toContain('smoothingTimeConstant = 0.58')
  })

  it('uses melody-flow lighting instead of only song-type rhythm templates', () => {
    const particle = readFileSync('src/components/ParticleSphere.vue', 'utf8')
    const melodyFlow = readFileSync('src/utils/musicMelodyFlow.ts', 'utf8')

    expect(melodyFlow).toContain('advanceMusicMelodyFlow')
    expect(melodyFlow).toContain('calculateMelodyRibbonLight')
    expect(melodyFlow).toContain('directionTarget')
    expect(melodyFlow).toContain('liftTarget')
    expect(particle).toContain('musicMelodyFlow = createMusicMelodyFlowState()')
    expect(particle).toContain('musicMelodyFlow = advanceMusicMelodyFlow')
    expect(particle).toContain('calculateMelodyRibbonLight')
    expect(particle).toContain('ribbonLight * 2.45')
    expect(particle).toContain('ribbonSpark * 2.9')
  })

  it('opens the music immersive view without auto-playing from the main play button', () => {
    const app = readFileSync('src/App.vue', 'utf8')

    expect(app).toContain('music.openImmersive()')
    expect(app).not.toContain("music.playRequest('适合此刻的音乐'")
  })

  it('can append user-visible system messages for business flow errors', () => {
    const conversation = useConversation({ delayMs: 0 })

    conversation.addSystemMessage('找到了歌曲，但暂时没有可播放链接。')

    expect(conversation.messages.value.at(-1)).toEqual(
      expect.objectContaining({
        role: 'system',
        text: '找到了歌曲，但暂时没有可播放链接。'
      })
    )
  })

  it('can generate a dynamic opening greeting through the chat bridge', async () => {
    vi.stubGlobal('window', {
      lingli: {
        invoke: vi.fn(async () => ({
          ok: true,
          data: {
            intent: 'chat',
            music: null,
            reply: '嗨，今天想先安静一下，还是让我陪你聊会儿？'
          }
        }))
      }
    })
    const conversation = useConversation({ delayMs: 0 })

    await conversation.generateOpeningGreeting()

    expect(conversation.messages.value[0]?.text).toBe(
      '嗨，今天想先安静一下，还是让我陪你聊会儿？'
    )
    expect(globalThis.window.lingli.invoke).toHaveBeenCalledWith('chat.greeting')
  })

  it('clears active music and leaves the conversation view when music exits', async () => {
    const audio = createFakeAudioElement()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'music.play') {
        return {
          ok: true,
          data: {
            status: 'playing',
            track: {
              audioUrl: 'https://example.test/evening.mp3',
              id: 'netease-1',
              title: '稻香',
              artist: '周杰伦',
              durationMs: 184000
            },
            positionMs: 0,
            durationMs: 184000
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: '未知通道'
        }
      }
    })
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    await music.playRequest('稻香')
    expect(music.hasActiveTrack.value).toBe(true)

    await music.exitPlayback()

    expect(music.viewMode.value).toBe('conversation')
    expect(music.hasActiveTrack.value).toBe(false)
    expect(music.playback.value.track).toBeNull()
    expect(audio.pause).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('music.pause', undefined)
  })

  it('renders conversation collapse controls and compact action tabs', () => {
    const file = readFileSync('src/components/ConversationView.vue', 'utf8')

    expect(file).toContain('panelCollapsed')
    expect(file).toContain('收起')
    expect(file).toContain('展开')
    expect(file).toContain('compact-action-bar')
  })

  it('uses a softened wave treatment for assistant speaking particles', () => {
    const file = readFileSync('src/components/ParticleSphere.vue', 'utf8')

    expect(file).toContain("const isSpeaking = props.state === 'speaking'")
    expect(file).toContain('const speakingPulse = isSpeaking ? level * 0.045')
    expect(file).toContain('const speakingLateral = isSpeaking ? level * 0.008')
    expect(file).toContain('voiceWave')
  })

  it('keeps real audio-backed music playback state available after leaving immersive view', async () => {
    const audio = createFakeAudioElement()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'music.play') {
        return {
          ok: true,
          data: {
            status: 'playing',
            track: {
              audioUrl: 'https://example.test/evening.mp3',
              id: 'netease-1',
              title: '稻香',
              artist: '周杰伦',
              durationMs: 184000
            },
            positionMs: 0,
            durationMs: 184000
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: '未知通道'
        }
      }
    })
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    expect(music.hasActiveTrack.value).toBe(false)

    await music.playRequest('稻香')
    music.closeImmersive()
    await music.togglePlayback()

    expect(music.viewMode.value).toBe('conversation')
    expect(music.playback.value.track?.title).toBe('稻香')
    expect(music.playback.value.track?.artist).toBe('周杰伦')
    expect(music.playback.value.status).toBe('paused')

    await music.togglePlayback()

    expect(music.playback.value.status).toBe('playing')
    expect(invoke).toHaveBeenCalledWith('music.play', {
      query: '稻香',
      sourcePreference: 'all'
    })
    expect(invoke).not.toHaveBeenCalledWith('music.pause', undefined)
    expect(invoke).not.toHaveBeenCalledWith('music.resume', undefined)
    expect(audio.pause).toHaveBeenCalledTimes(1)
    expect(audio.play).toHaveBeenCalledTimes(2)
  })

  it('starts real audio playback from query-based music play IPC', async () => {
    const audio = createFakeAudioElement()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'music.play') {
        return {
          ok: true,
          data: {
            durationMs: null,
            positionMs: 0,
            status: 'playing',
            track: {
              audioUrl: 'https://example.test/daoxiang.mp3',
              artist: '周杰伦',
              durationMs: 0,
              id: 'joox-1',
              lyrics: [{ timeMs: 1000, text: '第一句' }],
              source: 'joox',
              title: '稻香'
            }
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'UNEXPECTED_CHANNEL',
          message: `不应调用 ${channel}`
        }
      }
    })
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })

    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    await music.playRequest('稻香', 'joox')
    audio.duration = 223
    audio.currentTime = 12.4
    audio.dispatch('loadedmetadata')
    audio.dispatch('timeupdate')

    expect(invoke).toHaveBeenCalledWith('music.play', {
      query: '稻香',
      sourcePreference: 'joox'
    })
    expect(audio.element.src).toBe('https://example.test/daoxiang.mp3')
    expect(audio.play).toHaveBeenCalledTimes(1)
    expect(music.viewMode.value).toBe('conversation')
    expect(music.playback.value.durationMs).toBe(223000)
    expect(music.playback.value.positionMs).toBe(12400)
  })

  it('keeps search results hidden until an explicit search and plays a selected result', async () => {
    const audio = createFakeAudioElement()
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'music.search') {
        return {
          ok: true,
          data: {
            tracks: [
              {
                album: '太阳之子',
                artist: '周杰伦',
                artworkId: 'joox-pic-aiqinghai',
                artworkUrl: 'https://example.test/aiqinghai.jpg',
                durationMs: 214000,
                id: 'joox-aiqinghai',
                lyricId: 'joox-lyric-aiqinghai',
                playbackId: 'joox-url-aiqinghai',
                source: 'joox',
                title: '爱情海'
              },
              {
                artist: '周杰伦',
                durationMs: 209000,
                id: 'netease-coral',
                source: 'netease',
                title: '珊瑚海'
              }
            ]
          }
        }
      }

      if (channel === 'music.play') {
        expect(payload).toMatchObject({
          album: '太阳之子',
          artist: '周杰伦',
          artworkId: 'joox-pic-aiqinghai',
          artworkUrl: 'https://example.test/aiqinghai.jpg',
          durationMs: 214000,
          lyricId: 'joox-lyric-aiqinghai',
          playbackId: 'joox-url-aiqinghai',
          source: 'joox',
          title: '爱情海',
          trackId: 'joox-aiqinghai'
        })

        return {
          ok: true,
          data: {
            durationMs: 214000,
            positionMs: 0,
            status: 'playing',
            track: {
              audioUrl: 'https://example.test/aiqinghai.mp3',
              artist: '周杰伦',
              durationMs: 214000,
              id: 'joox-aiqinghai',
              source: 'joox',
              title: '爱情海'
            }
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'UNEXPECTED_CHANNEL',
          message: `不应调用 ${channel}`
        }
      }
    })
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    expect(music.searchResultsVisible.value).toBe(false)
    expect(music.searchResults.value).toEqual([])

    await music.searchMusic('爱情海', 'joox')

    expect(music.searchResultsVisible.value).toBe(true)
    expect(music.searchResults.value.map((track) => track.title)).toEqual(['爱情海', '珊瑚海'])
    expect(music.playback.value.status).toBe('idle')

    await music.playSearchResult(music.searchResults.value[0])

    expect(music.searchResultsVisible.value).toBe(false)
    expect(music.playback.value.track?.title).toBe('爱情海')
    expect(audio.element.src).toBe('https://example.test/aiqinghai.mp3')
  })

  it('keeps selected search metadata when playback resolves with id-only display fields', async () => {
    const audio = createFakeAudioElement()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'music.search') {
        return {
          ok: true,
          data: {
            tracks: [
              {
                album: '太陽之子',
                artist: '周杰倫',
                artworkId: '2726092be436956b',
                artworkUrl: 'https://image.joox.com/JOOXcover/0/2726092be436956b/500',
                durationMs: 214000,
                id: 'c9SvcsEGhTBjgH9AlCniBA==',
                playbackId: 'c9SvcsEGhTBjgH9AlCniBA==',
                source: 'joox',
                title: '愛琴海'
              }
            ]
          }
        }
      }

      if (channel === 'music.play') {
        return {
          ok: true,
          data: {
            durationMs: 214000,
            positionMs: 0,
            status: 'playing',
            track: {
              audioUrl: 'https://example.test/aiqinghai.mp3',
              artist: '未知歌手',
              durationMs: 214000,
              id: 'c9SvcsEGhTBjgH9AlCniBA==',
              lyrics: [{ timeMs: 1000, text: '蓝白色的房 海风轻推开了窗' }],
              source: 'joox',
              title: 'c9SvcsEGhTBjgH9AlCniBA=='
            }
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'UNEXPECTED_CHANNEL',
          message: `不应调用 ${channel}`
        }
      }
    })
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    await music.searchMusic('爱琴海', 'joox')
    await music.playSearchResult(music.searchResults.value[0])

    expect(music.playback.value.track).toMatchObject({
      album: '太陽之子',
      artist: '周杰倫',
      artworkId: '2726092be436956b',
      artworkUrl: 'https://image.joox.com/JOOXcover/0/2726092be436956b/500',
      audioUrl: 'https://example.test/aiqinghai.mp3',
      id: 'c9SvcsEGhTBjgH9AlCniBA==',
      lyrics: [{ timeMs: 1000, text: '蓝白色的房 海风轻推开了窗' }],
      source: 'joox',
      title: '愛琴海'
    })
  })

  it('moves between previous and next tracks from manual search results', async () => {
    const audioElements = [
      createFakeAudioElement(),
      createFakeAudioElement(),
      createFakeAudioElement()
    ]
    let audioIndex = 0
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'music.search') {
        return {
          ok: true,
          data: {
            tracks: [
              {
                artist: '周杰伦',
                durationMs: 214000,
                id: 'joox-aiqinghai',
                playbackId: 'joox-aiqinghai',
                source: 'joox',
                title: '爱情海'
              },
              {
                artist: '周杰伦',
                durationMs: 198000,
                id: 'joox-qingtian',
                playbackId: 'joox-qingtian',
                source: 'joox',
                title: '晴天'
              }
            ]
          }
        }
      }

      if (channel === 'music.play') {
        const title = (payload as { title?: string }).title ?? '未知'

        return {
          ok: true,
          data: {
            durationMs: 200000,
            positionMs: 0,
            status: 'playing',
            track: {
              audioUrl: `https://example.test/${title}.mp3`,
              artist: '周杰伦',
              durationMs: 200000,
              id: (payload as { trackId?: string }).trackId ?? title,
              source: 'joox',
              title
            }
          }
        }
      }

      return {
        ok: false,
        error: {
          code: 'UNEXPECTED_CHANNEL',
          message: `不应调用 ${channel}`
        }
      }
    })
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audioElements[audioIndex++].element
    })

    await music.searchMusic('周杰伦', 'joox')
    await music.playSearchResult(music.searchResults.value[0])
    await music.nextTrack()

    expect(music.playback.value.track?.title).toBe('晴天')
    expect(audioElements[0].pause).toHaveBeenCalled()

    await music.previousTrack()

    expect(music.playback.value.track?.title).toBe('爱情海')
  })

  it('derives bass, mid, and treble bands from Web Audio frequency data', async () => {
    vi.useFakeTimers()
    const audio = createFakeAudioElement()
    const audioContext = createFakeAudioContext([220, 120, 40, 10])
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        durationMs: null,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/daoxiang.mp3',
          artist: '周杰伦',
          durationMs: 0,
          id: 'joox-1',
          source: 'joox',
          title: '稻香'
        }
      }
    }))
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => audioContext,
      createAudioElement: () => audio.element
    })

    await music.playRequest('稻香', 'joox')
    vi.advanceTimersByTime(90)

    expect(music.audioBands.value.bass).toBeGreaterThan(music.audioBands.value.mid)
    expect(music.audioBands.value.mid).toBeGreaterThan(music.audioBands.value.treble)
    expect(music.audioBands.value.bass).toBeGreaterThan(0.7)

    vi.useRealTimers()
  })

  it('does not invent a rhythm when Web Audio analysis is silent', async () => {
    vi.useFakeTimers()
    const audio = createFakeAudioElement()
    const audioContext = createFakeAudioContext([0, 0, 0, 0])
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        durationMs: null,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/silent-analysis.mp3',
          artist: '测试歌手',
          durationMs: 0,
          id: 'silent-analysis',
          source: 'joox',
          title: '静默频谱'
        }
      }
    }))
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => audioContext,
      createAudioElement: () => audio.element
    })

    await music.playRequest('静默频谱', 'joox')
    vi.advanceTimersByTime(480)
    const firstFallbackBands = { ...music.audioBands.value }

    audio.currentTime = 1.1
    vi.advanceTimersByTime(80)

    expect(audioContext.createAnalyser).toHaveBeenCalledTimes(1)
    expect(firstFallbackBands.bass).toBe(0)
    expect(firstFallbackBands.mid).toBe(0)
    expect(firstFallbackBands.treble).toBe(0)
    expect(music.audioLevel.value).toBe(0)
    expect(music.audioBands.value).toEqual(firstFallbackBands)

    vi.useRealTimers()
  })

  it('pauses, resumes, and exits the real audio element', async () => {
    const audio = createFakeAudioElement()
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        durationMs: null,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/daoxiang.mp3',
          artist: '周杰伦',
          durationMs: 0,
          id: 'joox-1',
          source: 'joox',
          title: '稻香'
        }
      }
    }))
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    await music.playRequest('稻香', 'joox')
    await music.togglePlayback()

    expect(audio.pause).toHaveBeenCalledTimes(1)
    expect(music.playback.value.status).toBe('paused')

    await music.togglePlayback()

    expect(audio.play).toHaveBeenCalledTimes(2)
    expect(music.playback.value.status).toBe('playing')

    await music.exitPlayback()

    expect(audio.pause).toHaveBeenCalledTimes(2)
    expect(music.viewMode.value).toBe('conversation')
    expect(music.playback.value.track).toBeNull()
  })

  it('reuses the Web Audio media source when playback pauses and resumes', async () => {
    const audio = createFakeAudioElement()
    const audioContext = createFakeAudioContext()
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        durationMs: null,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/daoxiang.mp3',
          artist: '周杰伦',
          durationMs: 0,
          id: 'joox-1',
          source: 'joox',
          title: '稻香'
        }
      }
    }))
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => audioContext,
      createAudioElement: () => audio.element
    })

    await music.playRequest('稻香', 'joox')
    await music.togglePlayback()
    await music.togglePlayback()

    expect(audioContext.createMediaElementSource).toHaveBeenCalledTimes(1)
  })

  it('keeps the provider error message when no playable music is found', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        durationMs: null,
        errorMessage: '没有找到可播放的音乐，请换个关键词或音源再试试。',
        positionMs: 0,
        status: 'error',
        track: null
      }
    }))
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic()

    const playback = await music.playRequest('一首暂时没有版权的歌')

    expect(playback.status).toBe('error')
    expect(playback.errorMessage).toBe('没有找到可播放的音乐，请换个关键词或音源再试试。')
    expect(music.playback.value.errorMessage).toBe('没有找到可播放的音乐，请换个关键词或音源再试试。')
  })

  it('keeps the conversation visible while query playback is still resolving', async () => {
    let resolvePlay: (value: unknown) => void = () => undefined
    const pendingPlay = new Promise((resolve) => {
      resolvePlay = resolve
    })
    const audio = createFakeAudioElement()
    const invoke = vi.fn(() => pendingPlay)

    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    const request = music.playRequest('稻香')

    expect(music.viewMode.value).toBe('conversation')
    expect(music.playback.value).toMatchObject({
      durationMs: null,
      positionMs: 0,
      status: 'loading',
      track: null
    })

    resolvePlay({
      ok: true,
      data: {
        durationMs: 180000,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/daoxiang.mp3',
          artist: '周杰伦',
          durationMs: 180000,
          id: 'netease-daoxiang',
          source: 'netease',
          title: '稻香'
        }
      }
    })

    await request
    expect(music.playback.value.status).toBe('playing')
  })

  it('ignores stale music play responses when a newer search has started', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined
    let resolveSecond: (value: unknown) => void = () => undefined
    const firstResult = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const secondResult = new Promise((resolve) => {
      resolveSecond = resolve
    })
    const audio = createFakeAudioElement()
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => firstResult)
      .mockImplementationOnce(() => secondResult)

    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => null,
      createAudioElement: () => audio.element
    })

    const firstRequest = music.playRequest('第一首')
    const secondRequest = music.playRequest('第二首')

    resolveSecond({
      ok: true,
      data: {
        durationMs: 180000,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/second.mp3',
          artist: '周杰伦',
          durationMs: 180000,
          id: 'second',
          source: 'netease',
          title: '第二首'
        }
      }
    })

    await secondRequest

    resolveFirst({
      ok: true,
      data: {
        durationMs: 180000,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/first.mp3',
          artist: '周杰伦',
          durationMs: 180000,
          id: 'first',
          source: 'netease',
          title: '第一首'
        }
      }
    })

    await firstRequest

    expect(music.playback.value.track?.title).toBe('第二首')
    expect(audio.element.src).toBe('https://example.test/second.mp3')
    expect(audio.play).toHaveBeenCalledTimes(1)
  })

  it('closes the Web Audio context when playback exits', async () => {
    const audio = createFakeAudioElement()
    const audioContext = createFakeAudioContext()
    const invoke = vi.fn(async () => ({
      ok: true,
      data: {
        durationMs: null,
        positionMs: 0,
        status: 'playing',
        track: {
          audioUrl: 'https://example.test/daoxiang.mp3',
          artist: '周杰伦',
          durationMs: 0,
          id: 'joox-1',
          source: 'joox',
          title: '稻香'
        }
      }
    }))
    vi.stubGlobal('window', {
      lingli: {
        invoke
      }
    })
    const music = useMusic({
      createAudioContext: () => audioContext,
      createAudioElement: () => audio.element
    })

    await music.playRequest('稻香', 'joox')
    await music.exitPlayback()

    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })
})

type FakeAudioEvent = 'loadedmetadata' | 'timeupdate' | 'ended' | 'error'

function createFakeAudioElement() {
  const listeners = new Map<string, Array<() => void>>()
  const play = vi.fn(async () => undefined)
  const pause = vi.fn()
  const state = {
    currentTime: 0,
    duration: Number.NaN
  }
  const element = {
    crossOrigin: '',
    get currentTime() {
      return state.currentTime
    },
    set currentTime(value: number) {
      state.currentTime = value
    },
    get duration() {
      return state.duration
    },
    pause,
    play,
    preload: '',
    src: '',
    addEventListener: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((candidate) => candidate !== listener)
      )
    })
  } as unknown as HTMLAudioElement

  return {
    element,
    get currentTime() {
      return state.currentTime
    },
    set currentTime(value: number) {
      state.currentTime = value
    },
    get duration() {
      return state.duration
    },
    set duration(value: number) {
      state.duration = value
    },
    dispatch(event: FakeAudioEvent) {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    },
    pause,
    play
  }
}

function createFakeAudioContext(frequencyValues = [10, 20, 30, 40]): AudioContext {
  const analyser = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    fftSize: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: vi.fn((data: Uint8Array) => {
      data.set(frequencyValues)
    }),
    smoothingTimeConstant: 0
  }
  const mediaSource = {
    connect: vi.fn(),
    disconnect: vi.fn()
  }

  return {
    close: vi.fn(async () => undefined),
    createAnalyser: vi.fn(() => analyser),
    createMediaElementSource: vi.fn(() => mediaSource),
    destination: {}
  } as unknown as AudioContext
}
