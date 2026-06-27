# Lingli MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 macOS 第一版“灵粒”桌面 AI 语音伙伴，实现粒子球主界面、自动监听/按住说话两种语音输入、火山引擎 ASR/LLM/TTS、当前会话记忆、Apple Music 搜索播放和沉浸音乐页。

**Architecture:** 使用 Electron 主进程作为本地后端，Vue 3 渲染层只负责 UI 和交互。火山引擎、Apple Music、会话记忆、音频缓存全部封装在 provider/service 后面，通过统一 IPC 契约暴露给前端。

**Tech Stack:** Electron、electron-vite、Vue 3、TypeScript、Three.js、Vitest、Web Audio API、Volcengine ASR/Ark/TTS、Apple Music MusicKit。

---

## 0. 执行原则

本计划按 M0 到 M7 执行。每个任务必须满足：

- 先建立可验证目标，再写实现。
- 每个任务完成后运行对应测试或人工验收。
- 每个任务单独提交，提交信息清楚。
- 不把火山密钥、Apple Music token、用户录音提交到仓库。
- 发现 Apple Music 官方能力受限时，按规格降级，不临时接入非官方网易云接口。

### 0.1 已确认执行顺序调整

用户已确认采用 Subagent-Driven 执行方式，并要求前端 UI 原型先完成。因此实际执行顺序调整为：

1. Task 1：M0 工程底座。
2. Task 3：Electron 主进程、preload 和安全 IPC 最小壳。
3. Task 4：M1 前端主界面、粒子球、对话区、后续扩展用的状态边界。
4. Task 2：IPC 结果契约和核心服务测试。
5. Task 5-10：按 ASR、LLM、TTS、Apple Music、沉浸音乐页、打包顺序继续。

UI 原型验收通过前，不接入真实火山引擎和 Apple Music。UI 代码必须保留扩展空间：页面状态、粒子状态、对话状态、音乐播放状态分别管理，不把云服务调用写死在组件内部。

## 1. 目标文件结构

最终项目文件结构：

```text
/Users/sea/Documents/ai_alex
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-06-27-lingli-mvp-design.md
│       └── plans/
│           └── 2026-06-27-lingli-mvp-implementation-plan.md
├── electron/
│   ├── main/
│   │   ├── index.ts
│   │   ├── ipc/
│   │   │   ├── appHandlers.ts
│   │   │   ├── chatHandlers.ts
│   │   │   ├── musicHandlers.ts
│   │   │   └── voiceHandlers.ts
│   │   ├── providers/
│   │   │   ├── appleMusicProvider.ts
│   │   │   ├── asrProvider.ts
│   │   │   ├── llmProvider.ts
│   │   │   └── ttsProvider.ts
│   │   ├── services/
│   │   │   ├── audioCache.ts
│   │   │   ├── intentService.ts
│   │   │   ├── memoryService.ts
│   │   │   └── result.ts
│   │   └── env.ts
│   └── preload/
│       └── index.ts
├── src/
│   ├── App.vue
│   ├── main.ts
│   ├── style.css
│   ├── components/
│   │   ├── ConversationView.vue
│   │   ├── MiniPlayer.vue
│   │   ├── MusicImmersiveView.vue
│   │   └── ParticleSphere.vue
│   ├── composables/
│   │   ├── useAudioAnalyser.ts
│   │   ├── useConversation.ts
│   │   ├── useKeyboardRecorder.ts
│   │   └── useMusic.ts
│   ├── types/
│   │   ├── app.ts
│   │   ├── electron-api.d.ts
│   │   └── global.d.ts
│   └── test/
│       └── setup.ts
├── tests/
│   ├── intentService.test.ts
│   ├── memoryService.test.ts
│   ├── result.test.ts
│   └── ipcContract.test.ts
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── vitest.config.ts
├── index.html
├── .env.example
└── .gitignore
```

## 2. 全局类型契约

实现时必须保持这些名称一致。

```ts
export type AppResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export type AppError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type ParticleState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'playing'
  | 'error';

export type ChatIntent = 'chat' | 'play_music';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: number;
};

export type AssistantOutput = {
  reply: string;
  intent: ChatIntent;
  music: null | {
    query: string;
    mood?: string;
  };
};

export type MusicTrack = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  playable: boolean;
};

export type PlaybackState = {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  track: MusicTrack | null;
  positionMs: number;
  durationMs: number | null;
};

export type VoiceInputMode = 'push_to_talk' | 'auto_listen';

export type AutoListenState =
  | 'off'
  | 'armed'
  | 'speech_detected'
  | 'finalizing'
  | 'paused_for_tts'
  | 'error';
```

---

## Task 1: M0 工程底座

**Files:**

- Create: `/Users/sea/Documents/ai_alex/package.json`
- Create: `/Users/sea/Documents/ai_alex/electron.vite.config.ts`
- Create: `/Users/sea/Documents/ai_alex/vite.config.ts`
- Create: `/Users/sea/Documents/ai_alex/vitest.config.ts`
- Create: `/Users/sea/Documents/ai_alex/tsconfig.json`
- Create: `/Users/sea/Documents/ai_alex/tsconfig.node.json`
- Create: `/Users/sea/Documents/ai_alex/index.html`
- Create: `/Users/sea/Documents/ai_alex/.env.example`
- Modify: `/Users/sea/Documents/ai_alex/.gitignore`

