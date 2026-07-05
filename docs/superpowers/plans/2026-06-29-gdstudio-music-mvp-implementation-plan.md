# GD Studio Music MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo/Apple Music path with a complete GD Studio music playback flow: search, source fallback, playable URL resolution, real audio playback, synced lyrics, v5 immersive UI, and music-driven particle motion.

**Architecture:** The Electron main process owns GD Studio API calls, source fallback, URL/lyric/artwork normalization, and cache/rate-risk reduction. The Vue renderer owns the real `<audio>` element, playback state, Web Audio analysis, the v5 UI, and current lyric highlighting. IPC stays generic so a future licensed music provider can replace GD Studio without rewriting the UI.

**Tech Stack:** Electron main process, Vue 3 Composition API, TypeScript, Vitest, Web Audio API, GD Studio HTTP API.

---

## Current Baseline

- Branch: `feature/lingli-mvp`
- Baseline command: `npm test`
- Baseline result before implementation: 20 test files, 74 tests passed.
- Worktree state: current branch has existing in-progress app changes, so implementation continues in place to preserve the runnable app state.

## Functional Contract

1. User clicks “播放音乐” or AI returns `intent: "play_music"` with a keyword.
2. Renderer calls `music.play` with `{ query, sourcePreference }`.
3. Main process uses GD Studio source order `netease -> kuwo -> joox` for `all`.
4. Main process searches candidates, skips empty results, resolves URLs, skips empty URLs, fetches artwork and LRC, and returns the first playable track.
5. Renderer creates a real `HTMLAudioElement`, starts playback, updates `PlaybackState` from real media events, and feeds music audio level into `ParticleSphere`.
6. Music page search box can submit a new query and source preference.
7. Pause/resume/exit control the real audio object.
8. Back returns to conversation view while music keeps playing; exit stops audio and clears mini-player state.
9. Lyrics highlight by real `audio.currentTime`; no LRC means song info and recommendation, not fake lyrics.
10. Apple Music provider/config/tests/error copy are removed.

## Files

### Create

- `electron/main/music/gdstudioMusicProvider.ts`
  - GD Studio provider, API calls, source preference handling, candidate fallback, cache, LRC parsing.
- `tests/gdstudioMusicProvider.test.ts`
  - Provider unit tests for fallback, empty URL skip, single-source behavior, LRC/artwork normalization, cache.
- `src/utils/musicLyrics.ts`
  - Renderer utility for current lyric index.
- `tests/musicLyrics.test.ts`
  - Current lyric line tests.

### Modify

- `electron/main/ipc/musicHandlers.ts`
  - Remove Apple Music/demo provider and wire GD Studio provider.
  - Accept query-based play payload and optional source preference.
- `src/types/app.ts`
  - Add music source, source preference, lyric line, playable audio URL fields.
- `src/types/electron-api.d.ts`
  - Keep exposed channels, update payload-compatible comments through types if needed.
- `src/composables/useMusic.ts`
  - Replace simulated timer with real audio element, media events, Web Audio level, source preference/search state.
- `src/components/MusicImmersiveView.vue`
  - Implement v5 UI: top controls, glass search/source selector, small artwork, open lyrics, icon playback button.
- `src/components/MiniPlayer.vue`
  - Keep mini player compatible with real playback and optional artwork.
- `src/App.vue`
  - Pass music search/source handlers to the immersive view and use real music audio level for particles.
- `src/components/ParticleSphere.vue`
  - Tune `playing` state to respond smoothly to real music levels.
- `src/style.css`
  - Replace old music page styles with v5 layout and music-view particle rings.
- `.env.example`
  - Remove Apple Music envs and add GD Studio envs.
- `tests/musicIpc.test.ts`
  - Replace Apple Music tests with GD Studio/default provider tests.
- `tests/uiState.test.ts`
  - Update UI state expectations for real audio/music search flow and remove Apple copy.

## Task 1: GD Studio Provider

