# DeepSeek 开发状态（D1 起）

工作目录：`/Users/sea/Documents/ai_alex-r1`，分支 `codex/seamo-r1`，基线 `2309788`（资产 3.4.2/schema 3.1.0/SQLite11）。

## 批次

| 批次 | 范围 | 状态 | 提交 |
| --- | --- | --- | --- |
| D1 | notes_delete/notes_export：文字＋原生实时语音＋Task＋可信 UI 非阻塞桥；DEC-053；资产 3.5.0/schema 3.2.0 | 开发已交付，实包待验收 | `86489a9` |
| D1a | 审查修复：保存框中真实态复核、并发导出单提交、Task 立即等待、remainingReminderIds、导出回执身份 | 开发已交付，实包待验收 | `68d3abd` |
| D1b | 审查修复：取消/过期/替换结算到原Task、删除已提交后关联恢复、同批仅执行到 ui_action | 开发已交付，实包待验收 | `7c40ca8` |
| D2 | 查询→候选→比较/选择→追问→保存事项/提醒：按被引用证据完成、明确读页要求、核心流程验证；DEC-054 | 开发完成，实包待验收 | `f084fe8` |
| D3 | 工作稿版本链/续改/撤销/保存/导出；临时保存范围确认；真实播报 announcedAt 审计；DEC-055 | 开发完成，实包待验收 | `3d7332d` |
| D4 | F08a–f 音源有界复验、死源退避、本地播放/切曲/歌词/降音流程 | 开发完成，实包/资源待验收 | `5c999b4` |
| D5 | 41项盘点、D1状态统一、alpha.11 集中构建与内部验收包 | 开发已交付，实包待集中验收 | `29a2915`（包源） |

## D1 实现

- 合同：`notes_delete` 保留 `reminderDisposition/confirmedReminders` 必填但仅作低信任提议；`ui_action.action` 新增 `confirm_item_delete`（工具 schema 3.1.0→3.2.0）。模型调用只返回 `awaiting_user`，成功 data 与原合同一致；用户取消返回 `cancelled`。
- 主进程新增 `R1ItemActions`：冻结真实 Item 版本与提醒快照（`deletionPreview`）或 Item/Artifact 导出快照；pending 绑定 owner webContents、会话/临时模式、可选 task/run/goalVersion；TTL 300s（沿用记忆确认窗口）；ticket=actionId，重复确认返回同一结果，不重复副作用；文件已写但回执失败保留 `EXPORT_FILE_WRITTEN_RECEIPT_FAILED`，不自动重写。
- 删除：确认时重读预览并逐项比对冻结快照；版本/提醒变化→`ITEM_ACTION_STALE` 且不删除。提醒去留只来自 UI 的 `keep/cancel`。
- 导出：Items 与 Artifact+version 两个合同分支均接通；保存框只在用户处理 UI 动作时由主进程打开；模型不能提供路径；dialog 期间仍校验会话与版本。
- 工具接线：`R1ItemTools`（观察/版本）、`R1ConversationTools`（文字与原生实时共用 scope）、`R1TaskToolExecutor` + `R1TaskSupervisor.executePendingTool`（tool 预算、callId 幂等、pending 检查点、owner）。
- Task：ui_action 不进入领域 Receipt；存在未结算 UI 动作时 `completed` 被拒（`TASK_COMPLETION_UI_PENDING`）；取消/改目标/暂停/上下文失效/临时结束撤销 pending；确认后的真实回执写回原 task/run/action，恢复时 `adoptExternalReceipts` 核对吸收，不重演删除/导出。
- IPC：新增 invoke `r1.items.resolveAction`、事件 `r1.itemAction`/`r1.itemsChanged`；preload、`r1Api` 类型与 `ipcContract` 三处同步。
- UI：抽取 `R1ItemActionDialog.vue` 复用现有删除预览/提醒去留弹窗；App.vue 全局层（侧栏关闭也可确认）、R1ItemsPanel 复用并随 `r1.itemsChanged` 刷新；保持原型样式，无新页面。

## 验证

- `npm test`：101 文件 653 项通过（基线 97/634；本批新增 4 文件 19 项）。
- 关联门槛：item action 服务（offer/confirm/过期/版本变化/owner/会话/任务链接/恢复）、文字工具接线、Task 工具与发布、Prompt 资产归属、IPC 契约、事项生命周期、导出、记忆确认、任务 runner 共 73 项通过。
- `npm run build`：通过（保留既有 Vite 大 chunk 提示）。
- 资产：`rebuild_release.py` 重建 59 文件 manifest；`validate_assets.py`（10 Prompt/6 Skill/38+3 工具/14 schema/21 fixtures）与 `check_contract_examples.py` 16 例通过。
- 真实服务主链：`scripts/check-item-actions.mjs` 需 GUI 会话读取已配置 vault；本会话无 GUI，Electron `app.whenReady()` 不返回（已用最小探针确认，脚本自身也未进入首个 stage），故未取得真实 M01 删除/导出证据。未复制/使用 `.env`（已删除此前误拷的本地文件），未打印密钥，未写用户业务库。

## D1a 审查修复（对应 Codex 静态审查）