- [ ] **Step 1: 初始化 npm 项目依赖**

Run:

```bash
cd /Users/sea/Documents/ai_alex
npm init -y
npm install vue three @vitejs/plugin-vue
npm install -D electron electron-vite typescript vite vitest vue-tsc @types/node
```

Expected: `package.json` 存在，`node_modules/` 被 `.gitignore` 忽略。

- [ ] **Step 2: 写入 package scripts**

`/Users/sea/Documents/ai_alex/package.json` 必须包含：

```json
{
  "name": "lingli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist-electron/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "vue-tsc --noEmit && electron-vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "vue-tsc --noEmit"
  }
}
```

Keep dependency versions produced by npm install.

- [ ] **Step 3: 创建环境变量模板**

Create `/Users/sea/Documents/ai_alex/.env.example`:

```env
VOLCENGINE_ARK_API_KEY=
VOLCENGINE_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
VOLCENGINE_ARK_MODEL=
VOLCENGINE_ASR_APP_ID=
VOLCENGINE_ASR_ACCESS_TOKEN=
VOLCENGINE_TTS_APP_ID=
VOLCENGINE_TTS_ACCESS_TOKEN=
APPLE_MUSIC_DEVELOPER_TOKEN=
```

- [ ] **Step 4: 创建 Electron/Vite 配置**

Create `/Users/sea/Documents/ai_alex/electron.vite.config.ts`:

```ts
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload/index.ts')
      }
    }
  },
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    }
  }
});
```

Create `/Users/sea/Documents/ai_alex/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
```

- [ ] **Step 5: 验收 M0**

Run:

```bash
cd /Users/sea/Documents/ai_alex
npm run typecheck
npm test
git status --short
```

Expected:

- `typecheck` passes after Task 2 creates source files.
- `test` passes after Task 3 creates tests.
- `.env` is ignored.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json electron.vite.config.ts vite.config.ts vitest.config.ts tsconfig.json tsconfig.node.json index.html .env.example .gitignore
git commit -m "chore: scaffold Electron Vue app"
```

---

## Task 2: IPC 结果契约和核心服务测试

**Files:**

- Create: `/Users/sea/Documents/ai_alex/electron/main/services/result.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/services/memoryService.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/services/intentService.ts`
- Create: `/Users/sea/Documents/ai_alex/src/types/app.ts`
- Create: `/Users/sea/Documents/ai_alex/tests/result.test.ts`
- Create: `/Users/sea/Documents/ai_alex/tests/memoryService.test.ts`
- Create: `/Users/sea/Documents/ai_alex/tests/intentService.test.ts`

- [ ] **Step 1: 写 result 测试**

Create `/Users/sea/Documents/ai_alex/tests/result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fail, ok } from '../electron/main/services/result';

describe('AppResult', () => {
  it('wraps success data', () => {
    expect(ok({ value: 1 })).toEqual({ ok: true, data: { value: 1 } });
  });

  it('wraps recoverable failure', () => {
    expect(fail('asr_failed', '语音识别失败，可以再试一次。', true)).toEqual({
      ok: false,
      error: {
        code: 'asr_failed',
        message: '语音识别失败，可以再试一次。',
        recoverable: true
      }
    });
  });
});
```

- [ ] **Step 2: 实现 result**

Create `/Users/sea/Documents/ai_alex/electron/main/services/result.ts`:

```ts
export type AppError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type AppResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export function ok<T>(data: T): AppResult<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string, recoverable = true): AppResult<never> {
  return {
    ok: false,
    error: { code, message, recoverable }
  };
}
```

- [ ] **Step 3: 写 memoryService 测试**

Create `/Users/sea/Documents/ai_alex/tests/memoryService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryService } from '../electron/main/services/memoryService';

describe('memoryService', () => {
  it('keeps the latest turns within the configured limit', () => {
    const memory = createMemoryService(4);
    memory.add('user', '1');
    memory.add('assistant', '2');
    memory.add('user', '3');
    memory.add('assistant', '4');
    memory.add('user', '5');

    expect(memory.getMessages().map((message) => message.content)).toEqual(['2', '3', '4', '5']);
  });

  it('clears session memory', () => {
    const memory = createMemoryService(4);
    memory.add('user', '你好');
    memory.clear();
    expect(memory.getMessages()).toEqual([]);
  });
});
```

- [ ] **Step 4: 实现 memoryService**

Create `/Users/sea/Documents/ai_alex/electron/main/services/memoryService.ts`:

```ts
export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
  createdAt: number;
};

export function createMemoryService(limit = 40) {
  let messages: ChatMessage[] = [];

  return {
    add(role: ChatRole, content: string) {
      messages.push({ role, content, createdAt: Date.now() });
      if (messages.length > limit) {
        messages = messages.slice(messages.length - limit);
      }
    },
    getMessages() {
      return [...messages];
    },
    clear() {
      messages = [];
    }
  };
}
```

- [ ] **Step 5: 写 intentService 测试**

Create `/Users/sea/Documents/ai_alex/tests/intentService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAssistantOutput } from '../electron/main/services/intentService';

