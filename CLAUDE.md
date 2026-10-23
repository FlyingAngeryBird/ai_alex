# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**灵粒（lingli / lingmo）** 是一款 macOS 桌面 AI 语音伙伴应用。用户面对一个 three.js 粒子球，可直接开口说话（自动倾听）或按住空格（push-to-talk）进行语音对话；对话由豆包大模型驱动，回复经火山引擎 TTS 播报；当识别到点歌意图时进入沉浸式音乐播放视图。技术栈：Electron 42 + Vue 3.5 + TypeScript 5.9 + Vite 7 + Vitest 3。

设计文档与历史规划在 [docs/superpowers/](docs/superpowers/)（注意：早期设计写的是 Apple Music，实际实现已改为 GD Studio 聚合音乐 API，以代码为准）。

## 常用命令

```bash
npm run dev          # = npm start：先 build 再启动 Electron（加载打包后的文件，非热更新）
npm run dev:vite     # 仅启动 Vite dev server (127.0.0.1:5173)，配合 ELECTRON_RENDERER_URL 可热更新渲染层
npm run build        # vue-tsc 类型检查 + tsc 编译 electron + vite build renderer
npm run typecheck    # 仅 vue-tsc --noEmit
npm test             # vitest run（node 环境，--passWithNoTests）
npm run test:watch   # vitest watch
npm run dist:mac     # build + scripts/package-mac.mjs 打包成 macOS .app

# 跑单个测试文件：
npx vitest run tests/autoListenSession.test.ts
# 按文件名模式过滤：
npx vitest run -t "IPC contract"
```

热更新开发：开两个终端，一个 `npm run dev:vite`，另一个 `ELECTRON_RENDERER_URL=http://127.0.0.1:5173 npm run build && electron .`（主进程 [electron/main/index.ts](electron/main/index.ts) 检测到该环境变量即 loadURL 而非 loadFile）。

## 架构总览

### 三层 Electron 结构

- **主进程** [electron/main/](electron/main/)：Node 环境，注册 IPC handler，封装所有外部服务调用（火山引擎 LLM/ASR/TTS、GD Studio 音乐 API）。入口 [electron/main/index.ts](electron/main/index.ts) 在 `app.whenReady` 前 `initDefaultConfigStore` + 注册全部 handler，`whenReady` 后 `loadConfig` 再创建窗口。
- **预加载** [electron/preload/index.ts](electron/preload/index.ts)：`contextBridge` 暴露 `window.lingli.invoke(channel, payload)`（请求-响应）+ `window.lingli.on(channel, handler)`（主进程->渲染层事件推送，返回取消订阅函数）。通道受 `exposedChannels`（invoke）+ `eventChannels`（事件）双白名单约束。
- **渲染进程** [src/](src/)：Vue 3 SPA，负责 UI、音频采集（AudioContext/MediaRecorder）、3D 粒子可视化。入口 [src/main.ts](src/main.ts) -> [src/App.vue](src/App.vue)。

### IPC 契约（最高约束）

新增或修改 IPC 通道必须**三处同步**，缺一会让类型或测试失败：
1. [electron/preload/index.ts](electron/preload/index.ts) 的 `exposedChannels`（invoke 白名单）或 `eventChannels`（事件白名单）
2. [src/types/electron-api.d.ts](src/types/electron-api.d.ts) 的 `LingliChannel` / `LingliEventChannel` 联合类型
3. [tests/ipcContract.test.ts](tests/ipcContract.test.ts) 锁定**精确顺序**的断言（两类白名单分别断言）

invoke 通道返回统一的 `AppResult<T>`：`{ ok: true; data: T } | { ok: false; error: { code, message } }`。事件通道由主进程 `event.sender.send(channel, payload)` 推送，渲染层 `on(channel, handler)` 接收。每个 handler 模块自带 `ok()`/`fail()` helper、payload 类型守卫，默认参数注入 provider 便于测试。

当前 invoke 通道：`app.*`、`chat.sendMessage`/`chat.streamMessage`、`config.get`/`config.update`、`music.*`、`tts.*`、`voice.*`。事件通道：`chat.streamChunk`（LLM 流式 token）、`tts.streamAudio`（TTS 流式音频块，当前整段 TTS 模式下未用，接口预留）。

### 配置系统（可配置人设 + 多音色）

