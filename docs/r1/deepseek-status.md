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