describe('intentService', () => {
  it('parses valid chat JSON', () => {
    const output = parseAssistantOutput('{"reply":"你好呀","intent":"chat","music":null}');
    expect(output).toEqual({ reply: '你好呀', intent: 'chat', music: null });
  });

  it('parses valid music JSON', () => {
    const output = parseAssistantOutput('{"reply":"给你找一首","intent":"play_music","music":{"query":"轻松","mood":"relaxed"}}');
    expect(output).toEqual({
      reply: '给你找一首',
      intent: 'play_music',
      music: { query: '轻松', mood: 'relaxed' }
    });
  });

  it('falls back to chat when JSON is invalid', () => {
    const output = parseAssistantOutput('今天辛苦了，我在这儿。');
    expect(output).toEqual({
      reply: '今天辛苦了，我在这儿。',
      intent: 'chat',
      music: null
    });
  });
});
```

- [ ] **Step 6: 实现 intentService**

Create `/Users/sea/Documents/ai_alex/electron/main/services/intentService.ts`:

```ts
export type AssistantOutput = {
  reply: string;
  intent: 'chat' | 'play_music';
  music: null | {
    query: string;
    mood?: string;
  };
};

function isAssistantOutput(value: unknown): value is AssistantOutput {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  const validIntent = data.intent === 'chat' || data.intent === 'play_music';
  const validReply = typeof data.reply === 'string' && data.reply.trim().length > 0;
  if (!validIntent || !validReply) return false;
  if (data.intent === 'chat') return data.music === null;
  if (!data.music || typeof data.music !== 'object') return false;
  return typeof (data.music as Record<string, unknown>).query === 'string';
}

export function parseAssistantOutput(raw: string): AssistantOutput {
  try {
    const parsed = JSON.parse(raw);
    if (isAssistantOutput(parsed)) {
      return parsed;
    }
  } catch {
    return { reply: raw, intent: 'chat', music: null };
  }

  return { reply: raw, intent: 'chat', music: null };
}
```

- [ ] **Step 7: Run tests and commit**

```bash
cd /Users/sea/Documents/ai_alex
npm test
git add electron/main/services/result.ts electron/main/services/memoryService.ts electron/main/services/intentService.ts tests/result.test.ts tests/memoryService.test.ts tests/intentService.test.ts
git commit -m "test: add core service contracts"
```

Expected: all tests pass.

---

## Task 3: Electron 主进程、preload 和安全 IPC

**Files:**

- Create: `/Users/sea/Documents/ai_alex/electron/main/index.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/env.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/ipc/appHandlers.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/preload/index.ts`
- Create: `/Users/sea/Documents/ai_alex/src/types/electron-api.d.ts`
- Create: `/Users/sea/Documents/ai_alex/tests/ipcContract.test.ts`

- [ ] **Step 1: 写 IPC 契约测试**

Create `/Users/sea/Documents/ai_alex/tests/ipcContract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { exposedChannels } from '../electron/preload/index';

describe('preload IPC contract', () => {
  it('exposes only approved channels', () => {
    expect(exposedChannels.sort()).toEqual([
      'app.getRuntimeState',
      'chat.sendMessage',
      'music.authorize',
      'music.getPlaybackState',
      'music.pause',
      'music.play',
      'music.resume',
      'music.search',
      'tts.speak',
      'voice.startRecording',
      'voice.stopAndTranscribe'
    ].sort());
  });
});
```

- [ ] **Step 2: 实现 preload 白名单**

Create `/Users/sea/Documents/ai_alex/electron/preload/index.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';

export const exposedChannels = [
  'voice.startRecording',
  'voice.stopAndTranscribe',
  'chat.sendMessage',
  'tts.speak',
  'music.authorize',
  'music.search',
  'music.play',
  'music.pause',
  'music.resume',
  'music.getPlaybackState',
  'app.getRuntimeState'
] as const;

type Channel = (typeof exposedChannels)[number];

