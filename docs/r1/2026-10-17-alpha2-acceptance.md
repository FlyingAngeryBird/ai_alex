# Seamo AI R1 alpha.2 验收交付

本文件对应1.0.0-alpha.2开发预览，继续使用`codex/seamo-r1`，不合并main，不修改旧版目录。它是可交用户验收的开发候选，不是已通过全部41项、性能、签名和安装门槛的正式发布。

## 本批完成的实现

DEC-R1-DATA-035（F11d/F04d）：

- 数据设置可独立选择历史、记忆/话题、事项/提醒/专注、音乐个人数据、任务/工作稿；默认不选中任何范围。
- 先显示范围与实际数量，经本窗口有效票据确认；取消不修改数据。确认前及所有服务排空后再次核对选中内容，变化则停止清理，避免连刚到达的内容一起删除。
- 停服务后保留0600权限的清理前副本，再事务清理、重启；可在设置导出副本并使用既有恢复流程。记忆遗忘的抑制不会被旧备份撤销。
- 历史支持单会话删除。删除历史不删除独立记忆/事项/工作稿，来源不可查看时明确提示；任务不自动重放。
- SQLite10→11迁移在原机制下先保存升级前副本，再将消息序号改为不复用，防止清理后新消息被旧遗忘截止线排除。资产2.5.1不变，未修改Prompt/Skill/模型工具。

DEC-R1-ONBOARDING-036（F11b/F10b/F05d）：

- 首次使用说明可进入称呼/声音设置、服务配置，或跳过；跳过不授予麦克风/记忆权限、不发起模型请求、不自动播音。重启记住选择，设置可重新打开说明。
- 重启后的未完成委托只轻提示一次，用户选择继续才执行回执核对；不自动重放。
- 部分完成/等待补充的委托接入已有后端继续操作；来源被清理、授权变化、旧资产不可用时解释原因，不伪报成功。

DEC-R1-REMINDER-037（F07c/F10a）：

- 启动、唤醒或计时明显中断后，24小时内错过的提醒合为一次通知/应用内提示；更早项只列为错过，不逐条投递过期通知。
- 每个scheduleVersion仍有独立投递记录。静默模式请求静默通知，通知失败保留应用内结果；不把请求等同用户已看到。
- 一次性回访保留kind，正常到期显示回访问询；后台恢复摘要不会自动触发一串主动语音。

## 已执行的验证

- 最终完整89文件553项通过：`/tmp/seamo-r1-alpha2-final-tests.log`；生产构建通过：`/tmp/seamo-r1-alpha2-build.log`。后续清理预览计数修正及票据范围检查见`/tmp/seamo-r1-alpha2-final-focused.log`。现有bundle体积提示仍存在。
- 注册资产校验通过：10 Prompt、6 Skill、38业务工具、3内部工具；59个哈希文件未改变。合同正反例16项通过。
- 关联测试包括范围/票据/窗口/变更保护、关闭DB后执行、独立记忆/事项保留、清理后新消息、旧备份遗忘不复活、跳过引导不扩大授权、提醒聚合/过早错过/一次性回访、恢复提示不重放。
- CUA在隔离数据的正式main/preload/renderer入口核验首次说明及跳过（麦克风关闭、自动记忆关闭）。界面使用现有modal、颜色与布局体系。
- 隔离UI准备1条合成对话和1条独立事项：删除预览显示1段/1条；取消后原记录仍在；确认后正式进程退出并重启。实际cleanup-outcome=succeeded，历史为空，独立事项仍在，设置显示完成及导出清理前副本入口。没有清理用户正式数据。
- 独立选择音乐清理时，预览只显示音乐范围，其他范围不被选中；随后取消。

隔离数据位于`seamo-r1-ui-check-9QutP2`临时目录；日志`/tmp/seamo-r1-current-ui.log`。合成数据只用于验证本地代码，不冒充真实模型、音乐播放或用户业务成功。

## 完整需求验收索引

以下映射用于逐项验收，不把「有入口/实现」写成整项通过。

