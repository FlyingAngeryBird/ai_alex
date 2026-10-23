# Auto Listen V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic listening usable for real conversation by separating voice activity detection from conversation turn submission.

**Architecture:** Add a small pure state machine for an auto-listening turn, then wire `App.vue` to route VAD events through it. V2.1 keeps existing realtime ASR capture but adds a grace window, turn locking, and clear paused states for TTS, music, and manual Space input.

**Tech Stack:** Vue 3 composables, TypeScript, Vitest, Web Audio VAD.

---

### Task 1: Auto Listen Turn State Machine

**Files:**
- Create: `/Users/sea/Documents/ai_alex/src/services/autoListenSession.ts`
- Test: `/Users/sea/Documents/ai_alex/tests/autoListenSession.test.ts`

- [ ] Add tests for `armed -> prehearing -> recording -> grace -> finalizing -> paused_for_tts -> armed`.
- [ ] Add tests showing short pauses enter `grace` and can resume the same recording.
- [ ] Add tests showing manual Space, music, and TTS pause automatic detection.
- [ ] Implement the minimal pure state machine.

### Task 2: Wire Auto Listen V2 Into App

**Files:**
- Modify: `/Users/sea/Documents/ai_alex/src/App.vue`
- Modify: `/Users/sea/Documents/ai_alex/src/types/app.ts`
- Modify: `/Users/sea/Documents/ai_alex/src/components/ConversationView.vue`
- Test: `/Users/sea/Documents/ai_alex/tests/uiState.test.ts`

- [ ] Extend auto-listen states with `arming`, `prehearing`, `recording`, and `grace`.
- [ ] Replace direct `speech_start -> startVoiceCapture` / `speech_end -> finishVoiceCapture` with session controller events.
- [ ] Keep automatic detection disabled during music, TTS playback, and manual Space input.
- [ ] Add tests checking grace-window markers and paused states are present in the UI wiring.

### Task 3: Verify

**Files:**
- No new files.

- [ ] Run `vitest` targeted tests for auto-listen and UI state.
- [ ] Run full test suite.
- [ ] Run production build.
- [ ] Relaunch Electron for manual testing.