function invoke<T>(channel: Channel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

contextBridge.exposeInMainWorld('lingli', {
  invoke
});
```

- [ ] **Step 3: 创建前端类型声明**

Create `/Users/sea/Documents/ai_alex/src/types/electron-api.d.ts`:

```ts
import type { AppResult } from '../../electron/main/services/result';

type LingliChannel =
  | 'voice.startRecording'
  | 'voice.stopAndTranscribe'
  | 'chat.sendMessage'
  | 'tts.speak'
  | 'music.authorize'
  | 'music.search'
  | 'music.play'
  | 'music.pause'
  | 'music.resume'
  | 'music.getPlaybackState'
  | 'app.getRuntimeState';

declare global {
  interface Window {
    lingli: {
      invoke<T = unknown>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>>;
    };
  }
}

export {};
```

- [ ] **Step 4: 实现 app runtime handler**

Create `/Users/sea/Documents/ai_alex/electron/main/ipc/appHandlers.ts`:

```ts
import { ipcMain } from 'electron';
import { ok } from '../services/result';

export function registerAppHandlers() {
  ipcMain.handle('app.getRuntimeState', () => {
    return ok({
      platform: process.platform,
      ready: true,
      musicProvider: 'apple-music'
    });
  });
}
```

- [ ] **Step 5: 实现 Electron 入口**

Create `/Users/sea/Documents/ai_alex/electron/main/index.ts`:

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { registerAppHandlers } from './ipc/appHandlers';

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#080910',
    title: '灵粒',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerAppHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Step 6: Run verification and commit**

```bash
cd /Users/sea/Documents/ai_alex
npm test
npm run dev
```

Expected:

- Tests pass.
- Electron window opens after Task 4 creates renderer files.

Commit:

```bash
git add electron/main/index.ts electron/main/ipc/appHandlers.ts electron/preload/index.ts src/types/electron-api.d.ts tests/ipcContract.test.ts
git commit -m "feat: add safe Electron IPC shell"
```

---

## Task 4: M1 前端主界面和粒子球

**Files:**

- Create: `/Users/sea/Documents/ai_alex/src/main.ts`
- Create: `/Users/sea/Documents/ai_alex/src/App.vue`
- Create: `/Users/sea/Documents/ai_alex/src/style.css`
- Create: `/Users/sea/Documents/ai_alex/src/components/ParticleSphere.vue`
- Create: `/Users/sea/Documents/ai_alex/src/components/ConversationView.vue`
- Create: `/Users/sea/Documents/ai_alex/src/composables/useConversation.ts`
- Create: `/Users/sea/Documents/ai_alex/src/types/app.ts`

- [ ] **Step 1: 创建前端入口**

Create `/Users/sea/Documents/ai_alex/src/main.ts`:

```ts
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
```

Create `/Users/sea/Documents/ai_alex/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>灵粒</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 创建 app 类型**

Create `/Users/sea/Documents/ai_alex/src/types/app.ts`:

```ts
export type ParticleState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'playing' | 'error';

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
};

export type ViewMode = 'chat' | 'music';
```

- [ ] **Step 3: 创建对话状态 composable**

Create `/Users/sea/Documents/ai_alex/src/composables/useConversation.ts`:

```ts
import { ref } from 'vue';
import type { ParticleState, UiMessage } from '@/types/app';

export function useConversation() {
  const particleState = ref<ParticleState>('idle');
  const statusText = ref('按住空格，和灵粒说话');
  const messages = ref<UiMessage[]>([
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '嗨，我是灵粒。今天想聊点什么，或者只是让我陪你待一会儿也可以。'
    }
  ]);

  function addMessage(role: UiMessage['role'], text: string) {
    messages.value.push({ id: crypto.randomUUID(), role, text });
  }

  return {
    particleState,
    statusText,
    messages,
    addMessage
  };
}
```

- [ ] **Step 4: 创建粒子球组件**

Implementation requirement:

- Port visual ideas from `/Users/sea/Documents/ai_alex/粒子UI效果参考.html`.
- Use `THREE.BufferGeometry`.
- Expose props: `state`, `audioLevel`.
- Keep first version simple enough to run smoothly.

Create `/Users/sea/Documents/ai_alex/src/components/ParticleSphere.vue` with these public props:

```ts
const props = defineProps<{
  state: ParticleState;
  audioLevel: number;
}>();
```

Visual acceptance:

- `idle`: soft breathing.
- `listening`: brighter and faster.
- `thinking`: tighter pulse.
- `speaking`: radius reacts to `audioLevel`.
- `playing`: wider rhythmic pulse.
- `error`: dim and calm.

- [ ] **Step 5: 创建对话视图组件**

Create `/Users/sea/Documents/ai_alex/src/components/ConversationView.vue`:

```vue
<script setup lang="ts">
import type { UiMessage } from '@/types/app';

defineProps<{
  messages: UiMessage[];
  statusText: string;
}>();
</script>

<template>
  <section class="conversation" aria-label="对话">
    <div class="messages">
      <article v-for="message in messages" :key="message.id" :class="['message', message.role]">
        {{ message.text }}
      </article>
    </div>
    <div class="status">{{ statusText }}</div>
  </section>
</template>
```

- [ ] **Step 6: 组合 App.vue**

Create `/Users/sea/Documents/ai_alex/src/App.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import ParticleSphere from '@/components/ParticleSphere.vue';
import ConversationView from '@/components/ConversationView.vue';
import { useConversation } from '@/composables/useConversation';

const audioLevel = ref(0);
const { particleState, statusText, messages } = useConversation();
</script>

<template>
  <main class="shell">
    <ParticleSphere :state="particleState" :audio-level="audioLevel" />
    <ConversationView :messages="messages" :status-text="statusText" />
  </main>
</template>
```

- [ ] **Step 7: 创建基础 CSS**

Create `/Users/sea/Documents/ai_alex/src/style.css`:

```css
* {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: radial-gradient(circle at center, #11121c 0%, #090a10 62%, #05060a 100%);
  color: #fff;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}

.shell {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
}

.conversation {
  position: fixed;
  left: 50%;
  bottom: 36px;
  width: min(760px, calc(100vw - 48px));
  transform: translateX(-50%);
  display: grid;
  gap: 14px;
}

.messages {
  display: grid;
  gap: 10px;
  max-height: 200px;
  overflow: hidden;
}

.message {
  width: fit-content;
  max-width: min(620px, 100%);
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  line-height: 1.6;
}

.message.user {
  justify-self: end;
  background: rgba(93, 177, 255, 0.16);
}

.status {
  justify-self: center;
  color: rgba(255, 255, 255, 0.68);
  font-size: 14px;
}
```

- [ ] **Step 8: 验收 M1**

Run:

```bash
cd /Users/sea/Documents/ai_alex
npm run typecheck
npm run dev
```

Manual acceptance:

- macOS 窗口打开。
- 中央出现动态粒子球。
- 底部有温暖开场白。
- 窗口缩放到 900x640 时不重叠。

Commit:

```bash
git add src index.html
git commit -m "feat: add Lingli particle chat shell"
```

---

## Task 5: M2 语音输入和火山 ASR

**Files:**

- Create: `/Users/sea/Documents/ai_alex/electron/main/providers/asrProvider.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/services/audioCache.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/services/voiceActivityService.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/ipc/voiceHandlers.ts`
- Create: `/Users/sea/Documents/ai_alex/src/composables/useKeyboardRecorder.ts`
- Create: `/Users/sea/Documents/ai_alex/src/composables/useAutoListen.ts`
- Modify: `/Users/sea/Documents/ai_alex/electron/main/index.ts`
- Modify: `/Users/sea/Documents/ai_alex/src/App.vue`

- [ ] **Step 1: 实现 audioCache**

Create `/Users/sea/Documents/ai_alex/electron/main/services/audioCache.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function writeTempAudio(buffer: Buffer, extension = 'webm') {
  const dir = join(tmpdir(), 'lingli-audio');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${Date.now()}-${crypto.randomUUID()}.${extension}`);
  await writeFile(filePath, buffer);
  return filePath;
}
```

- [ ] **Step 2: 实现 ASR provider**

Create `/Users/sea/Documents/ai_alex/electron/main/providers/asrProvider.ts`.

Implementation notes:

- Read `VOLCENGINE_ASR_APP_ID` and `VOLCENGINE_ASR_ACCESS_TOKEN`.
- Send recorded file to Volcengine recording-file ASR API.
- Add a provider boundary for realtime ASR: `startRealtimeAsr()` and `stopRealtimeAsr()` can initially return `realtime_asr_not_configured`, but the IPC and UI state must already be shaped for streaming integration.
- Normalize all errors with `fail('asr_failed', '我刚刚没听清，可以再说一次吗？', true)`.
- If credentials are missing, return `fail('asr_not_configured', '语音识别还没有配置火山引擎密钥。', false)`.

- [ ] **Step 2A: 实现语音活动检测服务**

Create `/Users/sea/Documents/ai_alex/electron/main/services/voiceActivityService.ts`.

Behavior:

- Expose thresholds for `speechStartLevel`, `speechEndLevel`, and `silenceMs`.
- The renderer may perform local volume detection first, but the thresholds must live in one shared service/config so future native audio or streaming ASR can reuse them.
- Default MVP thresholds:
  - speechStartLevel: `0.08`
  - speechEndLevel: `0.035`
  - silenceMs: `900`

- [ ] **Step 3: 实现 voice IPC**

Create `/Users/sea/Documents/ai_alex/electron/main/ipc/voiceHandlers.ts`:

```ts
import { ipcMain } from 'electron';
import { fail, ok } from '../services/result';
import { transcribeAudioFile } from '../providers/asrProvider';
import { writeTempAudio } from '../services/audioCache';

