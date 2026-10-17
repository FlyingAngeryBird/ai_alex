# R1 M02 任务请求边界进展（G3 未通过）

changeId：DEC-R1-TASK-BOUNDARY-007。对应最终 PRD 第 4.2/4.3/4.7、F03 与资产架构合同的 M02/PromptBoundary/ToolExposure。没有改变业务 Prompt、Skill 或机器 Schema。

## 实现

- 专用 `R1TaskRequestBoundary` 使用发布包 PR01/PR02/PR04；任务层不复用实时 PR03 人格/会话角色。TaskInput 和 Persona 按注册变量 Schema 验证，冻结本轮输入与资产发布/hash；角色编译从同一资产注册表获得 Skill 索引。
- 任务工具按 task 频道、已加载 Skill、公共工具和有效委托交集计算；关闭递归 Task 和宿主工具。加载 Skill 之前不能调用其写工具；临时任务排除 memory；工具预算为零时不暴露工具。
- 请求前、工具参数检查和 Responses 返回后对 taskId/runId/goalVersion/contextVersion/deletionEpoch/临时属性、running 状态、有效授权和活动预算复验。旧目标下的纯文本回答也被拒绝，不等到它触发工具后才检查。
- TaskDraft 输出格式来自 manifest 核验后的原 Schema，通过 Ark 官方 `text.format` JSON Schema 字段传输，strict:true；不临时添加业务提示词。JSON 合法性不代替引用/回执/结果完成核验。
- 8000 码点限制用于各产品正文，不用于整个 TaskDraft JSON 加元数据的长度；结构化运输层另设有界载荷，字段限额仍由原 Schema 校验。测试保留 8000 码点产物和其 JSON 元数据，并拒绝 8001 码点产物。
- Ark transport 拒绝剔除上游 SDK system 后为空的 input。真实核验第一次收到 HTTP 400/MissingParameter，已依据实际错误修正：任务目标仍在 TaskInput 中，原始请求数据也以 user 消息角色传递，不新增另一套 system。
- 构建显式包含尚未接主循环的任务边界模块，使仓库全新构建后可复跑 `scripts/check-ark-task-boundary.mjs`；该脚本仅核验协议，不创建或发布产品任务。

## 真实证据

2026-10-13T15:27:16.736Z：官方 Ark Responses、现有本机模型、发布包 2.0.1，PR01/PR02/PR04，合成临时任务、工具数 0、strict TaskDraft Schema 请求。3633ms 后返回草稿，本地 Schema 验证通过，goalVersion 一致，顶层 sourceRefs/receiptActionIds 为空，`published:false`、store:false。未发送用户历史/记忆，不保存模型正文，不把模型 draft.completed 映射为 task.succeeded；完整引用真实性仍依赖待实现的 Supervisor。

关联单元测试覆盖最终 fetch 的 PR04/system/schema、输入快照、未加载 Skill 写入拒绝、临时记忆排除、零工具预算、目标/上下文/遗忘变更、暂停、撤销授权、预算耗尽，以及返回途中目标变化时拒绝纯文本。全量 51 文件、287 项通过；随后正文/JSON 长度边界新增 1 项，相关 15 项回归与补入任务模块后的构建再次通过。

## 待实现

此边界尚未接入运行中的 TaskSupervisor。真正的 accepted/运行/排队/暂停/取消/恢复、ToolExecutor 授权来源与参数/版本/幂等/预算/提交事务、Skill 读取、框架检查点、TaskDraft 引用真实性与 Artifact 发布、PR10 一次修复、PR07 安全播报和 O03/O05 界面仍未完成。禁止据此将完整任务功能或 G3 标为通过。

回退到父提交 `9b41849` 不降级数据库，原版工作树/数据保留。无 G0–G5 通过标签、正式包或 Release。