- [configStore.ts](electron/main/config/configStore.ts)：读写 `userData/config.json`。`AppConfig = { persona: { systemPrompt }, voice: { voices: VoiceOption[], activeVoiceId } }`。`loadConfig` 支持旧格式迁移（`voiceId` -> `voices`/`activeVoiceId`）。默认 systemPrompt 在此（人设核心，改动需谨慎）。
- [configHandlers.ts](electron/main/ipc/configHandlers.ts)：`config.get`/`config.update` IPC，校验多音色 patch。
- [chatHandlers.ts](electron/main/ipc/chatHandlers.ts)：systemPrompt 每次从 configStore 读（不再硬编码）。
- [SettingsView.vue](src/components/SettingsView.vue)：设置面板，多音色管理（下拉选择当前音色 + 新增 + 内联编辑 + 删除 + 试听）。
- voiceId 透传：App.vue `speakAssistantReply` 用 `appConfig.voice.activeVoiceId` 传 `tts.speak` payload（空则 provider 走 env `VOLCENGINE_TTS_VOICE` 兜底）。

### 主进程 Providers

外部服务全部抽象为 provider 接口，位于 [electron/main/providers/](electron/main/providers/) 与 [electron/main/music/](electron/main/music/)：

- [llmProvider.ts](electron/main/providers/llmProvider.ts)：豆包（火山方舟 Ark）。
  - **去 JSON 约束**：不强制 `response_format: json_object`，systemPrompt 要求纯文本回复。
  - `sendMessage`（非流式，开场白用）+ `streamMessage`（流式 SSE，主链路）：`onChunk` 推可显示文本（纯文本直推；若模型偶尔输出 JSON，`extractReplySoFar` 兼容提取 reply 字段），`onRawChunk` 推原始 token，`onResponseStart` HTTP 响应开始。
  - `parseAssistantOutput`：纯文本模式提取 `《歌名》` -> `play_music` + `music.keyword`；无则 `chat`；兼容旧 JSON parse。
  - 维护 40 条消息的内存对话历史。
- [asrProvider.ts](electron/main/providers/asrProvider.ts)：一次性 ASR，submit 后轮询 query（keyboardRecorder 回退用）。
- [volcengineStreamingAsrProvider.ts](electron/main/providers/volcengineStreamingAsrProvider.ts)：流式 ASR（WebSocket）。`pushAudio` 返回 `partialText`（实时字幕数据源）。`stop()` 的 final-text fallback 等待可配置（`stopWaitMs` 默认 700ms）。
- [volcengineTtsProvider.ts](electron/main/providers/volcengineTtsProvider.ts)：一次性 `speak`（主用）+ 流式 `start`/`pushText`/`stop`（bidirection WS，已实现但渲染层当前用整段 `speak`，流式接口预留）。
- [gdstudioMusicProvider.ts](electron/main/music/gdstudioMusicProvider.ts)：聚合 netease/kuwo/joox 三源搜索，按 `sourcePreference` 顺序尝试，带搜索结果缓存（默认 5 分钟）。`play` 时逐候选解析 audioUrl/artworkUrl/lyrics，第一个拿到可播放链接的即返回。
- [realtimeVoiceProvider.ts](electron/main/providers/realtimeVoiceProvider.ts)：**纯类型/错误定义文件**，定义 `StreamingAsrProvider`/`StreamingTtsProvider` 接口、`RealtimeVoiceError`、unavailable provider 工厂。被 ASR/TTS 两边共享。

### LLM 输出契约（纯文本 + 《歌名》）

systemPrompt 要求自然口语回复（不输出 JSON/markdown），点歌时在回复里用书名号 `《歌名》` 带出（如"给你放一首《晴天》"）。`parseAssistantOutput` 提取 `《歌名》` 判断 `play_music`。`intent === 'play_music'` 时，App.vue `finishVoiceCapture` 用 `result.music.keyword` 调 `music.playRequest`。

### 渲染进程编排（[src/App.vue](src/App.vue) 是唯一编排层）

App.vue 组合多个 composable 与 service，**所有跨模块时序都集中在这里**：