export function registerVoiceHandlers() {
  ipcMain.handle('voice.startRecording', () => {
    return ok({ recording: true });
  });

  ipcMain.handle('voice.startRealtime', () => {
    return ok({ mode: 'auto_listen', state: 'armed' });
  });

  ipcMain.handle('voice.stopRealtime', () => {
    return ok({ mode: 'auto_listen', state: 'off' });
  });

  ipcMain.handle('voice.setAutoListen', (_event, payload: { enabled: boolean }) => {
    return ok({ enabled: Boolean(payload?.enabled) });
  });

  ipcMain.handle('voice.stopAndTranscribe', async (_event, payload: { audio: ArrayBuffer; extension?: string }) => {
    if (!payload?.audio) {
      return fail('empty_audio', '我没有收到声音，可以再试一次吗？', true);
    }

    const filePath = await writeTempAudio(Buffer.from(payload.audio), payload.extension ?? 'webm');
    return transcribeAudioFile(filePath);
  });
}
```

Modify `/Users/sea/Documents/ai_alex/electron/main/index.ts`:

```ts
import { registerVoiceHandlers } from './ipc/voiceHandlers';

app.whenReady().then(() => {
  registerAppHandlers();
  registerVoiceHandlers();
  createWindow();
});
```

- [ ] **Step 4: 实现前端录音 composable**

Create `/Users/sea/Documents/ai_alex/src/composables/useKeyboardRecorder.ts`.

Behavior:

- On Space keydown: request microphone, start `MediaRecorder`.
- On Space keyup: stop recorder, send Blob ArrayBuffer to `voice.stopAndTranscribe`.
- Prevent repeated keydown from starting multiple recorders.
- Update particle state and status text.

- [x] **Step 4A: 实现自动聆听 composable**

Create `/Users/sea/Documents/ai_alex/src/composables/useAutoListen.ts`.

Behavior:

- User can toggle auto listen on/off.
- When enabled, request microphone permission and connect the stream to `AnalyserNode`.
- If volume stays above `speechStartLevel` for a short debounce window, set state to `speech_detected` and particle to `listening`.
- If volume stays below `speechEndLevel` for `silenceMs`, finalize the current utterance and call the same ASR/chat pipeline used by push-to-talk.
- While TTS is playing, set state to `paused_for_tts` and do not capture AI output.
- If microphone permission fails, return a recoverable message and keep push-to-talk available.

Current implementation note:

- 已新增 `/Users/sea/Documents/ai_alex/src/services/voiceActivity.ts`，用可测试的语音活动检测器判断 `speech_start` / `speech_end`。
- 已新增 `/Users/sea/Documents/ai_alex/src/composables/useAutoListen.ts`，负责麦克风权限、音量采样、自动聆听开关和清理资源。
- 已接入 `/Users/sea/Documents/ai_alex/src/App.vue` 原型状态机；当前版本自动结束后仍使用模拟文本，等 Step 4 / 火山 ASR 完成后接入真实识别文本。

- [ ] **Step 5: 验收 M2**

Run:

```bash
cd /Users/sea/Documents/ai_alex
npm run typecheck
npm run dev
```

Manual acceptance:

- 手动模式：按住空格时状态变成“正在聆听”。
- 手动模式：松开空格后状态变成“正在理解”。
- 自动模式：开启自动聆听后，开口说话能进入“正在聆听”，停顿后自动进入“正在理解”。
- TTS 播放时自动聆听暂停，播报结束后恢复到 armed 状态。
- 火山 ASR 返回的中文文本出现在对话区。
- 关闭麦克风权限时显示可恢复提示。

Commit:

```bash
git add electron/main/providers/asrProvider.ts electron/main/services/audioCache.ts electron/main/services/voiceActivityService.ts electron/main/ipc/voiceHandlers.ts electron/main/index.ts src/composables/useKeyboardRecorder.ts src/composables/useAutoListen.ts src/App.vue
git commit -m "feat: add voice input ASR flow"
```

---

## Task 6: M3 豆包 LLM 和会话记忆

**Files:**

- Create: `/Users/sea/Documents/ai_alex/electron/main/providers/llmProvider.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/ipc/chatHandlers.ts`
- Modify: `/Users/sea/Documents/ai_alex/electron/main/index.ts`
- Modify: `/Users/sea/Documents/ai_alex/src/composables/useConversation.ts`

- [ ] **Step 1: 实现 LLM provider**

Create `/Users/sea/Documents/ai_alex/electron/main/providers/llmProvider.ts`.

Requirements:

- Use `VOLCENGINE_ARK_API_KEY`, `VOLCENGINE_ARK_BASE_URL`, `VOLCENGINE_ARK_MODEL`.
- Send system prompt plus `memoryService.getMessages()`.
- System prompt must require warm tone and structured JSON output.
- Return raw assistant content to `intentService.parseAssistantOutput`.
- Missing credentials returns `llm_not_configured`.

System prompt:

```text
你是“灵粒”，一个温暖、真诚、有边界感的桌面 AI 语音伙伴。
你会用自然、适合语音播报的中文回复用户。
你需要识别用户是否想播放音乐。
必须尽量只返回 JSON，不要 Markdown，不要代码块。
普通聊天格式：
{"reply":"回复文本","intent":"chat","music":null}
音乐意图格式：
{"reply":"回复文本","intent":"play_music","music":{"query":"搜索关键词","mood":"情绪，可省略"}}
```

- [ ] **Step 2: 实现 chat IPC**

Create `/Users/sea/Documents/ai_alex/electron/main/ipc/chatHandlers.ts`.

Behavior:

- Accept `{ text: string }`.
- Add user message to memory.
- Call LLM.
- Parse assistant output.
- Add assistant reply to memory.
- Return structured `AssistantOutput`.

- [ ] **Step 3: 前端串起 ASR -> chat**

Modify `/Users/sea/Documents/ai_alex/src/composables/useConversation.ts`.

Behavior:

- `sendUserText(text)` adds user bubble.
- Calls `chat.sendMessage`.
- Adds assistant bubble from `reply`.
- If `intent === 'play_music'`, emits music request to App.

- [ ] **Step 4: 验收 M3**

Manual acceptance:

- 连续聊天 5 轮，AI 能引用前文。
- “播放一首轻松的音乐”返回 `play_music` 意图。
- 普通聊天不误触发音乐。
- LLM 返回非法 JSON 时仍显示普通回复。

Commit:

```bash
git add electron/main/providers/llmProvider.ts electron/main/ipc/chatHandlers.ts electron/main/index.ts src/composables/useConversation.ts
git commit -m "feat: add Doubao chat memory flow"
```

---

## Task 7: M4 火山 TTS 和音频联动

**Files:**

- Create: `/Users/sea/Documents/ai_alex/electron/main/providers/ttsProvider.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/ipc/ttsHandlers.ts`
- Create: `/Users/sea/Documents/ai_alex/src/composables/useAudioAnalyser.ts`
- Modify: `/Users/sea/Documents/ai_alex/electron/main/index.ts`
- Modify: `/Users/sea/Documents/ai_alex/src/App.vue`
- Modify: `/Users/sea/Documents/ai_alex/src/components/ParticleSphere.vue`

- [ ] **Step 1: 实现 TTS provider**

Create `/Users/sea/Documents/ai_alex/electron/main/providers/ttsProvider.ts`.

Requirements:

- Use Volcengine TTS credentials from `.env`.
- Accept text.
- Return a local playable audio URL or base64 audio payload.
- Missing credentials returns `tts_not_configured`.
- Network failure returns `tts_failed` with message `我这次没能发出声音，但文字回复还在。`

- [ ] **Step 2: 实现 TTS IPC**

Create `/Users/sea/Documents/ai_alex/electron/main/ipc/ttsHandlers.ts`:

```ts
import { ipcMain } from 'electron';
import { fail } from '../services/result';
import { synthesizeSpeech } from '../providers/ttsProvider';

