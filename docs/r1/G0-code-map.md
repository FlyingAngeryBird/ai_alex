# Seamo AI R1: G0 源码映射

基线：`08554b7`（2026-10-13 工作区快照）。本表描述现有正式应用，不把 `交互原型/R1` 的脚本或 fixture 当作产品实现。状态 `部分` 表示有可复用代码但未满足最终 PRD，`缺失` 表示尚无真实业务闭环。

| 功能 | 当前状态与证据 | R1 目标模块 | 主要依赖 |
| --- | --- | --- | --- |
| F01a 自动会话 | 部分；`useAutoListen`、VAD，旧状态与 PRD 不同 | SessionController、RealtimeAdapter | G0 原生语音 |
| F01b 按键说话 | 部分；录音与流式 ASR 已有 | SessionController、InputController | 麦克风 |
| F01c 文字与字幕 | 部分；`useConversation`、转录字幕 | SessionController、ConversationView | 统一 turn ID |
| F01d 设备权限 | 部分；麦克风请求入口 | DeviceService、Settings | macOS 安装包实测 |
| F02a 人格音色 | 部分；JSON 配置只有 prompt/音色 | PersonaService、SecretStore | G0 音色 |
| F02b 倾诉与建议 | 部分；普通 LLM 回复，无长期上下文 | ContextService、PromptRegistry | G2 记忆 |
| F03a 插话停播 | 部分；旧 TTS 与自动倾听互斥 | MediaCoordinator、SessionController | G0 实时协议 |
| F03b 纠正与任务控制 | 缺失；无 Task | TaskSupervisor、ToolExecutor | G1 状态与回执 |
| F04a 明确记住 | 缺失；仅 40 条内存消息 | MemoryService | SQLite |
| F04b 自动记忆 | 缺失 | MemoryExtractor | 授权、文本模型 |
| F04c 话题接续 | 缺失 | TopicService、ContextService | 历史与来源 |
| F04d 更正遗忘 | 缺失 | MemoryService | 删除抑制、上下文失效 |
| F04e 临时对话 | 缺失 | SessionController | 内存隔离 |
| F05a 实时查询 | 缺失 | SearchService | G0 搜索权限 |
| F05b 来源读取 | 缺失 | PageReader、EvidenceStore | 公网页访问 |
| F05c 比较追问 | 缺失 | CandidateService、ResultView | 稳定 ID |
| F05d 查询重试 | 缺失 | TaskSupervisor | 回执与预算 |
| F06a 便签保存 | 缺失 | ItemService | SQLite |
| F06b 待办完成撤销 | 缺失 | ItemService | Reminder 联动合同 |
| F06c 事项编辑删除 | 缺失 | ItemService | expectedVersion |
| F06d 导出 | 缺失 | ExportService | 文件对话框 |
| F07a 创建提醒 | 缺失 | ReminderService | 调度、时区 |
| F07b 改期取消 | 缺失 | ReminderService | scheduleVersion |
| F07c 到期错过 | 缺失 | Scheduler | macOS 通知与休眠 |
| F07d 专注计时 | 缺失 | FocusService | 单调时钟、恢复 |
| F08a 推荐开播 | 部分；书名号意图、MusicProvider | MusicService、ToolExecutor | G0 音源 |
| F08b 点歌搜索 | 部分；GD Studio 多源搜索 | MusicService、MusicView | 曲目一致性 |
| F08c 播放队列 | 部分；播放暂停有，队列不足 | PlayerService | 播放回执 |
| F08d 收藏反馈 | 部分；收藏 JSON 有，反馈不足 | MusicLibraryService | SQLite 迁移 |
| F08e 歌词粒子 | 部分；LRC、频谱和粒子已有 | PlayerService、ParticleSphere | 真实音频听测 |
| F08f 边听边聊 | 缺失；音乐页阻断自动倾听 | MediaCoordinator | 降音与恢复 |
| F09a 讨论结果 | 缺失；仅聊天文本 | ArtifactService | 任务模型 |
| F09b 粘贴改写 | 缺失 | ArtifactService | 文本上限 |
| F09c 局部续改 | 缺失 | ArtifactService、ExportService | 版本冲突 |
| F10a 约定回访 | 缺失 | ReminderService | followup kind |
| F10b 重启恢复 | 缺失 | TaskSupervisor、RestoreService | 检查点与回执 |
| F10c 勿扰停主动声 | 缺失 | MediaCoordinator、Settings | 通知队列 |
| F11a 首页导航 | 部分；对话/音乐两视图 | AppShell、ResultView | 原型交互 |
| F11b 首次引导 | 缺失 | Onboarding | 配置状态 |
| F11c 全部设置 | 部分；人格 prompt 与多音色 | Settings、PersonaService | G0 资源 |
| F11d 历史数据诊断 | 缺失 | History、BackupService、Diagnostics | SQLite、隐私 |

## 现有源码边界

- `electron/main` 拥有外部服务调用及本地 JSON 配置；`electron/preload` 提供白名单 IPC；`src/App.vue` 当前集中编排聊天、录音、播音和音乐。
- 现有 `chatHandlers` 只保留最近 40 条内存消息；`configStore` 和 `musicStore` 分别写 `config.json`、`music.json`。
- 现有打包脚本会把项目根 `.env` 复制进 `.app`；R1 发布前必须移除，并让新旧版使用不同的应用身份和数据目录。
- `r1-assets/` 是开发包 1.0.1 的展开副本。其 v0.5.1 Schema 与最终 PRD 冲突的字段，须在 G1 修订并重新生成 manifest；静态校验通过不代表真实功能完成。
