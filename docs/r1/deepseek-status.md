# DeepSeek 开发状态（D1 起）

工作目录：`/Users/sea/Documents/ai_alex-r1`，分支 `codex/seamo-r1`，基线 `2309788`（资产 3.4.2/schema 3.1.0/SQLite11）。

## 批次

| 批次 | 范围 | 状态 | 提交 |
| --- | --- | --- | --- |
| D1 | notes_delete/notes_export：文字＋原生实时语音＋Task＋可信 UI 非阻塞桥；DEC-053；资产 3.5.0/schema 3.2.0 | 代码完成，待审查；真实服务证据受阻 | `86489a9` |
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

## 未完成 / 风险

- 真实 M01「删除→界面确认→Receipt」「导出→保存框→文件」与实包 UI 点击仍待验收；当前运行 alpha.10 不含本批代码，不能归因或替代。
- Artifact 导出在本服务内补写 `notes.export` 回执（原页面 artifact 导出无回执）；待 UI/实包验证。
- D2：Web 完成合同维持现状，不在本批改动。
- 旧 `scripts/check-task-research.mjs` 仍是未跟踪诊断脚本，保留归属，不覆盖。