- 保存框中真实态：`exportItems`/`exportArtifact` 新增可信 `assertCurrent` 回调，在对话框返回后、版本复核后、写文件前执行；由 `R1ItemActions` 复核 pending 仍是同一 ticket、未过期、真实 session/temporary、owner webContents 存活、Task goal/状态。任一失败不写文件。
- 并发确认：按 ticket 建立共享 in-flight Promise，同一 ticket 的并发 export 只打开一次保存框、只写一次；重复调用回放同一结果。
- 终态明确：取消→settled cancelled；成功→settled exported/deleted；文件已写但回执失败→settled 明确错误且不重写；其它确认失败→settled 对应错误码并撤销 pending，重复请求不再产生副作用。
- Task 立即等待：TaskRunner 收到 `ui_action(awaiting_user)` 后立即调用 `waitForUserAction`，任务进入 `waiting_input` 并结束活动预算/run，不再消耗后续决策或 PR10 草稿；确认后 `onTaskReceipt→refreshExternalReceipts` 吸收真实回执并更新进展。
- `remainingReminderIds` 改为由真实删除回执（`reminder_kept`）生成，与恢复路径一致。
- 导出回执身份：`exportItems`/`exportArtifact` 接受 actionId/task/run，回执 JSON 的 actionId/runId 与 ticket、原 task/run 一致；删除回执用显式 SELECT＋UPDATE 关联，不再用 catch 任意数据库失败当重复吞掉。
- 验证：`r1ItemActions` 16 项（新增并发、对话框撤销/会话变化/Task 变化、keep/cancel 提醒 ID、Artifact 回执身份、Runner 立即等待）；关联 49 项、typecheck 与生产构建通过。按审查要求未重复全量 653 项。

## E1 真实应用核心流程（真实窗口执行结果；自然查询已受理，保存/工作稿链部分完成）

- 已操作真实 alpha.11 窗口：Finder/Terminal 启动、截图可用；AppleScript 辅助访问被拒后改用 Electron 本地调试端口（未安装新工具）驱动真实 renderer。
- 已证：真实开场白；自然查询两次 `ARK_TOOL_SCOPE_OR_SCHEMA_INVALID`；显式“发起后台任务”后 start_task→真实搜索/读页→completed（10 候选/来源）；任务面板并排比较（2 列）、选中第 2 候选；自然追问后真实保存便签「RFC 9110 官方标准」（source_ref 与选中候选一致，正文含真实 URL 与“仅搜索摘要”），并创建关联提醒（1 小时后，scheduled）。
- 用户判断：本段“查询→比较→选中→便签+关联提醒”通过；重复保存成功回执与工作稿链未完成。
- 粗略耗时（alpha.11，非正式性能样本）：自然查询错误约 30s 内可见；显式后台任务发送后约 20–25s 出现受理回复；随后 `progressBrief` 从“正在处理”→“已取得 10 个候选，正在核对并整理结果”，任务约 2 分钟内 completed。可见进展与最终来源，不是长时间无反馈；alpha.12 授权后用同一原始自然问法重测并记录准确时间线。
- alpha.12 复测原自然问法仍报 `ARK_TOOL_SCOPE_OR_SCHEMA_INVALID`；主进程诊断（alpha.12 已含）记录为 **`start_task MODEL_TOOL_INPUT_INVALID`**，不是超时或 web 工具直调。
- 根因：start_task/steer_task 的 delegation 强制要求 toolAliases/requiredActions，与 PR03“必要副作用可空”语义冲突；requiredActions 枚举缺 `web_read_page`，与 DEC-054“明确读原文时声明”冲突。模型按提示构造即被 Schema 拒绝。
- 修复 **alpha.13**（`c3d5f9b`，资产 3.5.4、schema 3.2.1，DEC-057）：delegation 字段改为可选；requiredActions 枚举补 web_read_page；PR03 说明只读查询可省略/空数组；工具输入拒绝时记录失败 schema 路径/关键字（不含参数值）。
- 边界验证（`84b1ae9`）：delegation 省略 toolAliases/requiredActions 时程序仍只授权 `read_file`+`write_todos`，不默认域写入；requiredActions 未在授权工具范围内时返回 `TASK_REQUIREMENTS_INVALID`，不静默扩大权限；已加测试锁定。
- alpha.13 授权后复测：原自然问法 **已受理**（不再 scope/schema 错误），任务 `e7903e89-1ebc-4663-8025-056fb0b60df9` 真实执行；约 35s 受理、36s 可见回复、39/45/53s 三次进展（“已取得 10 个候选”→读取页面），154s 以 `partially_succeeded` 结束（unresolved `ARK_REQUEST_TIMEOUT`），10 候选/11 来源仍可查看与选择。
- 任务面板并排比较（2 列）正常；选中第 2 候选。自然追问“保存+1小时后提醒”连续 3 次返回 `ARK_RESPONSE_NOT_COMPLETED`（M01 供应商响应未完成），未创建事项/提醒；改用可信 UI 保存同一候选：事项 `86937919-5233-4974-bf89-11965b72ce44`，再次点击“已记下”不新增事项；面板“加个提醒”创建关联提醒 `92698e49-ea87-4461-a573-ecf2f85ad19c`（01:56 scheduled）。
- 工作稿：复用测试工作稿「出门前检查清单」，只改第二段（手机行）→“保留修改”发布 v3；撤销→v4 恢复原第二段；首/三段保持不变；保存为便签 `0f7695a4-a705-49ac-972c-6206a5598a1a`。TXT 导出打开原生保存框（默认 `出门前检查清单.txt`、位置“文稿”），需人工点“保存/取消”；MD 同理，未以写文件冒充。
- alpha.14 授权后：凭据读取恢复（“文字与实时语音已配置”），DEC-058 实测通过；自然保存追问成功：同一事项 `86937919-…` 更新到 v2，创建关联提醒 `806e73b4-…`（11:35，scheduled）；重复保存同一候选返回同一事项、未新增事项或提醒（回复“不重复建提醒”，linked 保持 2 条）。两轮 M01 各约 50s，期间“正在想”可见。
- `ARK_RESPONSE_NOT_COMPLETED` 在 alpha.14 未复现、诊断日志无新增；前一包失败属未定，不先下结论或盲改；诊断保留在构建中。为避免干扰，已取消本批合成提醒 `806e73b4`（11:35），其余 due 提醒与用户原有提醒未动。
- alpha.15（DEC-059，`8e882b8`，资产 3.5.6）：任务 `web_search` 采用 `limits.taskSearchCandidates=5`（原 provider 默认 10 是本次 10 候选/11 来源过度扩张的直接原因），查询/读页/轮次/时长预算与实时语音预算不变；前端“正在想”增加已用秒数。待用真实自然查询验证候选数与耗时。
- alpha.13 包保留：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha13-e1/`（ZIP 148,345,052 字节，SHA256 `2e91478a…`）。
- alpha.12 启动时出现 macOS 钥匙串授权对话框（“Seamo AI R1 Safe Storage”），需用户输入登录钥匙串密码；当前无 GUI 自动化权限（AppleScript 辅助访问被拒），无法代替用户授权。授权后继续 E1 的重复保存与工作稿流程；TXT/MD 原生保存框同样需要可用的 GUI 输入权限。
- alpha.12 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha12-e1/`，ZIP 148,343,367 字节，SHA256 `7c59d8c082476083eb286b8b2e112fc4b5c4bef920d091ce1e04c7ca7156d821`。
- 同步：`9dc75d3..84b1ae9` 已推送成功（远端=本地 `84b1ae9`）；PR #1 文案为 alpha.13。

