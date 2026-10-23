# R1 任务生命周期与工作稿进展

日期：2026-10-14。changeId：DEC-R1-TASK-ARTIFACT-008。对应 F03a/F03b、F04e、F09a–F09c、F10b 与最终 PRD 4.3/4.7/5.1。**G0–G5 仍未整体验收通过；本记录是开发检查点。**

## 当前进度和后续顺序

- 旧版分支、已有工作目录与数据保留；本轮只修改独立 `codex/seamo-r1` 工作树。
- 正式主框架、共用输入、记忆/事项/设置侧栏已有局部实现和实测；O03 宽结果区、O05 任务入口与工作稿编辑器尚未接入。
- SQLite、手动记忆、事项/提醒、Focus 已有真实领域服务；自动记忆、Topic、语义召回与完整安装恢复仍未验收。
- 本轮实现任务状态与工作稿持久化基础，隔离真实模型检查已走完内部工具到产物发布。生产聊天尚无 `start_task` 接入，不把测试结果当作已交付的用户功能。
- 接下来：完成任务工具执行与有界循环、当前主会话的注册任务控制、回执核对与预算继续，再依原型接 O03/O05/工作稿编辑；随后完成搜索证据、实时连续语音、音乐仲裁和安装验收。真实资源未配置的部分保持待验证。

## 实现与边界

### 任务

- `R1TaskSupervisor` 管理 accepted/running/waiting_input/paused/needs_resume/succeeded/partially_succeeded/failed/cancelled。受理时保存真实用户消息来源、原 turn 时间、timezone、资产 release 与权限范围；程序生成 taskId/runId/actionId/resultId。
- 一次一个活动任务，最多三个排队；运行中的暂停先请求停止，到安全点才 paused。取消保留已提交事项；普通任务重启/睡眠进入 needs_resume，唤醒不自动运行。临时任务、检查点、原文、内部回执仅存内存，临时会话结束后移除。
- 目标更新递增 goalVersion/contextVersion、停止旧 run、使旧模型发布失效；已暂停任务保持暂停，其余有效任务重新排队。受理幂等使用原始请求的不可变 SHA-256 指纹，涵盖来源、目标、条件、时区、工具授权与复杂度；修改当前目标后原受理重试仍返回同一 taskId。没有指纹的旧检查点保留，但重复受理需重新核对，不猜测原始授权。
- 预算从 manifest 验证后的 runtime 配置获取，模型决策和内部工具都计数，活动时间用单调时钟。预算耗尽后的继续窗口与完整恢复回执核对尚未实现。

### 内部工具和结果

- `read_file` 只允许注册 Skill/声明 references 和当前任务只读原话路径；不访问宿主文件或其他任务。完整读过主 Skill 文件后才记录 loadedSkillIds，局部读取不授予写工具。`write_todos` 更新内部计划，检查重复 ID、依赖与环，不创建用户待办。
- 工具返回真实成功/失败回执，校验注册输出 Schema、工具归属和 run；引用伪造的 actionId 或 unknown 回执不能发布全部成功。模型原 call_id 与工具结果保持配对。
- Supervisor 校验 TaskDraft、版本、删除 epoch、真实来源/候选/回执、Artifact 基准版本及部分完成一致性；程序提交 Artifact 与实际发布回执后生成 Result，同一 run 发布幂等。
- 修正真实检查暴露的 Skill 索引路径问题：运行时索引采用 `/skills/.../SKILL.md` 虚拟绝对路径，资产登记路径仍用于读取发布包；未修改 Prompt/Skill 源、工具 Schema 或资产 release。
- 移除“每种 Artifact 都必须先读 SK06”的额外限制：合同允许模型按目标选择 Skill，查询/比较也能产生工作稿。领域写工具仍要求其对应 Skill 已加载；没有把读取 Skill 当作用户写入授权。

### 工作稿和 IPC

- Artifact 保存正文、标题、类型、来源与所有版本；expectedVersion 阻止迟到回复覆盖手动修改。局部修改按 Unicode 码点校验非目标前后缀不变；撤销创建新版本。
- 明确保存才创建/更新同一事项；后续工作稿修改不自动覆盖事项，更新还需真实事项版本。临时保存必须明确确认，退出后保留已保存事项。
- 普通发布/保存使用嵌套 SQLite SAVEPOINT，失败整体回滚；临时多份发布使用内存事务，失败恢复该会话的版本，不影响其他会话。
- 白名单类型化 IPC 提供 list/get/pause/resume/cancel 与工作稿 get/revise/undo/save。主进程用当前会话隔离普通与临时对象，不接受渲染层提供的任务授权、runId 或任意创建入口。会话结束回调清理临时任务/工作稿；停止语音不取消普通后台任务。

## 数据兼容与回退

- SQLite schema 3→4：只增加 `artifact_versions.metadata_json`，保留正文和旧版本。缺少元数据的旧稿按 text/工作稿/空来源读取，不推断其功能验收状态。
- 打开已有较旧数据库前，以 `VACUUM INTO` 建立独立 pre-schema SQLite 快照，权限 0600，检查完整性与原 schemaVersion；快照失败则拒绝迁移。该快照不含安全存储凭据。
- 回退开发代码基准为父提交 `adc256c`。旧应用继续使用原独立数据；禁止以旧代码直接打开 schema 4，也不能直接用迁移前快照覆盖当前数据或删除抑制。迁移后数据保留，兼容恢复须走预检和抑制合并；本轮没有宣称降级恢复已验收。
- 未打 G0–G5 通过标签，没有生成正式 Release 或已安装验证产品包。

## 实际证据

1. `npm test`：56 个文件 / 306 个测试通过（2026-10-14 本机）。覆盖任务队列、幂等、旧目标失效、暂停/睡眠/重启、伪回执、真实产物版本、来源抑制、临时隔离、保存冲突、事务回滚、IPC 权限与数据库迁移快照。fixture 只用于自动化测试。
2. `npm run build`：类型检查、Electron 编译与 Vite 构建通过；产物体积提示仍存在。构建显式包含未接主循环的内部工具模块，全新构建可以重跑真实检查脚本。
3. 真实 M02 检查：`scripts/check-ark-task-publication.mjs`，2026-10-13T16:26:54.290Z（北京时间 10-14），官方 Ark Responses、现有本机模型、store:false、独立内存 SQLite。合成请求明确要求读取 work-discussion Skill，2 次决策，实际 `read_file` 1 次，7114ms，accepted→succeeded，Artifact 行 1、真实 Receipt 行 2；`publishedInProduction:false`。只证明这条内部工具/产物链路，不是自然语义盲评或生产任务验收。
4. 检查中先后发现额外 SK06 发布限制、相对 Skill 路径错误；错误阶段保持失败/部分结果，未伪造成功回执。修正后才获得第 3 项结果。本轮没有为重复相同检查再消耗真实模型调用。

## 尚未完成

生产后台循环/框架兼容、主会话 start/get/steer 控制、领域 ToolExecutor、完整 unknown 写入核对和恢复、PR08/PR10/PR07、预算继续、搜索 Evidence/Candidate、局部续改模型上下文、工作稿编辑/导出、O03/O05 与显示去重仍未完成。内部计划变更与回执的统一提交/通知边界还需接执行循环时完善。原生实时麦克风/连续 PCM/出声/打断/工具回注、真实音乐仲裁、macOS 权限、签名公证和安装验证也未完成。不能据此宣称 41 项功能或 G3/G4 已完成。