**Files:**
- Create: `electron/main/music/gdstudioMusicProvider.ts`
- Modify: `electron/main/ipc/musicHandlers.ts`
- Test: `tests/gdstudioMusicProvider.test.ts`
- Test: `tests/musicIpc.test.ts`

- [ ] **Step 1: Write failing provider tests**

Add tests that prove:

```ts
it('resolves the first playable track by default source order', async () => {
  const fetcher = createFakeGdFetch({
    search: {
      netease: [],
      kuwo: [{ id: 'kuwo-1', name: '稻香', artist: ['周杰伦'], album: '魔杰座', url_id: 'kuwo-1', lyric_id: 'kuwo-1', pic_id: 'pic-1', source: 'kuwo' }],
      joox: [{ id: 'joox-1', name: '稻香', artist: ['周杰倫'], album: '魔杰座', url_id: 'joox-1', lyric_id: 'joox-1', pic_id: 'pic-2', source: 'joox' }]
    },
    urls: {
      'kuwo:kuwo-1': '',
      'joox:joox-1': 'https://example.test/daoxiang.mp3'
    },
    lyrics: {
      'joox:joox-1': '[00:01.00]第一句\\n[00:02.50]第二句'
    },
    pics: {
      'joox:pic-2': 'https://example.test/cover.jpg'
    }
  })

  const provider = createGdStudioMusicProvider({ fetch: fetcher, env: {} })
  await expect(provider.play({ query: '稻香', sourcePreference: 'all' })).resolves.toMatchObject({
    status: 'playing',
    track: {
      id: 'joox-1',
      source: 'joox',
      title: '稻香',
      artist: '周杰倫',
      audioUrl: 'https://example.test/daoxiang.mp3',
      artworkUrl: 'https://example.test/cover.jpg',
      lyrics: [
        { timeMs: 1000, text: '第一句' },
        { timeMs: 2500, text: '第二句' }
      ]
    }
  })
})
```

Also add failing tests for:

- Single source mode only tries that source.
- Empty URL returns `status: "error"` with a clear message.
- Repeated same search uses the cache and does not call search twice inside TTL.
- `createConfiguredMusicProvider({ env: { MUSIC_PROVIDER: "gdstudio" } })` authorizes as `gdstudio`.
- No Apple Music exports or Apple Music error messages remain in `musicHandlers.ts`.

- [ ] **Step 2: Run provider tests and verify RED**

Run:

```bash
npm test -- tests/gdstudioMusicProvider.test.ts tests/musicIpc.test.ts
```

Expected: fail because `createGdStudioMusicProvider` and new payload behavior do not exist yet.

- [ ] **Step 3: Implement provider**

Implement these exported types/functions:

```ts
export type MusicSource = 'netease' | 'kuwo' | 'joox'
export type MusicSourcePreference = 'all' | MusicSource
export type LyricLine = { timeMs: number; text: string }
export type GdStudioProviderOptions = {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  now?: () => number
}
export function parseLrc(lyric: string): LyricLine[]
export function createGdStudioMusicProvider(options?: GdStudioProviderOptions): MusicProvider
```

Provider rules:

- Default source order: `netease`, `kuwo`, `joox`.
- Default API base: `https://music-api.gdstudio.xyz/api.php`.
- Default `br`: `320`.
- Default `count`: `5`.
- Cache TTL default: `300000`.
- A playable returned `MusicTrack` must always contain non-empty `audioUrl`.
- Search response artist arrays join with ` / `.
- `pic_id`, `url_id`, and `lyric_id` are used when present; otherwise fall back to `id`.

- [ ] **Step 4: Run provider tests and verify GREEN**

Run:

```bash
npm test -- tests/gdstudioMusicProvider.test.ts tests/musicIpc.test.ts
```

Expected: all targeted provider/IPC tests pass.

## Task 2: Shared Music Types And Lyric Indexing