## D5 集中收口与内部验收包

- 41项逐项盘点见 [R1交付清单](R1-delivery-board.md) 的“D5 41项盘点”；D1–D3 状态统一为开发已交付/实包待验收，不把未跑组合测试列为新开发需求。
- 核对：Space 输入框守卫、按住说话/失焦收尾、窄窗覆盖层（≤1050/≤760）、Focus 重启恢复为 paused、Task needs_resume、备份/恢复/诊断入口与脱敏、vault 凭据路径均已有实现；未发现新的产品代码缺口。
- 内部验收包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha11-d5/`
  - `Seamo AI R1.app`（397M）、`Seamo-AI-R1-1.0.0-alpha.11-mac-arm64.zip`（148,341,382 字节，SHA256 `74162bd84968640ea671f5d6827d019bc6f1f148f2a0b5b97e9e2cb9c61646b6`）
  - 包源 `29a2915`；资产 3.5.2、schema 3.2.0、SQLite 12；bundle `com.seamo.ai.r1`；无 `.env`/凭据/用户数据库；本机 ad-hoc 签名，未公证。
- 已推送 `codex/seamo-r1` 至 origin 并更新 PR #1 交付说明；未合并 main、未创建 Release。
- 真实 GUI/语音/设备/通知/安装回退与音乐资源仍待验收；外部音乐样本结论只陈述观察事实，不推断版权根因。

## D4 开发完成（音乐本地闭环与外部资源阻塞）

- 有界复验：netease 200 但无周杰伦原版；kuwo 服务端 400“source is not supported”；joox 命中但资源 URL 503。未发现可修适配缺口，未新增供应商/未改默认源顺序。
- 修复：聚合服务明确不支持某 source（400/404/410）时，默认“全部”搜索对其退避 10 分钟，避免重复探测；显式单源请求仍真实重试。
- 验证：新增本地流程（搜索→播放第二首→seek→LRC 以音频时钟定位→20% 降音/恢复→入队→下一首）；音乐关联 8 文件 61 项、typecheck、构建通过。fixture 只证明本地播放器逻辑，不冒充线上点歌/真实扬声器。
- 资源阻塞：需要该查询在现有源中存在可解析的真实资源（netease 原版条目或 joox 资源恢复）；只陈述观察事实，不推断版权归属，也不代表所有音乐不可用。
- 版本：资产 3.5.2、schema 3.2.0、SQLite12 不变。

## D3 开发完成（工作稿、临时模式、播报审计）

- F09：核对既有能力并用 `tests/artifactLifecycleFlow.test.ts` 验证同一 Artifact 的版本链：范围续改 v1→v2、撤销 v3、以 v3 保存为同一 Item（再保存更新同一 itemId 到 v2）、导出已确认版本字节一致；陈旧版本续改/导出均 VERSION_CONFLICT 且不写文件。未重写编辑器/页面。
- F04/F04e：新增 `r1.session.temporaryPersistence` 类型化 IPC 与 `R1SessionMode.temporaryPersistenceConfirmed`（仅内存，切临时/普通或结束会话清零）；事项面板复选框成为可信确认入口；文字与原生实时 scope 共用 `temporaryPersistenceAllowed`，未确认仍拒绝写入，不交给模型推断授权。PR03 补充临时保存说明。
- F07c/F10：SQLite schema 12 新增 `delivery_announcements`，只在原生播放回执 started/playing/completed/interrupted 时写审计；`announcedAt`=首次真实可听，`completedAt`=完整播完；关联 reminder/followup/focus/task+result 与 responseId/playedMs，requestId 幂等；到期/卡片/生成文本不写审计。勿扰/取消沿用既有撤销，不产生播报记录。
- 版本：资产 3.5.2、PR03 2.2.2、SQLite 12；工具 schema 3.2.0 不变；DEC-055。
- 验证：新增 deliveryAudit 3、temporaryPersistence 2、artifactLifecycleFlow 1；关联回归 82 项、typecheck、构建通过；未重复全量。
- GUI/实包仍受阻，登记为实包待验收；已按批次用 `codex queue` 投递握手与简报。

## D2 开发完成（查询与生活工具闭环）

- A 完成合同：`publish` 的 completed 不再要求所有已授权 web 工具都有回执；改为至少一条本任务真实成功且在 `receiptActionIds` 中的 web 回执，其返回来源与草稿实际引用（sourceRefs/产物/候选）相交；读页回执须 read/partial；无关成功来源不能充当完成证据。`get_task` 对旧结果的兜底同步改为“至少一条被引用成功 web 回执”。用户明确要求原文/全文时，`delegation.requiredActions` 允许声明 `web_read_page`（唯一可作为必要项的只读动作），仍由既有 requiredActions 门槛在 completed 前校验；普通查询不声明。资产 3.5.1，PR03 2.2.1/PR04 1.2.1，DEC-054。
- B 用户流程：复用既有 R1WebResult 并排比较/选中/来源读取级别/保存候选/加提醒与 `currentCandidate` 上下文，未另设计界面；新增 `tests/r1QueryFlow.test.ts` 覆盖搜索摘要完成→选第2候选→自然追问注入候选→保存同一候选→关联提醒→重复保存同 Item ID。
- C 验证：`r1QueryFlow` 1 项；`r1TaskSupervisor` 新增 3 项（搜索-only 完成、候选引用、明确读页只能 partial）；`r1ConversationTools` 新增搜索-only get_task；关联 89 项、typecheck、生产构建通过。未重复全量。
- 语义边界：改条件=新 goalVersion，按 DEC-049 旧候选失配，需重新选择；未改目标时同一候选可保存并建提醒。
- 实包/GUI 仍受阻（headless Electron 不进入 whenReady），本批只登记“实包待验收”，不重试、不使用 `.env`。

## D1b 审查修复（三个闭环缺口）

- pending 终态：取消（UI/保存框）、TTL 过期、窗口/会话撤销、确认失败都会调用 `onTaskActionSettled→settlePendingUiAction`，从原 Task 的 `pendingUiActions` 移除并写入 `uiActionOutcomes`＋observation（“cancelled/expired/…，未执行”），`verifyRecovery` 对其跳过核对；恢复后可正常继续/发布，不会被 `UI_PENDING` 永久阻塞，也不会自动重试已拒动作。主进程每 30s sweep 过期 pending。
- 同窗口第二份确认：不再静默替换，返回 `ITEM_ACTION_ALREADY_PENDING`，原 pending 保持有效；同批多个确认由 Runner 只执行到第一个 ui_action。
- 删除已提交但 Task 关联失败：重试先读原 actionId 的真实回执，存在则不再删除/预览，只重试关联；失败返回 `TASK_RECEIPT_LINK_FAILED`（UI 明确“事项已删除，仅关联失败”），成功则用原结果收敛并恢复通过。
- 同批依赖动作：Runner 遇到 `ui_action(awaiting_user)` 立即停止该批剩余 call，不执行依赖副作用，随后 `waitForUserAction` 进入等待。
- 验证：`r1ItemActions` 20 项（含取消结算、TTL sweep、二次确认拒绝、关联失败→恢复、同批停止）；关联 78 项；typecheck 与构建通过。未重复全量。
- GUI/实包证据仍受阻：headless Electron 不返回 `app.whenReady()`，已记录一次，不再重试、不使用 `.env`。

## 未完成 / 风险

- 真实 M01「删除→界面确认→Receipt」「导出→保存框→文件」与实包 UI 点击仍待验收；当前内部验收包为 alpha.12，旧 alpha.10 包不含本批代码。状态分层：开发已交付/实包待验收。
- Artifact 导出在本服务内补写 `notes.export` 回执（原页面 artifact 导出无回执）；待 UI/实包验证。
- 旧 `scripts/check-task-research.mjs` 仍是未跟踪诊断脚本，保留归属，不覆盖。

### 发布收口评估：减少重复钥匙串提示（不新增凭据存储）

- 实测原因：验收包为本机临时签名（ad-hoc），每次构建的二进制签名不同；macOS 钥匙串 ACL 不跨新二进制继承，故“允许”仅本次、“始终允许”也只对当前二进制生效，更新后仍会再提示。DEC-058 已让读取失败可恢复（窗口先创建、`CREDENTIAL_LOAD_PENDING`、自动/设置页有界重试），但无法免除首次授权弹窗。
- 最小可行方案（需发布侧决定，未擅自实施）：
  1. **稳定签名身份**：用固定 Code Signing 证书签名验收包（本机登录钥匙串自签名证书，或 Apple Developer ID）。签名身份固定后，首次“始终允许”即可跨构建保留，减少重复提示；不改变 vault 加密与读取逻辑。
  2. **发布版**：Developer ID 签名 + 公证（当前不具备条件，外部阻塞）。
- 明确不做：不另造凭据存储、不写明文/`.env`、不允许所有应用访问、不自动修改钥匙串 ACL 或系统权限；“允许/始终允许”始终由用户手动选择；不承诺临时签名每次更新免提示。
- 未决前：每个新验收包仍需用户授权一次；已保存 Key 无需重填，加密文件不删不覆盖。

## E2 三条主链（真实窗口，alpha.15；alpha.16 集成修复待复测）

- 链① 记忆：真实“记住 BLUE-42”→“普通会话答 BLUE-42”→“更正 BLUE-43”（记忆 v2、deletionEpoch 1、回复旧上下文停止）通过。**遗忘缺口**：`memory_forget` 显式授权只认“忘记/遗忘/删除”，用户自然表达“忘掉”被拒且模型转述为“需界面确认”；已修代码（加入“忘掉/清除”，保留“不要/别…忘掉”否定保护）并加单测，真实遗忘与“下一轮不复活”待 alpha.16 复测。只操作合成记忆。
- 链② 临时：真实临时对话问 BLUE-43 答“没有记录”（未读长期记忆）✓；临时消息未落库（messages 新增 0、无临时 session 行）、退出提示“临时聊天已清除”✓。**临时保存缺口**：面板已勾选“我确认…”（temporaryPersistence confirmed=true），但模型仍不调用 notes_create，声称“工具未开放”，无回执、事项未建；已修 PR03：确认后先 load_skill 再调用保存工具并等真实回执，面板勾选只是授权；真实复测待 alpha.16。未把临时聊天落盘。
- 链③ 重启（同包 alpha.15 一次）：重启前 reducedMotion=true、专注 running、3 事项/4 提醒；重启后专注 `paused`（UI 显示“已暂停”）、偏好 ReducedMotion=true、事项 3、提醒 4 全部保留，无重复写入；随后已恢复偏好为 false、停止合成专注。**Task 待恢复未触发**：退出时无 running 任务（查询先完成），该子项为验证缺口，未见代码缺口。
- 查询效率实测（alpha.15，DEC-059 已生效）：自然“查一下 RFC 9110 简介和两个官方来源”→约 18s 受理、26/28/46s 进展、两次搜索合并 6 候选（单次上限 5，原 10/11），但 141s 仍以 partial“预算耗尽”结束。候选收敛有效、耗时未解决；DEC-060 增加“预算剩余<30s”一次性执行提示（不增预算/查询/读页）、模型请求前 progressBrief 更新、任务早收敛提示，实际效果待 alpha.16。
- 回归修复：alpha.15“发起后台任务”仍报 `ARK_TOOL_SCOPE_OR_SCHEMA_INVALID`；诊断 `start_task Cannot read properties of undefined (reading 'map')`，定位 modelBoundary 对可选 delegation 数组未判空（DEC-057 引入）；已修并对缺省/空数组/显式值加测试，越界别名仍拒绝，不扩权。
- 集成包 alpha.16：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha16-e2/`，源码 `164b354`，资产 3.5.7，ZIP 148,351,784 字节，SHA256 `1530c8fd6fa0bb386d9bf54d476117afaa0d35f574d082d60c16fe048fbc43ff`；typecheck + 相关 39 项测试通过；无 `.env`/凭据/用户库。真实复测需新二进制钥匙串授权一次；TXT/MD 原生保存框仍为人工步骤。

