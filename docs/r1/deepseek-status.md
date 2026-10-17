# DeepSeek 开发状态（D1 起）

工作目录：`/Users/sea/Documents/ai_alex-r1`，分支 `codex/seamo-r1`，基线 `2309788`（资产 3.4.2/schema 3.1.0/SQLite11）。

## 批次

| 批次 | 范围 | 状态 | 提交 |
| --- | --- | --- | --- |
| D1 | notes_delete/notes_export：文字＋原生实时语音＋Task＋可信 UI 非阻塞桥；DEC-053；资产 3.5.0/schema 3.2.0 | 代码完成，待审查；真实服务证据受阻 | `86489a9` |
| D1a | 审查修复：保存框中真实态复核、并发导出单提交、Task 立即等待、remainingReminderIds、导出回执身份 | 代码完成，待正式审查 | `68d3abd` |
| D1b | 审查修复：取消/过期/替换结算到原Task、删除已提交后关联恢复、同批仅执行到 ui_action | 代码完成，待正式审查 | 本批提交 |
| D2 | Web 完成合同（有效引用/读取级别/用户明确要求/真实缺口） | 未开始，待 D1 审查 | — |

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