**Files:**
- Modify: `src/types/app.ts`
- Create: `src/utils/musicLyrics.ts`
- Test: `tests/musicLyrics.test.ts`

- [ ] **Step 1: Write failing lyric utility tests**

Add tests:

```ts
expect(getCurrentLyricIndex([], 1200)).toBe(-1)
expect(getCurrentLyricIndex([{ timeMs: 1000, text: 'A' }], 999)).toBe(-1)
expect(getCurrentLyricIndex([{ timeMs: 1000, text: 'A' }, { timeMs: 2500, text: 'B' }], 2600)).toBe(1)
```

Also add a type-level usage sample in tests that creates a `MusicTrack` with:

```ts
{
  id: 'joox-1',
  source: 'joox',
  title: '稻香',
  artist: '周杰伦',
  durationMs: 0,
  audioUrl: 'https://example.test/song.mp3',
  lyrics: [{ timeMs: 1000, text: '第一句' }]
}
```

- [ ] **Step 2: Run lyric tests and verify RED**

Run:

```bash
npm test -- tests/musicLyrics.test.ts
```

Expected: fail because utility/type fields do not exist yet.

- [ ] **Step 3: Implement shared types and utility**

Update `src/types/app.ts`:

```ts
export type MusicSource = 'netease' | 'kuwo' | 'joox'
export type MusicSourcePreference = 'all' | MusicSource
export type LyricLine = { timeMs: number; text: string }
```

Update `MusicTrack`:

```ts
source?: MusicSource
audioUrl?: string
lyrics?: LyricLine[]
```

Create:

```ts
export function getCurrentLyricIndex(lines: LyricLine[] | undefined, positionMs: number): number
```

- [ ] **Step 4: Run lyric tests and verify GREEN**

Run:

```bash
npm test -- tests/musicLyrics.test.ts
```

Expected: all lyric utility tests pass.

## Task 3: Real Audio Playback State

**Files:**
- Modify: `src/composables/useMusic.ts`
- Test: `tests/uiState.test.ts`

- [ ] **Step 1: Write failing `useMusic` tests**

Add tests that prove:

- `playRequest('稻香', 'joox')` calls `music.play` with `{ query: '稻香', sourcePreference: 'joox' }`.
- A returned `audioUrl` creates an audio element and calls `play()`.
- `loadedmetadata` and `timeupdate` update `durationMs` and `positionMs`.
- `togglePlayback()` pauses and resumes the real audio object.
- `exitPlayback()` pauses audio, clears state, returns to conversation view.
- `audioLevel` returns a nonzero value while playing when analyser data is available and returns low idle value after exit.

- [ ] **Step 2: Run UI state tests and verify RED**

Run:

```bash
npm test -- tests/uiState.test.ts
```

Expected: fail because `useMusic` still uses a simulated timer and old IPC payload.

- [ ] **Step 3: Implement real audio state**

Change `useMusic` to:

- Keep `sourcePreference = ref<MusicSourcePreference>('all')`.
- Keep `searchQuery = ref('适合此刻的音乐')`.
- Keep `audioLevel = ref(0.14)`.
- Use a real `HTMLAudioElement` for playback.
- Set `audio.crossOrigin = 'anonymous'`.
- Update state from `loadedmetadata`, `timeupdate`, `ended`, `error`.
- Implement `playRequest(keyword, sourcePreferenceOverride?)`.
- Implement `searchAndPlay(query, sourcePreferenceOverride?)`.
- Implement local pause/resume/exit without IPC pause/resume.
- Disconnect analyser/audio nodes on exit or new track.

- [ ] **Step 4: Run UI state tests and verify GREEN**

Run:

```bash
npm test -- tests/uiState.test.ts
```

Expected: all UI state tests pass.

## Task 4: v5 Music Page UI

**Files:**
- Modify: `src/components/MusicImmersiveView.vue`
- Modify: `src/components/MiniPlayer.vue`
- Modify: `src/App.vue`
- Modify: `src/style.css`
- Test: `tests/uiState.test.ts`