## E2 最终结果（alpha.16 集成包真实窗口）

- 链①（真实通过）：合成记忆 BLUE-42→普通会话回想→更正 BLUE-43；alpha.16 自然“忘掉我的合成测试代号”成功（memory entries 0，回复“已忘记…旧上下文停止使用”）；下一轮追问答“我不确定，没有查到有效代号”，不复活旧事实。否定保护与显式目标/版本确认保留，只操作合成记忆。
- 链②（真实通过）：临时对话不读长期记忆；事项面板确认保存范围后，模型加载技能并实际保存「E2 临时保存验证 2」（itemId c11b0a5b…，v1），`receipts` 有 succeeded 保存回执（actionId 71f35eca…），不再出现“工具未开放”；退出临时后该事项保留、临时消息未落库（messages 无临时行、sessions 无临时行）、确认标记复位。
- 链③（部分通过，Task 在飞重启未触发）：同包 alpha.15 一次重启后专注 running→paused（UI“已暂停”）、偏好与 3 事项/4 提醒保留、无重复写入；本轮多次尝试在 Task 运行中退出均未命中（任务先完成或 M01 ARK_REQUEST_TIMEOUT），因此“运行中 Task 重启→needs_resume”仅由单元/监督器测试覆盖（`r1TaskSupervisor.test.ts` 的 interrupted→needs_resume 用例），真实在飞重启仍为验证缺口，未见代码缺口。
- 查询耗时（alpha.16，单独记录，不增预算）：一次自然“查 RFC 9110 发布时间”→约 36.8s 受理、59.4s 完成，4 候选/4 来源，completed（alpha.15 同类为 141s partial，单样本仍属体验区间）；另一次尝试 M01 ARK_REQUEST_TIMEOUT（供应商不稳定），不作为修复结论。
- 包：alpha.16 `/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha16-e2/`，源码 `164b354`，资产 3.5.7，ZIP SHA256 `1530c8fd6fa0bb386d9bf54d476117afaa0d35f574d082d60c16fe048fbc43ff`；无新包。
- 人工/外部：每个新验收包首次钥匙串授权由用户完成；TXT/MD 原生保存框仍为人工步骤；GitHub 推送网络超时（本地 `878a1e0`/远端 `7147f4b`，未强推未改远程）。
- 合成对象：记忆已遗忘；事项「E2 临时保存验证 2」保留为可识别合成对象；临时聊天未落库；合成专注已停止、合成偏好已还原。

