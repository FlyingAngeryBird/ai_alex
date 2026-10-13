# 架构与执行合同
## 1 组件与职责
- PromptRegistry：读取十个模板、变量Schema与版本；组装稳定system，单次JSON变量替换，不执行用户文本。
- SkillRegistry：读取六个标准Skill及manifest；同一发布版本提供元信息、正文和声明资源；不开放安装、脚本执行或自我改写。
- SeamoSkillsMiddleware：将标准Skill的元信息常驻，任务按需read_file；实时按需load_skill。取代未经控制的框架Skills提示注入，不改变模型自主选择能力。
- PromptBoundary：在最终模型请求处重建system，只来自注册模板和当前所需的Skill正文；其余SDK自动system文本不作为业务指令发送。维护实际Prompt hash，检查是否有未注册指令。工具description也从目录提供。
- ToolExposure：最终模型看到的工具集合与schema采用当前合同；先计算频道集合，再计算已加载Skill工具并加入已允许公共工具，取有效授权交集。拒绝未知别名，不能仅靠Prompt禁用。
- ToolExecutor：工具建议→参数/作用范围校验→来源授权→版本与幂等→预算→真实执行→提交前重验→Receipt。
- TaskSupervisor：快速受理、队列、版本、检查点、暂停取消、结构化结果验证。负责生成runId/actionId/requestKey、分配Artifact/resultId与最终发布，不让模型造这些ID。
- ConversationCoordinator：唯一播音所有权；区分助手已播和未播内容；可聊时提交任务，任务完成先卡片后合适时机一次语音。
- Memory/Context/领域服务：SQLite真实对象与回执；调度本地到期；删除epoch跨组件立即失效。

## 2 明确的链路
普通会话启动→验证配置→建立sessionGeneration→编译PR01/PR02/PR03＋SK01＋AppContext→建立M01会话。
M01理解→直接回复/必要澄清/即时工具/start_task；所有新输入继续进入M01，不等待后台工作完成。
start_task→TaskSupervisor创建Task返回accepted→M02执行PR01/PR02/PR04→按需Skill→工具观察→修订计划→有效TaskDraft→Supervisor验证发布→PR07在可播条件表达。
steer_task→程序递增goalVersion→使旧提交与发布失效→以PR08和最新TaskInput恢复模型决策；取消/暂停先经程序状态检查。
提醒到期→本地scheduler生成deliveryId→静默卡片或协调器准许PR09→实际播放后更新announcedAt。模型不决定什么时候到期。
事实提取→普通会话且有效自动授权才调用无工具M03＋PR05→Schema＋来源/授权/删除epoch复验→候选提交。摘要→容量条件成立才调用无工具M03＋PR06；普通摘要按来源保存，临时摘要仅内存、不能混入普通上下文。
结构化结果不合法→记录最小诊断→无工具PR10一次修复→仍不合法则structured_output_invalid，不发布假成功。
临时会话→独立上下文与内存Task→结束取消未提交动作并丢弃正文；已经明确保存的Item/Reminder等仍存在。

## 3 默认框架能力的处理
Deep Agents提供通用模型工具循环与LangGraph运行能力。默认Skills、Memory、Summarization、TodoList业务指令由应用控制实现替代；general-purpose子Agent关闭。
Filesystem/SubAgent必需支架不列入excludedMiddleware；使用工具排除与只读虚拟backend约束。仅允许任务侧read_file；write_todos由Seamo AI注册的计划工具提供。
SDK名称与profile解析在G0按锁定版本核验；配置排除之外，最后一道PromptBoundary与ToolExposure始终核对实际请求。不能因某个middleware名字失配而继续暴露默认指令或工具。
框架tool-call配对修补属于协议能力；要保存原call_id并以应用确定的错误码回执，不能制造领域成功。框架自带摘要和云日志默认关闭；摘要仅用M03＋PR06。

## 4 Prompt组装与数据等级
PR01产品边界→PR02人格表达→运行角色PR03或PR04→需要的Skill指导→有效AppContext/TaskInput→原用户消息与真实工具回执。
这是应用对输入的解释规则；协议只能容纳一个instructions字符串时编译成同一文本。动态资料用JSON编码，不拼成额外system命令。
PR05/PR06单独只用PR01和自身任务模板，不装入全量聊天工具。PR10修复只带目标Schema、原输出、有限错误和有效引用，工具集合为空。
PR07/PR09是“应用事件”，不是冒充用户的新委托；在原有角色指令下静默注入或可控播报。若原生接口不支持所需静默语义，G0记录差距，不直接触发抢话。
完整Message角色映射、工具同批配对、取消、文字混输与已播截断由Adapter记录fixture并测试。不能复制其他厂商原始事件名而声称兼容火山。