- [ ] **Step 1: Write failing UI source tests**

Add tests reading component/CSS files that assert:

- `MusicImmersiveView.vue` contains `搜索歌曲、歌手或专辑`.
- It renders source choices `全部`, `netease`, `kuwo`, `joox`.
- It does not contain `演示音乐页`, `Apple Music`, or fixed `index === 1` lyric highlight.
- `src/style.css` contains v5 layout anchors: `.search-glass`, `.cover-frame`, `.lyrics`, `.icon-play-button`.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
npm test -- tests/uiState.test.ts
```

Expected: fail because current component still uses old demo layout and fixed lyric index.

- [ ] **Step 3: Implement v5 UI**

Use the approved mockup as the layout source:

- Top left: back, playing/paused pill, exit.
- Top right: translucent search field and source chips.
- Bottom stage: small artwork, song title/artist/progress/icon playback, open lyrics column.
- Lyrics use `getCurrentLyricIndex(playback.track.lyrics, playback.positionMs)`.
- Missing lyrics show recommendation and song info, not fake lyric lines.
- Play/pause button is icon-only with accessible label.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run:

```bash
npm test -- tests/uiState.test.ts tests/musicLyrics.test.ts
```

Expected: all targeted UI tests pass.

## Task 5: Particle Music Rhythm

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/ParticleSphere.vue`
- Modify: `src/style.css`
- Test: `tests/uiState.test.ts`

- [ ] **Step 1: Write failing particle-state tests**

Add tests that assert:

- `App.vue` uses `music.audioLevel.value` for music playback instead of a sine-only timer.
- `ParticleSphere.vue` contains a dedicated `playing` palette/config.
- `style.css` contains music-view particle ring styling only under `data-view="music"`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- tests/uiState.test.ts
```

Expected: fail on the current sine-only music audio level or missing v5 ring styling.

- [ ] **Step 3: Implement music rhythm**

Update:

- `App.vue` audio level computed branch: use `music.audioLevel.value` when `particleState === 'playing'`.
- `ParticleSphere.vue`: tune `playing` radius/speed/tightness so real audio level affects radius and local wave without harsh shaking.
- `style.css`: add subtle music-only ring pseudo-elements around `.particle-stage` in music view.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test -- tests/uiState.test.ts
```

Expected: all particle/UI state tests pass.

## Task 6: Environment And Full Verification

**Files:**
- Modify: `.env.example`
- Modify: `docs/superpowers/specs/2026-06-29-gdstudio-music-mvp-design.md`

- [ ] **Step 1: Update docs/config**

Remove Apple Music envs and add:

```env
MUSIC_PROVIDER=gdstudio
GD_MUSIC_API_BASE_URL=https://music-api.gdstudio.xyz/api.php
GD_MUSIC_DEFAULT_BR=320
GD_MUSIC_SEARCH_COUNT=5
GD_MUSIC_CACHE_TTL_MS=300000
```

Update spec/UI text to point to v5 approved design.

- [ ] **Step 2: Run full automated verification**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected:

- All Vitest tests pass.
- Vue typecheck passes.
- Production build completes.

- [ ] **Step 3: Run local app verification**

Run:

```bash
npm run dev
```

Manual acceptance in Electron:

- Click “播放音乐” enters the music page.
- Search `稻香 周杰伦` with `全部` plays a real URL.
- Source chips switch request source.
- Pause/resume control real audio.
- Back returns to conversation while mini player remains.
- Exit stops audio and clears mini player.
- Lyrics move with the real song time when LRC is returned.
- Particle sphere keeps its original body and responds to music.

## Completion Evidence Required

Do not call the feature complete until these are true from current-state evidence:

- `rg -n "Apple Music|MusicKit|APPLE_MUSIC" electron src tests .env.example` has no active Apple Music provider/config/test dependency.
- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- Electron runtime manual check verifies real playback, controls, synced lyrics, and v5 UI.