## E3 设置/数据/备份恢复与隔离验证（真实窗口 + 隔离集成）

- 设置与配置：真实窗口读取 persona（Seamo AI/balanced/v2/voiceId）、preferences(v3)、onboarding(completed)；reducedMotion 合成变更在**同包一次重启**后仍保留，验证后已还原为 false（v3）；引导完成状态持久化。跳过引导路径 `finishWelcome('home')` 仅写 `onboarding.complete({skipped:true})` 并关闭弹窗，不启动麦克风；`onboarding.test.ts` 覆盖跳过持久化/拒绝额外授权字段/权限 0600/损坏状态。
- 数据与恢复（隔离目录/DB，不触碰用户数据）：备份排除凭据与 legacy 原始 JSON、文件 0600、独占发布；诊断只含阶段/状态与数值 trace，含 `privacy` 声明，测试断言聊天正文/Key/原始音频不出现；还原前校验备份 schema（1..12）/integrity/外键/必需表，当前 schema 不符拒绝，失败保留当前库并生成 pre-restore 回滚副本；还原合并当前删除抑制/更正版本，旧备份不能复活已遗忘记忆或更正前事实（含 Topic）；保留当前自动记忆 opt-out 与偏好；清理预览需 owner/过期/未变更确认，删除只影响选中范围。
- Task 重启恢复：新增**隔离集成测试**（标注 isolated integration）：running 任务在模拟进程中断后重开为 `needs_resume`（进度“应用已重新启动，等待你继续。”），`claimNext` 不自动执行，`resume` 后为 accepted（“准备继续，先核对已提交的步骤。”）再 running，已提交写入不重放、事项仍 1 条。真实在飞任务重启仍未在真实窗口触发（多次尝试任务先完成/云请求超时）；该项按隔离集成证据记录，真实包验收列为待验收。
- 修复：`r1DataCleanup.test.ts` 硬编码 schema 11 改为 `R1_SCHEMA_VERSION`（当前 12）；E3 关联 10 文件 62 项测试通过、typecheck 通过。
- 人工步骤（仅一项）：工作稿 TUI 导出时，系统保存框出现后由用户点“保存”（默认文件名/位置由系统框给出）；不阻塞其余功能。
- 外部阻塞不变：音乐真实可用音源、Developer ID 签名/公证、真实设备听测与安装回退验收；当前候选包 alpha.16（源码 164b354；交付文档 HEAD 39513e7，仅测试/文档提交）。
- F11a 窄窗覆盖（真实 renderer 视口模拟，非整窗拖动）：900×1000 时侧栏 84px、设置面板 x=84/宽 816 覆盖内容区；700×1000 时侧栏变底部 64px、设置面板 x=0/宽 700 全宽覆盖，与原型窄窗层级一致。整窗手动拖动验收仍待实包。
- GitHub 凭据当前失效（`gh` token invalid，push 报 could not read Username），本地 `39513e7` 未推送、远端 `e0aed5c`；需用户重新 `gh auth login` 或恢复网络凭据，未强推/未改远程。
- F10b/F11b 真实 UI（**隔离 userData + 受控注入**，非用户数据）：用 CFFIXED_USER_HOME 启动 alpha.16，隔离库预置“运行中”任务；启动后 UI 显示“上次还有 1 项委托未完成 / 尚未重新执行。选择继续后，会先核对已保存的结果。”；任务面板显示“等待继续 / 应用已重新启动，等待你继续 / 继续 / 取消任务”；点击“继续”后任务实际恢复执行（隔离环境无模型配置，得到 ARK_NOT_CONFIGURED → partial），未重放已提交写入（items 0）。首次引导真实弹窗显示“跳过引导不会开启自动会话/自动记忆”，点击“暂时跳过，进入空间”不启动麦克风。已退出隔离实例并清理 `/tmp/seamo-e3-recovery`；该证据标注为隔离集成/受控注入，不冒充用户实包验收。


