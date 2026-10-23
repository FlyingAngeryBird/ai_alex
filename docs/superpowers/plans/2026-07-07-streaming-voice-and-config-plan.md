# 流式语音对话优化 + 提示词/音色配置化 实现计划

日期：2026-07-07
分支：feature/lingli-mvp
范围：阶段 A（配置系统）+ 阶段 B（LLM 流式 + 去延迟 + ASR partial 字幕）。阶段 C（TTS 流式）作为后续阶段，本计划仅标注接口预留，不在本次实现。

## 目标

1. **需求1**：systemPrompt 与 TTS voiceId 做成可配置（`userData/config.json` + 应用内设置 UI），改后即时生效无需重启。
2. **需求2（第一步）**：把 `ASR → LLM 全量 → TTS 全量 → 播放` 的串行链路改成 `ASR 收尾 → LLM 首 token → UI 逐字显示`，移除模拟延迟，并利用已被丢弃的 ASR partial 文本做实时字幕。

## 实施顺序

```
阶段A 配置系统 ──> 阶段B LLM流式+去延迟+partial字幕 ──> (后续)阶段C TTS流式
```

A 先行：B 的 systemPrompt 从配置读，C 的 voiceId 从配置读。地基先行。

---

## 阶段 A：配置系统（需求1）

### A1. 配置存储 `electron/main/config/configStore.ts`（新增）

- 路径：`app.getPath('userData')/config.json`。
- 结构与类型（同步加到 `src/types/app.ts`）：
  ```ts
  export type AppConfig = {
    persona: { systemPrompt: string }
    voice: { voiceId: string }
  }
  ```