export function registerTtsHandlers() {
  ipcMain.handle('tts.speak', async (_event, payload: { text: string }) => {
    if (!payload?.text?.trim()) {
      return fail('empty_tts_text', '没有可以朗读的内容。', true);
    }
    return synthesizeSpeech(payload.text);
  });
}
```

- [ ] **Step 3: 实现 Web Audio 分析**

Create `/Users/sea/Documents/ai_alex/src/composables/useAudioAnalyser.ts`.

Behavior:

- Create `AudioContext`.
- Connect an `HTMLAudioElement` to `AnalyserNode`.
- Return a reactive `audioLevel` from 0 to 1.
- Stop animation frame when audio ends.

- [ ] **Step 4: 前端播放 TTS**

Modify conversation flow:

- After assistant text appears, call `tts.speak`.
- Play returned audio in an `HTMLAudioElement`.
- Feed audio element into `useAudioAnalyser`.
- Set particle state to `speaking`.
- On ended, set particle state to `idle` unless music is playing.

- [ ] **Step 5: 验收 M4**

Manual acceptance:

- AI 回复后自动播报。
- 播放时粒子随声音变化。
- TTS 失败时保留文字回复，不阻塞聊天。

Commit:

```bash
git add electron/main/providers/ttsProvider.ts electron/main/ipc/ttsHandlers.ts electron/main/index.ts src/composables/useAudioAnalyser.ts src/App.vue src/components/ParticleSphere.vue
git commit -m "feat: add TTS speaking state"
```

---

## Task 8: M5 Apple Music 授权、搜索和播放 provider

**Files:**

- Create: `/Users/sea/Documents/ai_alex/electron/main/providers/appleMusicProvider.ts`
- Create: `/Users/sea/Documents/ai_alex/electron/main/ipc/musicHandlers.ts`
- Create: `/Users/sea/Documents/ai_alex/src/composables/useMusic.ts`
- Modify: `/Users/sea/Documents/ai_alex/electron/main/index.ts`

- [ ] **Step 1: 实现 Apple Music provider 接口**

Create `/Users/sea/Documents/ai_alex/electron/main/providers/appleMusicProvider.ts`.

Public functions:

```ts
export async function authorizeAppleMusic(): Promise<AppResult<{ authorized: boolean }>>;
export async function searchAppleMusic(query: string): Promise<AppResult<MusicTrack[]>>;
export async function playAppleMusic(trackId: string): Promise<AppResult<PlaybackState>>;
export async function pauseAppleMusic(): Promise<AppResult<PlaybackState>>;
export async function resumeAppleMusic(): Promise<AppResult<PlaybackState>>;
export async function getAppleMusicPlaybackState(): Promise<AppResult<PlaybackState>>;
```

Requirements:

- Use official Apple Music MusicKit / Apple Music API only.
- Missing `APPLE_MUSIC_DEVELOPER_TOKEN` returns `apple_music_not_configured`.
- Unauthorized user returns `apple_music_unauthorized`.
- Unplayable song returns `apple_music_unplayable`.
- No lyrics is not an error.

- [ ] **Step 2: 实现 music IPC**

Create `/Users/sea/Documents/ai_alex/electron/main/ipc/musicHandlers.ts`.

Handlers:

- `music.authorize`
- `music.search`
- `music.play`
- `music.pause`
- `music.resume`
- `music.getPlaybackState`

Each handler returns `AppResult`.

- [ ] **Step 3: 实现 useMusic**

Create `/Users/sea/Documents/ai_alex/src/composables/useMusic.ts`.

Behavior:

- `authorize()`
- `search(query)`
- `play(track)`
- `pause()`
- `resume()`
- `refreshPlaybackState()`
- Maintain `playbackState`, `currentTrack`, `musicError`.

- [ ] **Step 4: 验收 M5**

Manual acceptance:

- 未授权时，界面能提示用户授权 Apple Music。
- 搜索“轻松”能返回歌曲列表。
- 不能播放的歌曲显示明确提示。
- 普通聊天不会触发音乐流程。

Commit:

```bash
git add electron/main/providers/appleMusicProvider.ts electron/main/ipc/musicHandlers.ts electron/main/index.ts src/composables/useMusic.ts
git commit -m "feat: add Apple Music provider"
```

---

## Task 9: M6 沉浸音乐页和迷你播放器

**Files:**

- Create: `/Users/sea/Documents/ai_alex/src/components/MusicImmersiveView.vue`
- Create: `/Users/sea/Documents/ai_alex/src/components/MiniPlayer.vue`
- Modify: `/Users/sea/Documents/ai_alex/src/App.vue`
- Modify: `/Users/sea/Documents/ai_alex/src/style.css`

- [ ] **Step 1: 创建沉浸音乐页**

Create `/Users/sea/Documents/ai_alex/src/components/MusicImmersiveView.vue`.

Props:

```ts
defineProps<{
  title: string;
  artist: string;
  artworkUrl?: string;
  progressText: string;
  lyricLines: string[];
  activeLyricIndex: number;
  hasLyrics: boolean;
  recommendation: string;
  playing: boolean;
}>();
```

Emits:

```ts
defineEmits<{
  pause: [];
  resume: [];
  back: [];
}>();
```

Acceptance:

- No nested cards.
- Background remains immersive.
- If no lyrics, show recommendation text and progress.

- [ ] **Step 2: 创建迷你播放器**

Create `/Users/sea/Documents/ai_alex/src/components/MiniPlayer.vue`.

Props:

```ts
defineProps<{
  title: string;
  artist: string;
  artworkUrl?: string;
  playing: boolean;
}>();
```

Emits:

```ts
defineEmits<{
  pause: [];
  resume: [];
  open: [];
}>();
```

- [ ] **Step 3: App 视图切换**

Modify `/Users/sea/Documents/ai_alex/src/App.vue`.

Behavior:

- `viewMode === 'chat'`: show conversation.
- `viewMode === 'music'`: show immersive page.
- Returning from music sets `viewMode = 'chat'` and keeps mini player visible.
- Particle state is `playing` while music playback state is playing.

- [ ] **Step 4: 验收 M6**

Manual acceptance:

- 音乐意图后进入沉浸页。
- 播放、暂停、继续、返回可用。
- 返回聊天后迷你播放器保留。
- 没有歌词时页面不空、不报错。

Commit:

```bash
git add src/components/MusicImmersiveView.vue src/components/MiniPlayer.vue src/App.vue src/style.css
git commit -m "feat: add immersive Apple Music playback UI"
```

---

## Task 10: M7 macOS 打包和最终验收

**Files:**

- Modify: `/Users/sea/Documents/ai_alex/package.json`
- Create: `/Users/sea/Documents/ai_alex/docs/release-checklist.md`

- [ ] **Step 1: 添加打包工具**

Run:

```bash
cd /Users/sea/Documents/ai_alex
npm install -D electron-builder
```

Modify `package.json`:

```json
{
  "scripts": {
    "dist:mac": "npm run build && electron-builder --mac"
  },
  "build": {
    "appId": "com.lingli.desktop",
    "productName": "灵粒",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**",
      "dist-electron/**",
      "package.json"
    ],
    "mac": {
      "category": "public.app-category.productivity"
    }
  }
}
```

Keep existing scripts and dependencies.

- [ ] **Step 2: 创建发布验收清单**

Create `/Users/sea/Documents/ai_alex/docs/release-checklist.md`:

```md
# 灵粒 MVP 发布验收清单