## E4 音乐/歌词/粒子/降音（有界真实检查与代码核对）

- 有界真实检查（仅元数据/URL，不下载不播放）：netease 对备用曲目“月亮代表我的心（邓丽君）”“Yesterday (Remastered)（The Beatles）”均命中原艺人/曲名候选并解析出 audioUrl，HEAD 返回 200 audio/mpeg（约 8.36MB / 4.95MB），封面可用、LRC 分别 34/20 行；joox 对“Yesterday”资源不可用（此前 503），joox 搜索中仍有“告白氣球/周杰倫”等精确候选，未将其冒充为原曲；kuwo 仍服务端不支持；netease 对“晴天/周杰伦”原版仍无精确候选。结论修正：**不是所有音乐都不可用**，之前阻塞是曲目/来源特定；不静默替换点名歌曲，未新增供应商。
- 代码核对（无新缺口）：`useMusic` 仅在 `audio.play()` 成功后把状态置 playing（实际音频决定播放）；歌词位置由 timeupdate 的 `audio.currentTime` 更新；`MusicDucking` 的 base 音量与语音衰减 factor 分离，用户在降音期间改音量/静音会作用于最新 base，恢复不会复活用户暂停或旧音量；粒子分析用 AnalyserNode 真音频，分析失败才降级。相关单元/流程测试在 D4/此前批次已覆盖，本批未重跑已通过段。
- 未完成/环境阻塞：当前 Mac 屏幕已锁定/熄灭，无法操作真实音乐视图或进行真实音频/歌词/粒子/边听边聊听测（且不希望在无人时出声）。需用户解锁后允许一次短时本地播放验证（可低音量/音量0）。
- E4 环境限制补充：显示器已关闭/锁定时，真实窗口的 `<Transition mode="out-in">` 离开过渡不结束，音乐视图不挂载（DOM 中 conversation 停在 view-fade-leave-active）；这是隐藏窗口 rAF/过渡时钟停摆的环境现象，不是产品缺陷。已尝试 reducedMotion 与强制 transitionend 均不能替代真实窗口；合成 reducedMotion 已还原为 false(v5)。真实音乐播放/歌词/粒子/降音/边听边聊需等用户解锁屏幕后验证，届时可低音量或音量0进行。

- 推送恢复：改用 SSH（git@github.com）推送成功，远端 `codex/seamo-r1` = `0e7d0a2`（含全部本地提交），未改 remote/未 force；`gh` token 仍 invalid，PR 描述更新待有效 token（代码/分支已同步，PR 自动显示新提交）。

## E4 真实音乐/歌词/粒子/降音实测（屏幕解锁后）

- 真实播放：netease「月亮代表我的心/邓丽君」在真实音乐视图播放，音量 20/100；audio 时钟从 21.86s→30.62s 前进，歌词当前行随音频时钟从「我爱你有几分」变为「月亮代表我的心」（`data-current=true`），音乐视图与粒子 canvas 可见；界面显示 SEAMO SESSIONS · NETEASE、封面与时长 3:28。
- 用户控制优先：点暂停后 playState paused、position 冻结在 30.894s（2s 不变），点「继续播放」后恢复前进；播放中把音量设 0→20，playState 保持 playing，baseVolume 正确。
- 语音降音（真实 TTS 提醒触发）：创建合成提醒到期播报后，音乐有效音量在播报期间降至 base×0.2；播报中途把用户音量从 20 改为 40，降音期间有效音量为 0.08（40%×20%），播报结束后约 300ms 恢复到 0.40（用户最新音量），证明用户音量优先、恢复不复活旧值；暂停/静音规则由前述实测与单测覆盖。
- 导出：真实保存框已出现（`保存 出门前检查清单.txt`，位置「文稿」，按钮 取消/保存），需用户点「保存」完成写入；MD 同流程待用户点击后复测。
- 重启后钥匙串读取失败（-25293 auth failed，界面「服务状态读取失败」）；本地导出/音乐可用，设置页有「重新读取服务配置」重试入口；模型相关需重新授权或设置页重试。