| ID | 实现入口/主模块 | 当前验收边界 |
| --- | --- | --- |
| F01a | App/useNativeConversation/nativeRealtimeSession | 已实测17轮；连续20轮及长听待验 |
| F01b | R1Composer/按键采集控制器 | 实现及取消测试；真实设备组合待验 |
| F01c | App/R1Composer/R1CompanionHome | 双方字幕与声音已实测；文字模型配置待补 |
| F01d | audioDevices/R1SettingsPanel | 设备路由与权限回退实现；真实拔插待验 |
| F02a | persona/R1SettingsPanel | 版本设置实现；全入口改名/音色听测待验 |
| F02b | PR03/modelBoundary | 原生闲聊可用；固定语义集/盲评待验 |
| F03a | nativePlayback/duplex worklet | 至少3次主动插话停旧声通过；噪声/物理延迟待验 |
| F03b | taskSupervisor/TaskPanel | 目标版本/暂停取消与回执实现；真实混合链路待验 |
| F04a | memory/memoryConfirmations/MemoryPanel | 显式写入/来源/版本实现；跨会话固定集待验 |
| F04b | automaticMemory/memoryPolicy | 默认关、敏感确认、撤销实现；完整真实集待验 |
| F04c | topics/topicSummaries/MemoryPanel | 来源/版本/接续实现；容量和语义集待验 |
| F04d | memoryContext/backup/dataCleanup | 遗忘/恢复保护及本批清理测试通过；并发语音全场景待验 |
| F04e | sessionMode/Conversations/临时确认 | 内存隔离与显式保存实现；完整语音场景待验 |
| F05a | BraveSearch/ConversationTools/TaskTools | 真实搜索Key未配置，不能称已联网 |
| F05b | PageReader/Evidence/WebResult | URL/读取深度实现；真实来源集待验 |
| F05c | TaskSupervisor/WebResult | 稳定候选/选择比较入口；真实业务集待验 |
| F05d | TaskRunner/回执恢复/TaskPanel | 部分完成继续入口已补；真实分项失败待验 |
| F06a | Items/Artifacts/TaskTools | 保存和版本/幂等实现；真实语义集待验 |
| F06b | Items/ItemsPanel | 完成/撤销/专用提醒联动实现及事务测试 |
| F06c | ItemsPanel/Items | 搜索编辑删除及确认实现；完整点击集待验 |
| F06d | artifactExport/ArtifactEditor | 实际文件写入/取消测试；全部系统路径待验 |
| F07a | reminderTools/Items | 时间时区/独立ID实现；真实语音回注待验 |
| F07b | Items/ReminderScheduler | 版本改期取消/旧定时器隔离测试 |
| F07c | ReminderScheduler/ItemsPanel | 本批补错过恢复；系统通知/睡眠实测待验 |
| F07d | Focus/FocusDialog | 单计时/暂停/睡眠恢复实现；真实设备待验 |
| F08a | MusicTools/Music | 推荐与实际开播分离；真实音源未通过 |
| F08b | GdStudio/MusicImmersiveView | 搜索/同曲回退实现；音源解析当前失败 |
| F08c | Music/useMusic | 播放器/队列/音量/实际设备回执实现；听测待验 |
| F08d | Music/收藏反馈 | 持久化与跳过规则实现；真实播放闭环待验 |
| F08e | LRC/ParticleSphere/audio analysis | 真实时钟/无资源降级实现；三类音频听测待验 |
| F08f | audio arbitration/useMusic | 降音与用户操作优先实现；边听边聊待验 |
| F09a | Artifacts/TaskRunner/Editor | 可编辑结论与版本实现；语义评估待验 |
| F09b | Composer/材料上下文 | 8000码点与材料绑定实现；真实模型当前配置待补 |
| F09c | ArtifactEditor/版本/导出 | 局部改写隔离真实Ark历史证据；当前语音续改待验 |
| F10a | ReminderTools/kind=followup | 一次性回访事件/问询本批补齐；真实到期待验 |
| F10b | TaskSupervisor/useTasks/TaskPanel | 一次恢复提示/回执核对实现；旧资产不可用时明确拒绝，完整跨资产恢复仍待补证 |
| F10c | Preferences/assistantSpeech | 勿扰/主动发声策略实现；实际系统通知待验 |
| F11a | App/现有R1原型结构 | 页面布局保持；全尺寸/全状态对照未完成 |
| F11b | R1WelcomeDialog/Onboarding | 本批实现，正式入口隔离点击通过 |
| F11c | Settings/ServiceDiagnostics | 配置、设备、独立检测实现；服务条件见下 |
| F11d | DataSettings/History/Cleanup/Backup | 本批范围清理和单历史删除实测；恢复/导出按实际回执 |

## 尚未满足的交付条件

1. 当前安装包只有原生实时语音已配置；已请求用户补Ark Key/模型及搜索Key。没有真实配置就不宣称文字、后台委托和联网已在用户端闭环。
2. 10月17日再次真实检查音乐：网易未找到严格相同的目标歌手/曲目，酷我400，Joox选中曲目但资源不可用/503。日志`/tmp/seamo-r1-current-music-resources.log`。未播放，不换歌冒充成功，不擅自更换供应商。
3. 本机`security find-identity -v -p codesigning`返回0个有效签名身份。notarytool存在不等于有Developer ID身份和公证凭据；只能提供临时签名的开发包。
4. 全量A/V、30分钟真实混合听测、精确首响/停声、全部原型/设备、完整跨资产恢复和安装回退未通过。当前没有证据承诺今天一定完成这些门槛；不得标全部功能已验收或正式上线。

## 建议验收顺序

先核对首次说明与设置、事项/提醒/专注、工作稿、历史/备份/清理；再用真实服务检查语音记忆与任务/查询闭环，最后做音乐混合和设备/安装场景。新包首次打开会保存SQLite10升级前副本。回退旧R1包须使用隔离数据及升级前副本，不能让旧包直接打开schema11；旧版原始目录仍保持不变。
