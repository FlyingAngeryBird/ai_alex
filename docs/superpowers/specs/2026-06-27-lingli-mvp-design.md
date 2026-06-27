# Lingli MVP Design

Date: 2026-06-27
Status: Draft for user review
Platform: macOS first

## 1. Confirmed Product Goal

Lingli is a macOS desktop AI voice companion. When the user opens the app, they see a soft, artistic, animated particle sphere. The user holds Space to speak, releases to send, and Lingli responds with text and voice. The app keeps short-term conversation memory during the current session.

When the user asks for music, Lingli detects the music intent, searches Apple Music, enters an immersive playback view, and keeps the particle sphere moving with the audio or playback state.

## 2. Confirmed Scope

MVP must include:

- macOS Electron desktop app.
- Vue 3 front end with a Three.js particle sphere.
- Hold Space to record, release to send.
- Volcengine ASR for speech recognition.
- Volcengine Ark / Doubao LLM for warm multi-turn conversation.
- Volcengine TTS for AI voice playback.
- Apple Music MusicKit as the primary music provider.
- Music search, playback, pause/resume, return to chat.
- Session memory for recent conversation turns.
- Clear loading, success, and failure states for each user action.

MVP does not include:

- Windows packaging.
- Login/account system beyond Apple Music authorization.
- Long-term memory persisted across app restarts.
- Guaranteed synced lyrics for every song.
- Music collection, playlist management, likes, or recommendations based on saved listening history.

## 3. Key Product Decisions

### 3.1 macOS First

The first release is developed and accepted on macOS only. Windows packaging is a later phase after the core experience is stable.

### 3.2 Volcengine AI Chain

The AI chain uses Volcengine:

- ASR: recording-file recognition first, not streaming ASR.
- LLM: Ark / Doubao chat model.
- TTS: Volcengine TTS, preferably streaming if stable during integration.

The first version prioritizes a reliable push-to-talk flow over real-time interruption.

### 3.3 Apple Music Main Provider

Apple Music MusicKit is the primary music provider. The app must not depend on unofficial NetEase Cloud Music APIs.

MusicKit requirements and limits:

- The user may need to authorize Apple Music.
- Full playback may depend on the user's Apple Music subscription and regional availability.
- Some songs may not be playable.
- Official synced lyric access may not be stable or complete enough for MVP.

Therefore, synced lyrics are an enhancement, not a blocking MVP requirement. If lyrics are unavailable, the immersive page shows song metadata, artwork, playback progress, and Lingli's recommendation text.

## 4. Architecture

The app is split into three layers.

### 4.1 Renderer Front End

Technology:

- Vue 3
- Vite
- Three.js
- Web Audio API

Responsibilities:

- Particle sphere rendering.
- Chat interface.
- Recording interaction states.
- Keyboard handling for Space.
- Music immersive page.
- Playback controls.
- Lyrics display when available.
- Audio spectrum analysis when browser-accessible audio is available.

The renderer must not read cloud secrets or call Volcengine directly.

### 4.2 Electron Main Process

Responsibilities:

- Desktop window lifecycle.
- Environment variable loading.
- IPC request handling.
- Volcengine API calls.
- Apple Music provider bridge where applicable.
- Temporary audio file and cache management.
- Conversation memory.
- Intent routing.
- Error normalization.

The main process acts as the local backend.

### 4.3 External Services

Services:

- Volcengine ASR
- Volcengine Ark / Doubao LLM
- Volcengine TTS
- Apple Music MusicKit / Apple Music API

All external services must be wrapped behind local provider interfaces so they can be replaced later.

## 5. Main Modules

### 5.1 Renderer Modules

- `ParticleSphere`: renders the visual sphere and accepts state/audio inputs.
- `ConversationView`: displays messages and interaction status.
- `RecordingController`: manages key press UI state and calls IPC.
- `MusicImmersiveView`: displays music playback, artwork, progress, lyrics when available, and return control.
- `AudioAnalyser`: converts playable audio into amplitude/frequency values for the particle sphere.

### 5.2 Main Process Modules

- `asrProvider`: sends recorded audio to Volcengine ASR and returns text.
- `llmProvider`: sends messages to Doubao and returns structured assistant output.
- `ttsProvider`: converts assistant text to playable audio.
- `musicProvider`: searches and plays Apple Music content.
- `memoryService`: stores the recent session conversation.
- `intentService`: interprets LLM output and routes music actions.
- `audioCache`: stores temporary recordings and TTS audio.
- `ipcHandlers`: exposes safe capabilities to the renderer.

## 6. IPC Capability Contract

Renderer-to-main calls:

- `voice.startRecording`
- `voice.stopAndTranscribe`
- `chat.sendMessage`
- `tts.speak`
- `music.authorize`
- `music.search`
- `music.play`
- `music.pause`
- `music.resume`
- `music.getPlaybackState`
- `app.getRuntimeState`

Each IPC response must use a consistent shape:

```ts
type AppResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; recoverable: boolean } };
```

## 7. Conversation Flow

1. App opens.
2. Particle sphere enters `idle`.
3. Lingli greets the user with a warm opening line.
4. User holds Space.
5. Front end enters `listening`.
6. User releases Space.
7. Main process sends audio to ASR.
8. Front end enters `thinking`.
9. Main process sends recognized text and memory to LLM.
10. LLM returns structured response.
11. If intent is normal chat, TTS speaks the answer and particle enters `speaking`.
12. If intent is music, app searches Apple Music and enters the music flow.
13. When speaking or playback ends, state returns to `idle` or `playing`.

## 8. LLM Output Contract

The LLM should return structured JSON that the app can route safely:

```json
{
  "reply": "温暖、自然、可播报的回复文本",
  "intent": "chat",
  "music": null
}
```