## E4 TXT/Markdown 导出实测（真实保存框，用户在场/授权）

- 通过真实 `artifacts.export` 打开系统保存框，用默认名与位置分别保存成功：
  - TXT：`/Users/sea/Documents/出门前检查清单.txt`，207 字节，权限 0600，API 回执 cancelled=false/version=4。
  - MD：`/Users/sea/Documents/出门前检查清单.md`，209 字节，权限 0600，API 回执 cancelled=false/version=4。
- 内容均来自 artifact `e2be9543-2010-4d9a-9e01-25d8501d9d59` v4（出门前检查清单，钥匙/手机/关灯三项），非伪造。
- 观察：artifact 正文自带 H1（`# 出门前检查清单`），导出又加标题，导致 TXT 出现纯标题+H1、MD 出现重复 H1。属于导出观的轻微内容重复，已记录为待产品/Codex 判断是否统一；不阻塞导出路径本身。
- 该批使用系统保存框默认按钮完成（用户在场；此前无可见框的原因是应用未处于前台，非导出功能缺失）。
- E4 补充：真实歌单收藏可持久化（收藏数 2，含「月亮代表我的心」）；重启后再次搜索出现「音乐搜索暂不可用，请检查网络或切换音源」（请求失败；未保留 HTTP 状态码/错误日志，无法定性网络/供应商/配置/适配，不称“瞬时外部失败”；未反复请求）；重启后钥匙串读取失败，设置页字段显示“状态不可读，原配置保留”，未改写配置；「重新读取服务配置」已尝试但未弹出可完成的钥匙串授权，需用户在场时再授权。
- E4 结论：真实播放/歌词时钟/粒子可见/用户暂停/音量优先/真实 TTS 降音恢复/收藏持久化/TXT+MD 导出均已有实测；音频“可听”与粒子视觉的主观确认、队列/下一首交互及边听边聊待用户确认/后续批次；未改代码、未重打包。
- E4 原型交互补充：音量滑杆真实 UI 生效（base 30 后还原 100）；收藏持久化（收藏数 2）；从收藏播放 netease「爱琴海」失败（资源不可用，未替换他曲）；重启后再次搜索仍「音乐搜索暂不可用」（一次重试即止；无保留状态码/日志，不能定性；不反复请求）；seek 因播放失败未验。退出播放正常回到 conversation/idle，音量已还原 100。
- 结论：E4 的可执行真实项已完成到当前外部条件允许的最大范围；剩余为用户听感/粒子主观确认、队列/下一首/边听边聊（依赖音源恢复与钥匙串授权）、以及钥匙串重新授权。
- 导出取消（真实保存框）：调用 artifacts.export 后按 Esc 取消，API 返回 `{cancelled:true}`，不产生成功回执；既有 `~/Documents/出门前检查清单.md` SHA256 保持不变（取消不覆盖、不报成功）。覆盖 A17/A57 的取消分支。

## E4 收口补充（alpha.17）

- 导出修复（产品决定）：正文首个非空行若为与 Artifact 标题相同的 H1，则不再加导出标题；TXT/MD 同一规则。已补单测（4 项通过）并在 alpha.17 真实保存框验证：`E4-fix-check.txt` 与 `.md` 均 184B、内容一致、仅一个 H1；既有用户导出 `出门前检查清单.txt`(sha `a1e22e27…`)/`.md`(sha `9dfa13be…`) 未被覆盖。
- 真实音频驱动粒子证据：播放 netease《月亮代表我的心》时对 AnalyserNode 取样 44 帧、39 帧非零，sum 波动约 5200–6390、max bin 196–239（128 bin），粒子 canvas 同时可见；说明频谱数据来自真实音频而非仅 canvas 存在。
- 队列/下一首：搜索《Yesterday》并把 `Yesterday (Remastered)/The Beatles` 加入队列（queue 1→0），点“下一首”后切歌为 Yesterday、真实播放 pos≈0.47s、歌词行更新、analyser 继续非零；音量保持 20。
- 用户控制优先级复测（alpha.17）：暂停后冻结、继续恢复；音量 0/20 切换时 playState 仍 playing；随后音量还原 100、退出播放回 conversation/idle。
- 边听边聊未完成：alpha.17 仅执行一次「重新读取服务配置」，钥匙串仍失败（-25293），界面仍“服务状态读取失败”；未再次重启、未删/改 vault、未重填 Key。需用户在系统钥匙串弹窗输入登录密码并允许（或授权后告知），再做真实语音边听边聊；用户听感/粒子主观确认仍待用户，不代填。

- 当前窗口状态说明：alpha.17 构建与窗口切换发生在收到“暂不切换 alpha.16 窗口”指示之前；现运行窗口为 alpha.17（PID/路径见上），alpha.16 包保留未删。按指示不再切换/重启，等待用户在现包完成一次服务配置重读并反馈结果；不再重试钥匙串、不删/改 vault、不重填 Key。
- E4 未验项准确列示：seek 未验（资源/播放失败时未做）；粒子视觉/听感待用户确认；真实用户语音边听边聊未验（钥匙串未恢复）；队列/下一首与 Analyser 非零取样仅为 alpha.17 候选包实测，不代表 alpha.16 现包；静态代码核对不计为通过。

