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
- 资源阻塞：需要 netease 具备原版曲目版权或 joox 资源 URL 恢复；不阻塞本地代码交付，实包听测单列。
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

- 真实 M01「删除→界面确认→Receipt」「导出→保存框→文件」与实包 UI 点击仍待验收；当前运行 alpha.10 不含本批代码，不能归因或替代。状态分层：代码已提交/审查待改/实包待验收。
- Artifact 导出在本服务内补写 `notes.export` 回执（原页面 artifact 导出无回执）；待 UI/实包验证。
- D2：Web 完成合同维持现状，不在本批改动。
- 旧 `scripts/check-task-research.mjs` 仍是未跟踪诊断脚本，保留归属，不覆盖。