- API：`loadConfig()`（启动时调用，读盘 + 默认值深合并）、`getConfig()`（返回内存缓存）、`updateConfig(patch)`（合并内存 + 防抖落盘 300ms）。
- 默认值：`persona.systemPrompt` = 当前 [chatHandlers.ts:38-68](electron/main/ipc/chatHandlers.ts#L38) 的硬编码 prompt 整段；`voice.voiceId` = 空串（空时 provider 回退到 env `VOLCENGINE_TTS_VOICE`，保持现有行为）。
- 在 [electron/main/index.ts](electron/main/index.ts) `loadEnvironmentFiles` 之后调 `loadConfig()`。

### A2. 配置 IPC `electron/main/ipc/configHandlers.ts`（新增）

- `config.get` → `ok(getConfig())`。
- `config.update` → 校验 patch（systemPrompt/voiceId 为 string）→ `updateConfig` → `ok(getConfig())`。
- 复用各 handler 模块统一的 `AppResult<T>` / `ok` / `fail` / `getIpcMain` 模式。
- 在 [index.ts](electron/main/index.ts) 注册 `registerConfigHandlers()`。

### A3. systemPrompt 接入配置

- [chatHandlers.ts](electron/main/ipc/chatHandlers.ts)：删掉模块级 `systemPrompt` 常量，`createLlmMessages` 改为每次从 `getConfig().persona.systemPrompt` 读取拼装。memory 仍为模块级。

### A4. voiceId 接入配置（不改 provider）

- [volcengineTtsProvider.getConfig](electron/main/providers/volcengineTtsProvider.ts#L98) 已支持 `payload.voice` 优先于 env。无需改 provider。
- 渲染层 `speakAssistantReply` 调 `tts.speak` 时，payload 透传当前配置的 `voiceId`（空串则不传，走 env 兜底）。

### A5. preload + 类型 + 契约测试同步

- [preload/index.ts](electron/preload/index.ts) `exposedChannels` 加 `'config.get'`、`'config.update'`。
- [electron-api.d.ts](src/types/electron-api.d.ts) `LingliChannel` 同步。
- [ipcContract.test.ts](tests/ipcContract.test.ts) 白名单断言同步（注意顺序）。

### A6. 设置 UI `src/components/SettingsView.vue`（新增）

- props：`config: AppConfig`、`voicePreviewing: boolean`；emits：`update:config`、`close`、`previewVoice`。
- 内容：systemPrompt `<textarea>`（整段可编辑）、voiceId `<input>` + "试听"按钮（emit `previewVoice`，App.vue 调 `tts.speak` 播固定示例句）、保存/取消按钮。
- 抽屉式覆盖层，不侵入 `viewMode`（music/conversation 切换逻辑不动）。

### A7. App.vue 接入

- 新增 `settingsOpen` ref + `appConfig` ref（启动时 `config.get` 拉取）。
- ConversationView header 加齿轮入口（emit `openSettings`）。
- `<SettingsView v-if="settingsOpen" :config="appConfig" @update:config="onConfigUpdate" @preview-voice="..." @close="settingsOpen=false" />`。
- `onConfigUpdate`：调 `config.update` IPC → 成功后更新本地 `appConfig` ref。
- `speakAssistantReply`：payload 带上 `appConfig.voice.voiceId`。

### A8. 阶段 A 测试

- `tests/configStore.test.ts`：默认值合并、patch 更新、防抖写盘（注入 fake fs / now）。
- `tests/configIpc.test.ts`：fake ipc + fake configStore，校验 get/update 返回与校验失败码。
- `tests/chatIpc.test.ts` 增补：systemPrompt 来自 configStore（注入 fake store）。

---

## 阶段 B：LLM 流式 + 去延迟 + ASR partial 字幕（需求2 第一步）

### B1. preload 事件推送通道（前置工程）

当前 `window.lingli` 仅 `invoke`（请求-响应），无法承载流式。扩展：

- [preload/index.ts](electron/preload/index.ts) 新增 `eventChannels` 白名单（与 `exposedChannels` 分开）：`'chat.streamChunk'`、`'tts.streamAudio'`（C 阶段用，先占位）。
- 暴露 `lingli.on(channel, handler): () => void`（内部 `ipcRenderer.on`，返回取消订阅函数）。`invoke` 不变。
- [electron-api.d.ts](src/types/electron-api.d.ts)：`Window.lingli` 加 `on` 签名 + `LingliEventChannel` 联合类型。
- [ipcContract.test.ts](tests/ipcContract.test.ts)：增补 `eventChannels` 顺序断言。
- 主进程 handler 通过 `event.sender.send(channel, payload)` 推送 chunk。

### B2. LLM 流式 provider

- [llmProvider.ts](electron/main/providers/llmProvider.ts) 新增 `streamMessage(messages, onChunk): Promise<AssistantOutput>`：
  - Ark API `stream: true`，`Accept: text/event-stream`。
  - 用 `response.body.getReader()` 逐 chunk 读，按 `\n` 切行解析 SSE `data:` 负载；`data: [DONE]` 结束。
  - 每个 token delta → `onChunk(delta)` 回调。
  - 累积全文，结束后 `parseAssistantOutput(fullText)` 返回 `AssistantOutput`（intent/music 在此时确定）。
  - 复用 `withTimeout` / `getConfig` / `ensureJsonInstruction`。
- `LlmProvider` 接口加 `streamMessage`（保留 `sendMessage` 用于非流式场景与开场白）。

### B3. 流式 chat IPC

- [chatHandlers.ts](electron/main/ipc/chatHandlers.ts) 新增 `chat.streamMessage` handler：
  - payload 校验同 `chat.sendMessage`。
  - 调 `provider.streamMessage(messages, (delta) => event.sender.send('chat.streamChunk', { delta }))`。
  - 结束推 `{ done: true, intent, music, reply }`，并按现有逻辑 appendMemory。
  - 错误推 `{ done: true, error: { code, message } }`。
- handler 需要拿到 `event`，当前 handler 签名已是 `(event, payload)`，测试需传 fake `{ sender: { send: vi.fn() } }`。

### B4. LLM 流式 JSON 处理策略（已确认）

流式 token 是 JSON 碎片，中途无法解析 intent/music。处理：
- 流式期间 token 当 **reply 纯文本直推**渲染层（首字最快）。
- 流结束后对完整文本 `parseAssistantOutput` 提取 intent/music；解析失败 `intent='chat'`（已有 fallback）。
- `play_music` 的 `music.play` 在 done 事件后触发（reply 已在显示，歌名也在 reply 里，体验可接受）。
- 同步微调 systemPrompt：强调"先输出 reply 正文，保持 JSON 结构 reply 字段在前"（当前 prompt 格式已满足）。

### B5. 渲染层流式接收

- [useConversation.ts](src/composables/useConversation.ts) 重构 `stopListening`：
  - 移除两次 `await wait(delayMs)`（[L207](src/composables/useConversation.ts#L207)、[L222](src/composables/useConversation.ts#L222)）。
  - 推入 user 消息后，立即推入一个空 assistant 占位消息（state=`thinking`），`particleState='thinking'`。
  - 调 `lingli.invoke('chat.streamMessage', { text })` 启动流式 + `lingli.on('chat.streamChunk', ...)` 接收：
    - `delta` → 追加到占位消息的 `text`（逐字显示）。
    - `done` → 拿 intent/music/reply，修正最后一条消息，`particleState` 切换。
  - 返回 `ConversationResult`（intent/music/reply）供 App.vue 决定是否点歌。
- 开场白 `generateOpeningGreeting` 仍用非流式 `sendMessage`（一句话无需流式）。
- `requestAssistantReply` 拆分为流式版 `streamAssistantReply`。

### B6. ASR partial 实时字幕（零新 IPC）

- [useRealtimeVoiceRecorder.ts:139](src/composables/useRealtimeVoiceRecorder.ts#L139) `sendChunk`：取 invoke 返回值的 `partialText`，通过新增的 `onPartialText` 回调暴露。
- App.vue 把 partial 传给 ConversationView。
- [ConversationView.vue](src/components/ConversationView.vue) 消息列表底部加一个临时行显示"正在听到：{partial}"（`partialText` prop，空时不显示）。

### B7. 阶段 B 测试

- `tests/llmProvider.test.ts` 增补 `streamMessage`：fake fetch 返回 SSE ReadableStream（`data: {"choices":[{"delta":{"content":"你"}}]}\n\n` ... `data: [DONE]`），验证 onChunk 逐 token 调用 + 最终 AssistantOutput。
- `tests/chatIpc.test.ts` 增补 `chat.streamMessage`：fake ipc + fake provider + fake event.sender.send，验证 chunk 推送顺序与 done 载荷。
- `tests/realtimeVoiceRecorder.test.ts` 增补：partialText 经回调暴露。
- `tests/ipcContract.test.ts` 增补 eventChannels 断言。

---

## 阶段 C：TTS 流式（后续，本次不实现）

仅预留：B1 已占位 `tts.streamAudio` 事件通道。后续补齐 [volcengineTtsProvider](electron/main/providers/volcengineTtsProvider.ts#L302) 的 `start/pushText/stop` + 渲染层流式播放（MediaSource 拼接或分段队列）。B5 的句子切分逻辑在 C 阶段接上 TTS。

---

## 风险与回滚

- **LLM 流式 JSON 碎片**：模型可能输出非 JSON 导致 intent 误判。缓解：`parseAssistantOutput` 已有纯文本 fallback；微调 prompt 强调结构。回滚：`chat.sendMessage` 非流式 handler 保留，可一键切回。
- **preload 双白名单**：invoke 与 event 通道分开管，避免误用。测试锁定顺序。
- **配置文件损坏**：`loadConfig` 读盘失败时回退默认值并记录日志，不阻塞启动。
- **流式过程中途取消**（用户切音乐视图/退出）：B5 需在 `onBeforeUnmount` 或视图切换时 `lingli.on` 返回的取消订阅 + 通知主进程停止（done 事件前可忽略后续 chunk）。主进程侧 streamMessage 的 fetch 中断通过 AbortController（B2 预留 signal 参数）。

## 不在本次范围

- 阶段 C TTS 流式实现。
- ASR partial 提前预热 LLM（VAD speech_end 前用稳定 partial 发起请求）。
- Windows 打包。