## 服务配置重读结果（alpha.17 现包，只读观察，未再触发）

- 设置页当前明确提示：「系统钥匙串暂时不可用。请手动解锁 login 钥匙串后重试；已保存的加密配置保留。」
- 启动日志仅有：`Keychain lookup failed ... Code=-25293 "errKCAuthFailed / errSecAuthFailed: Authorization failed."`；无其他配置读取/网络/供应商错误。
- 分类：**配置读取异常（login 钥匙串不可用/授权失败）**，不是网络、供应商响应或音乐适配异常；已保存加密配置保留，未删/改 vault、未重填 Key。
- 人工最小操作：打开「钥匙串访问」→ 解锁 `login` 钥匙串（输入 macOS 登录密码）→ 回到 Seamo 设置点一次「重新读取服务配置」。完成后再继续真实语音边听边聊与模型相关验收。
- 搜索失败仍未留 HTTP 状态码/错误日志：仅有渲染层“音乐搜索暂不可用”提示；单次只读复核 `music.search` 成功返回 10 条。不能定性网络/供应商/配置/适配；不称“瞬时外部失败”。未再重复请求。
- 窗口状态：现窗口 alpha.17（切换发生在最新指示前），alpha.16 包保留；按指示不再切换/重启，等待上述钥匙串人工操作结果。

## 授权弹窗准确状态（一次查看，2026-10-18 21:27）

- 无可见系统钥匙串弹窗：`SecurityAgent` 进程不存在；`CoreServicesUIAgent` 无窗口/按钮；截图无授权框；Seamo 设置页字段显示「状态不可读，原配置保留」，底部「服务状态读取失败」。
- `security show-keychain-info ~/Library/Keychains/login.keychain-db` 报 "The user name or passphrase you entered is not correct." → 当前会话无法读取/解锁 login 钥匙串；因此没有请求者/项目名/按钮可回报（无弹窗）。
- 最小恢复步骤（用户操作）：打开「钥匙串访问」→ 左侧 login 钥匙串 → 点锁图标解锁（输入 macOS 登录密码）→ 回到 Seamo 设置点一次「重新读取服务配置」。若届时出现系统框，再准确回报请求者（预期 Seamo AI R1）、项目（预期 Seamo AI R1 Safe Storage）与按钮。不代输密码、不改 ACL、不删 vault/重填 Key。

## 搜索失败归因（已有证据核查）

- /tmp 应用 stderr 仅钥匙串错误与一条 `music_set_volume input_invalid`；无 music search HTTP 状态/错误日志。
- 统一日志检索无相关条目；`event_log` 仅记忆事件；无 music.search 回执。
- 数据库 receipts 可分类的是播放/seek 失败：`music.play MUSIC_RESOURCES_EXHAUSTED`（13:18:30Z）、`music.seek MUSIC_DEVICE_PLAY_FAILED`（13:18:34Z）——支持“seek 因播放失败未验”，不能用于搜索归因。
- 结论：此前搜索失败**无日志/状态码证据，归因待定**；之后单次请求成功返回 10 条，不称网络/供应商/配置/适配任一原因。未再重复请求。

## 导航/输入/失败恢复修复（源码，待集成包实测）

- Escape 关闭侧栏/搜索面板（settings/items/memory/history/search），不关闭有未保存编辑的 task 面板；关闭后焦点回输入框。
- Escape 关闭音乐资料库。
- 音乐搜索失败提示带错误码，并在资料库提供「重试搜索」；搜索成功清除提示。
- 测试：`tests/panelDismissal.test.ts` 1 项、`musicBridge/musicIpc/musicMelodyFlow` 21 项通过；typecheck 通过。真实 UI 行为需集成包验证（本轮按指示不打包/不切换）。

## ① 现包真实 seek（alpha.17，未重复播放/切歌段）

- 可播放 netease《月亮代表我的心》播放中，拖进度到 120s：position 立即到 121.05s，当前 LRC 行立即重算为「月亮代表我的心」；离线只读取 provider LRC 同曲 120s 行也是「月亮代表我的心」，映射一致。
- 暂停后拖到 45s：position 精确为 45s，playState 仍 paused，LRC 行为「我爱你有几分」；1.2s 后仍 paused/45s（未自动恢复播放）。provider LRC 在 45s 行同为「我爱你有几分」。
- 结论：真实播放中 seek、暂停中 seek、音频 position 跳转与 LRC 按 seek 目标立即重算均通过；不再重复已过播放/切歌。
- 音量已还原 100、退出播放回 idle/conversation。

## ② F11d 音乐失败诊断（源码已实现，未打包/未重启现包）

- 新增 `electron/main/r1/musicDiagnostics.ts`：失败写入既有 `event_log`（kind=`music_failure`），payload 仅含 provider、phase、安全错误码（大写码或 `unknown`）、upstreamStatus（100–599 或 null）、traceId、durationMs；不落原始搜索词、响应正文、URL/查询参数、请求头、凭据或聊天内容。
- 已接入 `r1.music.search` 失败路径，以及 `r1.music.control`/`r1.music.exit` 失败；诊断写入失败不影响原操作结果。
- `diagnosticExport.ts` 新增 `musicFailures`，导出前二次净化：丢弃额外字段、跳过非法 traceId/时长，隐私标记新增 `searchQueriesIncluded:false`、`upstreamPayloadsIncluded:false`。
- 验证：`r1MusicIpc` 4 项（含含敏感串的搜索失败、已知安全码、恶意 event payload 脱敏）与 `r1DataManagement` 7 项通过；typecheck 通过。真实诊断导出需集成包验证（当前窗口 alpha.17 不含此源码，不为此打包/重启）。
