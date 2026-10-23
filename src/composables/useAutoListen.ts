import { computed, onBeforeUnmount, ref } from 'vue'
import {
  createVoiceActivityDetector,
  defaultVoiceActivityThresholds,
  type VoiceActivityDiagnostics,
  type VoiceActivityThresholds
} from '../services/voiceActivity'
import { createPcmRingBuffer } from '../services/pcmRingBuffer'

const TARGET_SAMPLE_RATE = 16000
const PREBUFFER_SECONDS = 0.9

type BrowserWindowWithAudio = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }

type UseAutoListenOptions = {
  canDetect?: () => boolean
  onSpeechEnd?: () => Promise<void> | void
  onSpeechStart?: () => Promise<void> | void
  thresholds?: VoiceActivityThresholds
  inputConstraints?: () => MediaTrackConstraints
  onDeviceLost?: () => void
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return '无法启动麦克风'
}

function createInitialDiagnostics(): VoiceActivityDiagnostics {
  return {
    noiseFloor: null,
    speaking: false,
    speechEndLevel: defaultVoiceActivityThresholds.speechEndLevel,
    speechStartLevel: defaultVoiceActivityThresholds.speechStartLevel
  }
}

export function useAutoListen(options: UseAutoListenOptions = {}) {
  const diagnostics = ref<VoiceActivityDiagnostics>(createInitialDiagnostics())
  const enabled = ref(false)
  const errorMessage = ref('')
  const level = ref(0)
  const prebuffer = createPcmRingBuffer({
    maxSamples: Math.round(TARGET_SAMPLE_RATE * PREBUFFER_SECONDS)
  })
  const detector = createVoiceActivityDetector(options.thresholds ?? defaultVoiceActivityThresholds)

  let analyser: AnalyserNode | null = null
  let audioContext: AudioContext | null = null
  let frameId: number | null = null
  let isHandlingSpeechEnd = false
  let prebufferProcessor: ScriptProcessorNode | null = null
  let prebufferSink: GainNode | null = null
  let samples: Uint8Array<ArrayBuffer> | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let stream: MediaStream | null = null
  let lifecycleGeneration = 0

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
    prebufferProcessor?.disconnect()
    prebufferSink?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
    void audioContext?.close()

    analyser = null
    audioContext = null
    samples = null
    source = null
    stream = null
    detector.reset()
    diagnostics.value = createInitialDiagnostics()
    isHandlingSpeechEnd = false
    prebuffer.clear()
    prebufferProcessor = null
    prebufferSink = null
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

  function floatToPcm16(inputSamples: Float32Array): Int16Array {
    const output = new Int16Array(inputSamples.length)

    for (let index = 0; index < inputSamples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, inputSamples[index] ?? 0))
      output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }

    return output
  }

  function downsampleToPcm16(inputSamples: Float32Array, inputSampleRate: number): Int16Array {
    if (inputSampleRate === TARGET_SAMPLE_RATE) {
      return floatToPcm16(inputSamples)
    }

    const ratio = inputSampleRate / TARGET_SAMPLE_RATE
    const outputLength = Math.floor(inputSamples.length / ratio)
    const output = new Float32Array(outputLength)

    for (let index = 0; index < outputLength; index += 1) {
      output[index] = inputSamples[Math.floor(index * ratio)] ?? 0
    }

    return floatToPcm16(output)
  }

  function tick(): void {
    if (!enabled.value) {
      return
    }

    level.value = readAudioLevel()

    if (options.canDetect?.() ?? true) {
      const event = detector.push(level.value, performance.now())
      diagnostics.value = detector.getDiagnostics()

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
      diagnostics.value = detector.getDiagnostics()
    }

    frameId = window.requestAnimationFrame(tick)
  }

  async function start(): Promise<boolean> {
    const generation = ++lifecycleGeneration
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

      const acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: options.inputConstraints?.() ?? {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      if (generation !== lifecycleGeneration) {
        acquiredStream.getTracks().forEach(track => track.stop())
        return false
      }
      stream = acquiredStream
      for (const track of stream.getTracks()) track.addEventListener?.('ended', () => {
        if (generation === lifecycleGeneration) { stop(); options.onDeviceLost?.() }
      }, { once: true })
      audioContext = new AudioContextConstructor()
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.72
      samples = new Uint8Array(analyser.fftSize)
      source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      prebufferProcessor = audioContext.createScriptProcessor(2048, 1, 1)
      prebufferSink = audioContext.createGain()
      prebufferSink.gain.value = 0
      prebufferProcessor.onaudioprocess = (event) => {
        if (!audioContext || !enabled.value) {
          return
        }

        prebuffer.append(downsampleToPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate))
      }
      source.connect(prebufferProcessor)
      prebufferProcessor.connect(prebufferSink)
      prebufferSink.connect(audioContext.destination)

      detector.reset()
      diagnostics.value = detector.getDiagnostics()
      enabled.value = true
      errorMessage.value = ''
      tick()

      return true
    } catch (error) {
      if (generation !== lifecycleGeneration) return false
      cleanupAudioNodes()
      errorMessage.value = getErrorMessage(error)
      return false
    }
  }

  function stop(): void {
    lifecycleGeneration += 1
    enabled.value = false
    cleanupAudioNodes()
  }

  function consumeBufferedAudio(): ArrayBuffer {
    return prebuffer.consumeArrayBuffer()
  }

  function getMediaStream(): MediaStream | null {
    return stream
  }

  onBeforeUnmount(stop)

  return {
    diagnostics,
    enabled,
    errorMessage,
    isSupported,
    level,
    consumeBufferedAudio,
    getMediaStream,
    start,
    stop
  }
}