## 5 加载与权限
实时SK01常驻；简单媒体控制、公共记忆显式动作与任务控制按目录规则可调用。其他领域写入或推荐动作先加载对应正文；load_skill只提供注册skillId。
任务侧以read_file读取/skills/<name>/SKILL.md、已声明references或当前/task/<taskId>/只读资料。显式限定虚拟路径，禁止逃逸、绝对宿主路径、符号链接和跨任务资料。
Skill加载写入loadedSkillIds及版本。公共memory动作仍检查明确委托/自动授权，临时对话拒绝长期记忆；loadedSkill不等于有写权限。
同批“加载＋动作”不能认为模型已经读过正文：先返回加载结果，下一次模型决策才允许依赖该Skill的动作。相关写操作串行，独立只读有界并发，原生同批按call_id回传。
任务工具不暴露给任务Harness，避免递归创建或调控Task。任务Harness输出计划和TaskDraft，Supervisor决定状态。

## 6 完成验证
TaskDraft经过：Schema→goalVersion/contextVersion/deletionEpoch→sourceRefs/candidateId/actionId真实性→Artifact基准版本→Skill成功条件→部分完成一致性。
draft.status=completed不自动成为task.completed。缺证据改为partial或失败；程序分配Artifact与Result ID后才创建事件。实体写入不由最终JSON再次执行。
领域Receipt有四种最终状态；start/steer/pause控制用task_control；导出等待用ui_action。三类状态不能混用。读取成功可没有entityId，错误数据结构按errorCode解释。

## 7 导出、版本与恢复的特殊规则
notes_export参数必须二选一：非空itemIds且artifact字段为null；或空itemIds且有效artifactId/version。用户选择路径后只导出当时确认版本；对象变化先展示新版本供确认。
music_queue：add只用trackKeys；remove只用entryIds；reorder只用orderedEntryIds且覆盖现有后续队列；clear三个数组为空。程序返回queueVersion，不让模型猜新版本。
memory_forget：one需memoryId和expectedVersion；all_memories两个字段为null且必须已有界面确认token，token在运行时注入，不接受模型提供。
focus_start.endMusicRule只在用户明确要求关联当前曲目时可设pause_user_selected_track；程序绑定当前trackKey，结束时不暂停用户后来换的歌。
未知写入先查Receipt；相同动作重试复用幂等键。暂停请求到安全点才paused；重启/睡眠以needs_resume恢复检查，不自动提交旧动作。

## 8 状态与时间锚点
Task生命周期使用accepted/running/waiting_input/paused/needs_resume/succeeded/partially_succeeded/failed/cancelled。
TaskDraft输出使用completed/partial/needs_input；验证后分别映射到succeeded/partially_succeeded/waiting_input。task.completed是事件类型，不是Task状态值。completed草稿存在unresolved时不能发布全部成功。
单次领域Receipt.status与Task生命周期、导出UIAction状态分别校验。所有内部工具调用含Skill读取和write_todos也计工具预算；计划的模型调用同样计决策预算。
相对日期以用户原turn记录的本地时间和timezone为语义锚点，不以晚到工具回执时间重新解析。“本周末”按周一为周起点解释本周六日；当天已过去的信息标实际范围，不能自动推到下周。
TaskInput中currentTime用于当前查询新鲜度；原话时间锚点保存在sourceTurn元数据。跨午夜、系统时区变化和更正必须测试。调度仍以明确dueAt与timezone写入，改时区不自动移动已存在提醒。
## 9 语义与硬校验的分工
程序硬校验对象、版本、引用、权限、预算、回执与发布状态。目标是否充分回答、语气是否贴切属于模型语义质量，使用行为评测与Bad Case迭代；不要宣称一个JSON合法就证明回答一定正确。
无需额外LLM评委或路由器。产品离线盲评采用第16/17节的评测记录，R1不增加未注册模型请求。
排队Task保持status=accepted与queuePosition；queued只可作控制回执的排队表达。get_task返回有效result正文与产物版本，不能只给一个resultId让语音层猜结果。

输入材料通过TaskInput.observations的resourcePath定位只读任务资料；summary是预览，不能当作粘贴全文。完整原文与当前产物仅在用户委托范围映射至该路径。notes.list可按itemIds读取，reminders.list可按reminderIds读取；更新前获得真实版本。

所有框架实例明确传入ArkTaskModelAdapter对应M02模型对象，禁止省略model而使用框架默认模型。摘要M03也明确绑定火山。实时模型的供应商内置联网、唱歌和未开放多模态扩展本版关闭，查询与播放经注册领域工具；具体关闭字段由协议Adapter在G0验证，不把应用配置键当原始API字段。
