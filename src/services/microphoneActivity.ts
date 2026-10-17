import { createVoiceActivityDetector, defaultVoiceActivityThresholds } from './voiceActivity'
/** Measures capture audio only; never treats waiting for ASR as active user speech. */
export function monitorMicrophoneActivity(stream: MediaStream, onActivity: (active: boolean) => void,
  createContext: () => AudioContext | null = () => typeof AudioContext === 'undefined' ? null : new AudioContext()): () => void {
  let context: AudioContext | null
  try { context = createContext() } catch { return () => onActivity(false) }
  if (!context) return () => onActivity(false)
  let timer: ReturnType<typeof setInterval> | null = null, source: MediaStreamAudioSourceNode | null = null, analyser: AnalyserNode | null = null
  const detector = createVoiceActivityDetector({ ...defaultVoiceActivityThresholds, adaptiveNoise: false })
  let stopped = false
  const stop = () => { if (stopped) return; stopped = true; if (timer) clearInterval(timer); timer = null; source?.disconnect(); analyser?.disconnect(); void context.close().catch(() => undefined); onActivity(false) }
  try {
    source = context.createMediaStreamSource(stream); analyser = context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    void context.resume().catch(() => undefined)
    timer = setInterval(() => {
      analyser!.getByteTimeDomainData(data)
      let energy = 0; for (const sample of data) energy += ((sample - 128) / 128) ** 2
      detector.push(Math.sqrt(energy / data.length), performance.now()); onActivity(detector.getDiagnostics().speaking)
    }, 20)
  } catch { stop() }
  return stop
}