- [ ] macOS 应用可以启动。
- [ ] `.env` 已配置火山和 Apple Music 所需参数。
- [ ] 前端不能读取密钥。
- [ ] 粒子球 idle/listening/thinking/speaking/playing 状态可见。
- [ ] 按住空格录音，松开识别。
- [ ] 中文普通话识别可用。
- [ ] 连续 5 轮对话保留上下文。
- [ ] AI 回复自动 TTS 播放。
- [ ] TTS 播放时粒子随声音律动。
- [ ] “播放一首轻松的音乐”触发 Apple Music 搜索。
- [ ] Apple Music 未授权时有明确提示。
- [ ] 可播放歌曲进入沉浸音乐页。
- [ ] 没有歌词时页面降级正常。
- [ ] 返回对话页后迷你播放器可用。
- [ ] 打包后的应用可以启动。
```

- [ ] **Step 3: 最终验证**

Run:

```bash
cd /Users/sea/Documents/ai_alex
npm run typecheck
npm test
npm run build
npm run dist:mac
```

Expected:

- Typecheck passes.
- Tests pass.
- Build succeeds.
- macOS app artifact appears in `/Users/sea/Documents/ai_alex/release`.

Commit:

```bash
git add package.json package-lock.json docs/release-checklist.md
git commit -m "chore: add macOS release checklist"
```

---

## 3. 用户需要提前准备的配置

执行到真实云服务前，需要用户准备：

- 火山方舟 API Key。
- 豆包模型 endpoint/model id。
- 火山 ASR app id 和 access token。
- 火山 TTS app id 和 access token。
- Apple Developer 账号。
- Apple Music Developer Token。
- 可用于授权测试的 Apple Music 账号，最好有有效订阅。

`.env` 文件应由用户本机创建，不能提交：

```env
VOLCENGINE_ARK_API_KEY=真实值
VOLCENGINE_ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
VOLCENGINE_ARK_MODEL=真实模型
VOLCENGINE_ASR_APP_ID=真实值
VOLCENGINE_ASR_ACCESS_TOKEN=真实值
VOLCENGINE_TTS_APP_ID=真实值
VOLCENGINE_TTS_ACCESS_TOKEN=真实值
APPLE_MUSIC_DEVELOPER_TOKEN=真实值
```

## 4. 计划自检

规格覆盖：

- macOS Electron 桌面应用：Task 1、Task 3、Task 10。
- Vue + Three.js 粒子球：Task 4。
- 自动监听/按住空格录音：Task 5。
- 火山 ASR：Task 5。
- 豆包 LLM 和记忆：Task 2、Task 6。
- 火山 TTS：Task 7。
- Apple Music：Task 8、Task 9。
- 沉浸音乐页和歌词降级：Task 9。
- 安全 IPC 和密钥保护：Task 1、Task 3。
- 分阶段验收：每个任务的验收步骤。

占位符检查：

- 本计划不包含 `TBD`、`TODO` 或网易云第三方接口依赖。
- Apple Music 和火山引擎具体接口字段将在对应 provider 实施时以官方文档为准，但 provider 的输入、输出、错误码和验收标准已经固定。

类型一致性：

- `AppResult`、`AssistantOutput`、`MusicTrack`、`PlaybackState` 在全局类型契约中固定。
- IPC channel 名称与规格保持一致。