- [useConversation](src/composables/useConversation.ts)：消息列表、`particleState`、`autoListenState`、`isListening`，以及 `stopListening`（**流式**：调 `chat.streamMessage` + `on('chat.streamChunk')` 逐字显示，`onChunk`/`onRawChunk`/`onResponseStart` 回调供 App.vue 埋点；已移除模拟思考延迟）。
- TTS：**整段模式**（`speakAssistantReply` 调 `tts.speak` 一次性合成 + `new Audio` 播放，和开场白同款，稳定连续）。流式 TTS（useStreamingTts）已移除--实测流式拼接有卡顿/偶发没放音，回退整段换稳定性。
- [useMusic](src/composables/useMusic.ts)：播放状态机、`<audio>` 元素管理、AnalyserNode 频谱分析（bass/mid/treble/beat/flux/centroid），分析失败时降级为基于 `currentTime` 的伪律动 `emitFallbackAudioBands`。`activePlayRequestId` 防止并发播放请求互相覆盖。
- [useAutoListen](src/composables/useAutoListen.ts)：开麦 + VAD + 0.9s PCM 预缓冲。
- [useRealtimeVoiceRecorder](src/composables/useRealtimeVoiceRecorder.ts)（首选）/ [useKeyboardRecorder](src/composables/useKeyboardRecorder.ts)（回退）：实际录制并把音频送主进程 ASR。realtimeRecorder `onPartialText` 回调暴露 ASR partial 给对话区实时字幕。

### 性能埋点

[VoiceLatencyTrace](src/types/app.ts) 记录语音链路各阶段时间戳：`space_up`/`asr_final`/`llm_request_start`/`llm_response_start`/`llm_first_raw_delta`/`llm_first_delta`/`llm_done`/`tts_first_push`/`tts_first_audio`/`tts_play_start`/`tts_play_end`。App.vue `window.__lingmoDebug.getLastLatencyTrace()` 暴露最近一次报告，用于定位延迟瓶颈（LLM 首 token / TTS 合成 / 播放起播）。`finishVoiceCapture` + `speakAssistantReply` 内各点位 `markVoiceTrace`。

### 自动倾听状态机

状态枚举见 [src/types/app.ts](src/types/app.ts) 的 `AutoListenState`（off/arming/armed/prehearing/recording/grace/finalizing/paused_for_tts/speech_detected/error）。纯逻辑状态机在 [autoListenSession.ts](src/services/autoListenSession.ts)，由 App.vue 驱动转换：

```
off -> arming -> armed ──speechStart──> prehearing ──startVoiceCapture成功──> recording
                                   │                          ↑
                              speechEnd                   speechStart(grace->recording, 续录)
                                   ↓
                          grace(1120ms) ──graceExpired──> finalizing ──finishVoiceCapture──> paused_for_tts ──TTS播完──> armed
```

- **blockers**：TTS 播放中 / 按住 Space / 音乐视图任一为真，VAD 停止检测并 reset（见 App.vue `getAutoListenBlockers`）。
- **PCM 预缓冲**：[pcmRingBuffer.ts](src/services/pcmRingBuffer.ts) 持续滚动保留最近 0.9s 音频。VAD 报 `speech_start` 时，App.vue 调 `autoListen.consumeBufferedAudio()` 把"开口前"音频作为 `initialAudio` 喂给 realtimeRecorder，避免吃掉第一个字。
- **VAD**：[voiceActivity.ts](src/services/voiceActivity.ts) 双阈值迟滞（start 0.08 持续 160ms / end 0.035 持续 900ms），可选自适应噪声底。
- **转录守门**：[autoListenTranscriptGate.ts](src/services/autoListenTranscriptGate.ts) 只在 auto_listen 模式生效（push-to-talk 不 gate），过滤空文本/纯语气词/过短输入；命中 `USEFUL_SHORT_PHRASES`（如"下一首""暂停""灵粒"）直接放行。拒绝时走 760ms 冷却 `scheduleAutoListenRecovery` 再回 armed。
- **回退**：realtimeRecorder 启动失败且错误匹配 `AudioContext|音频上下文|ScriptProcessor|当前环境无法创建` 时（`shouldFallbackToOneShotRecording`），回退到 keyboardRecorder 的整段录制。

### 视图模式与粒子状态

- `ViewMode`：`conversation`（对话 + 粒子球 + MiniPlayer）↔ `music`（沉浸式播放视图），`<Transition name="view-fade">` 切换。
- `ParticleState`（idle/listening/thinking/speaking/playing/error）由 App.vue 的 `particleState` computed 综合判定：TTS 播放中->speaking；音乐视图且非暂停->playing；否则跟随 conversation。`audioLevel` 同样按来源聚合（TTS / 音乐频谱 / VAD）。

