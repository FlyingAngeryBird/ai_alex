import { computed, onBeforeUnmount, ref } from 'vue'
import {
  createVoiceActivityDetector,
  defaultVoiceActivityThresholds,
  type VoiceActivityThresholds
} from '@/services/voiceActivity'

type BrowserWindowWithAudio = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }

type UseAutoListenOptions = {
  canDetect?: () => boolean
  onSpeechEnd?: () => Promise<void> | void
  onSpeechStart?: () => Promise<void> | void
  thresholds?: VoiceActivityThresholds
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return '无法启动麦克风'
}

export function useAutoListen(options: UseAutoListenOptions = {}) {
  const enabled = ref(false)
  const errorMessage = ref('')
  const level = ref(0)
  const detector = createVoiceActivityDetector(options.thresholds ?? defaultVoiceActivityThresholds)

  let analyser: AnalyserNode | null = null
  let audioContext: AudioContext | null = null
  let frameId: number | null = null
  let isHandlingSpeechEnd = false
  let samples: Uint8Array<ArrayBuffer> | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let stream: MediaStream | null = null

  const isSupported = computed(() => {
    const audioWindow = globalThis.window as BrowserWindowWithAudio | undefined

    return Boolean(
      audioWindow &&
        (audioWindow.AudioContext || audioWindow.webkitAudioContext) &&
        globalThis.navigator?.mediaDevices?.getUserMedia
    )
  })

  function cleanupAudioNodes(): void {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }

    source?.disconnect()
    analyser?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
    void audioContext?.close()

    analyser = null
    audioContext = null
    samples = null
    source = null
    stream = null
    detector.reset()
    isHandlingSpeechEnd = false
    level.value = 0
  }

  function readAudioLevel(): number {
    if (!analyser || !samples) {
      return 0
    }

    analyser.getByteTimeDomainData(samples)

    let sum = 0
    for (const sample of samples) {
      const centered = (sample - 128) / 128
      sum += centered * centered
    }

    return Math.min(1, Math.sqrt(sum / samples.length))
  }

  function tick(): void {
    if (!enabled.value) {
      return
    }

    level.value = readAudioLevel()

    if (options.canDetect?.() ?? true) {
      const event = detector.push(level.value, performance.now())

      if (event === 'speech_start') {
        void options.onSpeechStart?.()
      }

      if (event === 'speech_end' && !isHandlingSpeechEnd) {
        isHandlingSpeechEnd = true
        Promise.resolve(options.onSpeechEnd?.()).finally(() => {
          isHandlingSpeechEnd = false
        })
      }
    } else {
      detector.reset()
    }

    frameId = window.requestAnimationFrame(tick)
  }

  async function start(): Promise<boolean> {
    if (enabled.value) {
      return true
    }

    if (!isSupported.value) {
      errorMessage.value = '当前环境不支持自动聆听'
      return false
    }

    try {
      const audioWindow = window as BrowserWindowWithAudio
      const AudioContextConstructor = audioWindow.AudioContext ?? audioWindow.webkitAudioContext

      if (!AudioContextConstructor) {
        errorMessage.value = '当前环境不支持自动聆听'
        return false
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      audioContext = new AudioContextConstructor()
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.72
      samples = new Uint8Array(analyser.fftSize)
      source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)

      detector.reset()
      enabled.value = true
      errorMessage.value = ''
      tick()

      return true
    } catch (error) {
      cleanupAudioNodes()
      errorMessage.value = getErrorMessage(error)
      return false
    }
  }

  function stop(): void {
    enabled.value = false
    cleanupAudioNodes()
  }

  onBeforeUnmount(stop)

  return {
    enabled,
    errorMessage,
    isSupported,
    level,
    start,
    stop
  }
}