For music:

```json
{
  "reply": "好，我给你找一首轻松一点的歌。",
  "intent": "play_music",
  "music": {
    "query": "轻松",
    "mood": "relaxed"
  }
}
```

If the model returns invalid JSON, the app treats it as normal chat and logs a recoverable routing error.

## 9. Particle States

Required states:

- `idle`: slow breathing, soft rotation.
- `listening`: brighter, faster, more responsive.
- `thinking`: gathered, pulsing, slightly tighter.
- `speaking`: driven by TTS audio amplitude.
- `playing`: driven by music audio or playback state fallback.
- `error`: calm dim state with visible recovery text.

The particle component must expose a simple input API:

```ts
setVisualState(state: ParticleState): void
setAudioLevel(level: number): void
```

## 10. Music Flow

1. LLM returns `intent: "play_music"`.
2. Main process checks Apple Music authorization.
3. If not authorized, renderer asks the user to authorize.
4. `musicProvider.search(query)` returns candidate songs.
5. The app chooses the best candidate for MVP, usually the first playable result.
6. Renderer enters `MusicImmersiveView`.
7. Playback starts.
8. Lyrics are loaded only if officially available.
9. If lyrics are unavailable, the page shows artwork, metadata, progress, and Lingli's recommendation text.
10. Return button goes back to the chat view and keeps music playing in a compact mini-player.
11. The compact mini-player provides pause/resume and a way to return to the immersive music page.

## 11. Acceptance Gates

### M0 Project Foundation

Goal: create a clean macOS Electron app foundation.

Result:

- Electron + Vue app starts.
- Directory structure is clear.
- Environment variables are ignored by Git.
- IPC can round-trip a test request.

Acceptance:

- The app opens on macOS.
- Renderer cannot access Volcengine secrets.
- `.env` is not committed.
- `.superpowers/` is ignored.

### M1 Particle UI

Goal: create Lingli's core visual identity.

Result:

- A central particle sphere with soft color, breathing, rotation, and state transitions.

Acceptance:

- Supports `idle`, `listening`, `thinking`, `speaking`, and `playing`.
- State transitions are visible and smooth.
- The reference particle HTML is used as visual inspiration.
- UI does not overlap at common macOS laptop sizes.

### M2 Recording and ASR

Goal: convert user speech into text.

Result:

- Hold Space to record.
- Release Space to transcribe with Volcengine ASR.

Acceptance:

- Recording starts only while Space is held.
- Releasing Space sends the audio.
- Mandarin speech returns usable text.
- Failure shows a warm recoverable message.

### M3 LLM and Session Memory

Goal: enable warm multi-turn conversation.

Result:

- User text is sent to Doubao with system prompt and recent context.
- Assistant returns structured output.

Acceptance:

- Five continuous chat turns retain context.
- Tone is warm and natural.
- Music intent can be represented as structured output.
- Invalid model output does not crash the app.

### M4 TTS and Speaking State

Goal: make Lingli speak.

Result:

- Assistant text is converted to speech.
- Audio plays automatically.
- Particle responds to speech.

Acceptance:

- TTS starts after reply generation.
- User can hear the response.
- Particle visibly responds during playback.
- End of playback returns to the correct state.

### M5 Apple Music Intent and Search

Goal: turn music requests into playable search results.

Result:

- Music intent triggers Apple Music search.
- App obtains song metadata and playable state.

Acceptance:

- "播放一首轻松的音乐" triggers music flow.
- Normal conversation does not accidentally trigger music.
- Unauthorized Apple Music state is handled.
- Unplayable song state is handled.

### M6 Immersive Music Page

Goal: deliver the first complete music experience.

Result:

- Music page shows song metadata, artwork, progress, controls, and lyrics if available.

Acceptance:

- Play, pause, resume, and return work.
- Returning to chat keeps playback available in a compact mini-player.
- Particle moves with audio if available, or with a tasteful playback-state fallback.
- Lyrics are synced when official data is available.
- Lack of lyrics does not fail the MVP.

### M7 macOS Packaging

Goal: produce a local macOS build.

Result:

- The app can be packaged and launched outside the dev server.

Acceptance:

- Fresh setup with `.env` can run the app.
- Voice chat flow works.
- Music authorization/search/playback path works where Apple account permissions allow it.

## 12. Error Handling Standards

Every user-facing failure must include:

- What happened in plain language.
- Whether the user can retry.
- A safe fallback when available.

Required error examples:

- Microphone permission denied.
- ASR request failed.
- LLM response failed.
- TTS generation failed.
- Apple Music not authorized.
- Apple Music subscription or region does not allow playback.
- Song has no lyrics.

## 13. Security and Privacy

- Volcengine keys live in `.env` and are read only by the main process.
- The renderer never receives raw cloud credentials.
- Recordings and TTS files are temporary.
- Session memory is in memory only for MVP.
- The app should not persist user conversation history in MVP.

## 14. Testing Strategy

Manual acceptance testing is required for every milestone.

Automated tests should cover:

- Provider response normalization.
- Intent parsing fallback.
- Lyric parsing if an official lyric source is available.
- Memory trimming to the configured recent-turn limit.
- IPC result shape consistency.

Visual verification is required for:

- Particle state transitions.
- Main chat layout.
- Immersive music page layout.
- Small and large macOS window sizes.

## 15. External References

- Volcengine Ark / Doubao Chat API: https://www.volcengine.com/docs/82379/1494384
- Volcengine recording-file ASR: https://www.volcengine.com/docs/6561/1354868
- Volcengine WebSocket TTS: https://www.volcengine.com/docs/6561/2532486
- Apple MusicKit: https://developer.apple.com/musickit/
- Apple Music API: https://developer.apple.com/documentation/applemusicapi