### 对话面板 UI（液态玻璃）

[conversation-panel](src/style.css) 透明液态玻璃风格（参考音乐界面 search-glass）：低底色 `rgba(7,8,12,0.15)` + `blur(26px) saturate(1.3)` + 细边框 `rgba(255,255,255,0.09)` + `::before` 顶部白光折射。`status-pill` 随 `data-state` 变色发光（聆听/播放青、思考橙、回应黄、异常红）。收起态 `compact-action-bar` 5 列（说话/自动/status pill 正中/播放/展开）。展开时 message-list 自动滚动到最新（`watch` messages + partialText -> `scrollTop = scrollHeight`）。

## 关键约定与红线

- **环境变量加载**：[electron/main/env.ts](electron/main/env.ts) 从 cwd / appPath / mainDir 上两级 / userData 多个候选目录加载 `.env`，`override: false`，并对值做 trim。打包脚本 [scripts/package-mac.mjs](scripts/package-mac.mjs) 会把项目根 `.env` 复制进 .app 包，并把 `dotenv`/`ws` 两个运行时依赖单独拷进包内 `node_modules`。所需 key 见 [.env.example](.env.example)。
- **构建未使用 electron-vite**：尽管装了 `electron-vite` 依赖、存在 [electron.vite.config.ts](electron.vite.config.ts)，实际 `build` 脚本走的是手写 `tsc`（编译 main/preload）+ `vite build`（用 [vite.config.ts](vite.config.ts) 编译 renderer）。tsc 命令显式列了 3 个入口文件（index / preload / appHandlers），其余 electron 文件靠 import 链被拉入；**新增独立的 electron 入口（不被现有入口 import）时，必须把它加进 build 脚本的 tsc 文件列表**。
- **`--configLoader runner`**：vite/vitest 命令统一带该参数，是 vite 7 的配置加载方式，保留不要去掉。
- **渲染层路径别名 `@` -> `src/`**：在 [vite.config.ts](vite.config.ts) 与 [tsconfig.json](tsconfig.json) 的 `paths` 中定义。electron 主进程代码用相对 `.js` 后缀 import（因为 tsc 输出 NodeNext 模块），不要在 electron 侧用 `@` 别名。
- **安全上下文**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`（见 [windowOptions.ts](electron/main/windowOptions.ts)）。渲染层只能通过 `window.lingli.invoke`/`on` 访问主进程能力，不直接 require。
- **调试桥**：`window.__lingmoDebug` 暴露 auto-listen 诊断（状态/blockers/VAD 诊断/剩余恢复时间）+ `getLastLatencyTrace()`（语音链路耗时）。
- **systemPrompt 可配置**：默认在 [configStore](electron/main/config/configStore.ts)，用户可在设置面板编辑，改后即时生效。**去 JSON 约束**（纯文本 + `《歌名》` 点歌），不要加回 `response_format: json_object`。
- **TTS 整段模式**：主路径 `tts.speak`（一次性合成 + `new Audio` 播放）。流式 TTS 接口（`tts.startStreaming`/`pushText`/`stopStreaming` + `tts.streamAudio` 事件）已实现但渲染层未用--实测流式有卡顿/偶发没放音，稳定性优先。若要重启流式需先解决块拼接抖动问题。
- **gitignore**：`.claude/`、`.playwright-cli/`、`output/`、`heart-music-player/` 是临时/工具/参考目录，已 gitignore，不要提交。

## 测试约定

- 测试全在 [tests/](tests/)，vitest node 环境。每个 provider 测试通过注入 mock `fetch`/`env`/`sleep` 验证不依赖真实网络；每个 handler 测试注入 fake ipc + fake provider（流式 handler 还需 fake `event.sender.send`）。
- [ipcContract.test.ts](tests/ipcContract.test.ts) 锁定 invoke（`exposedChannels`）+ event（`eventChannels`）两类白名单顺序。
- 改 provider/handler 时，对应测试通常需要同步更新；新增 IPC 通道务必同步三处。
- `appIpc.test.ts` 直接 `import 'electron'`，依赖本地 Electron 二进制安装；若 `node_modules/electron/dist` 缺失会失败（环境问题，与代码无关）。
