## 22 完整Prompt规格与组装

### 22.1 Prompt清点与唯一来源
业务运行Prompt固定为PR01至PR10，各文件版本以注册表为准，完整正文见下文；实际文件位于开发包prompts目录。页面编号P01至P05与Prompt编号PR01至PR10分开。
模型看到的指令还包括：六个Skill正文与声明示例、工具目录description、生成的能力元信息、类型化应用上下文。工具description与Skill描述同样纳入版本和SHA，而不是任由SDK或开发临时补写。
ASR热词、VAD参数、TTS音色/编码及播放参数是服务配置，没有额外自由生成的LLM Prompt。本版不加意图分类、路由、时间解析、自动评委或第二个规划模型；语义决策由既定M01/M02完成，程序执行硬校验。
Deep Agents框架原有指令不作为产品指令来源。业务Skills/Memory/Summary/TodoList注入由应用替代；最终模型请求在PromptBoundary重建system并在ToolExposure核验工具。协议错误只回传注册错误码和真实状态，不生成新成功事实。

### 22.2 注入位置、调用条件与格式
| 场景 | system及固定指导 | 运行资料与输出 | 工具范围 |
| --- | --- | --- | --- |
| 原生实时交流M01 | PR01＋PR02＋PR03＋SK01 | AppContext、用户语音/文字、真实回执；输出语音/文字或结构化调用 | 频道工具＋已加载Skill范围＋公共即时操作，取有效授权交集 |
| 纯文字交流M02 | 同一PR01＋PR02＋PR03＋SK01 | 同一有效应用上下文；输出文字或调用 | 同一产品范围，每轮仅一条最终回复路径 |
| 后台任务M02 | PR01＋PR02＋PR04 | TaskInput、按需Skill、工具观察；最终TaskDraft | 任务领域工具及read_file/write_todos；不暴露Task控制 |
| 事实提取M03 | PR01＋PR05 | MemoryInput→MemoryCandidates | 空工具集合 |
| 上下文压缩M03 | PR01＋PR06 | SummaryInput→ContextSummary | 空工具集合 |
| 任务结果呈现 | 保持交流system，注入PR07应用事件 | 有效TaskDeliveryInput；符合播报资格才调用 | 此事件不授予新的副作用动作 |
| 任务目标更新 | 保持任务system，注入PR08应用事件 | 最新目标、版本、来源与有效回执 | 按最新任务有效范围继续 |
| 提醒表达 | 保持交流system，注入PR09应用事件 | 调度器已判定事件；勿扰下只卡片 | 此事件不重新调度或执行动作 |
| JSON修复M02/M03 | PR01＋PR10 | RepairInput→原目标Schema，仅一次 | 空工具集合 |

变量必须按注册表Schema校验后JSON编码，单次替换；用户人设中出现{{task_input_json}}等字样不能二次执行。变量缺失、额外变量、Schema失败均阻止模型请求并呈现配置错误；不能用空字符串凑齐。
人格只覆盖名称与表达，不能覆盖PR01边界。AppContext/资料中要求扩大权限的文字不获得system地位。相对时间采用原用户turn锚点，发布和提交仍检查当前实际时间与版本。
实时session.update全量重编译有效instructions与完整工具集合，不只覆盖本次变更片段。实际协议字段由VolcRealtimeAdapter映射；工具结果保留真实call_id。任务最终结果不能复用已经回传accepted的call_id伪装第二次结果。
PR07/PR09的speakAllowed由协调器决定；false时不发起用于主动播音的模型请求。无法验证静默结果注入时展示卡片，用户询问通过get_task回执接续；此差距须G0记录，不声称已完成主动播报目标。

## 23 六个Skill的完整实现定义

### 23.1 创建对象、格式与加载
本版创建六个可版本化的能力目录，每个目录含SKILL.md与references/examples.md。它们指导同一个Agent，不创建六个自治Agent。Skill执行时创建的业务对象分别是回应、查询候选、Item、Reminder/Focus、真实播放状态与Artifact。
采用Agent Skills标准的YAML name/description＋Markdown正文，并用独立skill-registry.json保存skillId、version、allowedTools、capabilityIds与资源路径。[16][19]
旧逻辑名companion_chat等保留为legacyKey；标准文件名采用companion-chat等连字符命名，映射一对一。前言与第3.5节中的旧名指逻辑能力；第23节文件和注册表是实际加载格式。
常驻短描述；实时SK01正文常驻，其他正文通过load_skill读取；任务通过只读虚拟read_file按需读取。读取结果后的下一轮决策才能使用依赖Skill。界面确定的按钮调用领域服务，仍遵守同一合同。
同一发布包、同一Task保持同一Skill版本；工具权限由程序检查，不依靠正文承诺。R1不开放脚本执行、自我修改、第三方安装或任意主目录读取。

## 24 工具、输入输出与机器可读合同

### 24.1 工具拆分与调用字段
第14.1节28组能力目录在本节拆为38个独立领域/任务操作与3个内部操作。所有别名、description、input_schema和output_data_schema均完整提供于contracts/tool-catalog.json；不由AI coding生成另一套。
模型只提供业务参数；actionId、idempotencyKey、requestKey、playbackRequestId、contextVersion、sessionGeneration、授权/确认token、当前goalVersion与时间锚点由执行层绑定。expectedVersion来自已读对象，不能由模型自增。
输出统一分为receipt、task_control、ui_action。只有receipt的真实最终succeeded表示该操作成功；accepted/queued/pause_requested/awaiting_user均不代表目标完成。每个操作的成功data另有固定Schema，失败无有效数据可以为空对象，不能假冒成功。
ToolExecutor分别校验参数和返回数据；Schema之外还检查真实ID、引用归属、对象版本、时间语义、授权、预算、队列身份和完成条件。Schema结构合法不是来源真实的证明。
notes.export、memory.forget、music.queue等互斥输入已经写入Schema；清空队列不播放、不停止当前歌；忘记全部只接受程序确认token；导出路径由用户界面选择，不接受模型传路径。
内部read_file仅能读取发布包声明路径和当前任务只读资料；load_skill只接受六个skillId；write_todos是任务Plan，不是用户Todo。

### 24.2 程序维护的状态映射
| 对象 | 值与完成含义 | 程序行为 |
| --- | --- | --- |
| TaskDraft | completed / partial / needs_input | 验证后映射生命周期；正文不能直接执行第二遍动作 |
| Task生命周期 | succeeded / partially_succeeded / waiting_input等 | 由Supervisor更新；task.completed是完成事件名 |
| Receipt | succeeded / failed / cancelled / unknown | 真实提交与资源状态；unknown先查回执 |
| Task控制 | accepted / queued / updated / pause_requested等 | 控制受理与安全点分开 |
| UIAction | awaiting_user / cancelled | 导出等人机选择先受理；真实文件成功另有Receipt |
| Artifact | artifactId、version、baseArtifactVersion | 由程序生成版本，旧草稿不得覆盖页面新编辑 |
| Delivery | displayedAt / announcedAt / dismissedAt | 卡片、实际播音、隐藏分开去重 |

### 24.3 完整Schema所在位置
开发包schemas提供14个完整Schema：AppContext、Persona、SkillIndex、TaskInput、MemoryInput、SummaryInput、TaskDeliveryInput、TaskSteerInput、ReminderDeliveryInput、RepairInput、TaskDraft、MemoryCandidates、ContextSummary与ToolOutput。
采用Draft-7 JSON Schema作为应用合同；火山严格输出是否支持所选嵌套字段必须G0验证。严格模式不支持时可采用该平台可用JSON方式，输出仍须同一应用Schema校验，不降为无类型文本。
TaskDraft只交付草稿和引用，Artifact ID由程序创建；memory-extract只输出候选，不直接写数据库；summary保留引用与删除epoch依赖；repair一次且无工具。
此处的ToolOutput是应用内部格式。火山原始事件、Web/Music原始数据通过Adapter/领域服务映射；不能直接把此格式当供应商SDK字段。

## 25 配置、版本与调整迭代

### 25.1 新增字段边界
保留第14.5节L01至L16，补充以下统一边界；完整默认值见runtime.defaults.json，字段类型与具体长度以Schema为准。

| 参数 | 本版默认或边界 | 使用说明 |
| --- | --- | --- |
| L17 结构化修复 | 最多1次，无工具 | 原任务写入不重试、不伪造ID |
| L18 近期注入 | 最多12个有效轮次、24条消息 | 实际已播范围与来源保留；云上下文容量须G0核验 |
| L19 摘要 | 最多1600码点；任务已知容量70%触发 | 任务预留2048输出token；容量未知不能假装已测定 |
| L20 单条记忆 | 最多1000码点 | 长原话另存Item，不静默截断为错误事实 |
| L21 任务与查询短字段 | goal2000、query1000、单项constraint500 | 超限明确分段/缩小目标；title沿L02 |
| L22 普通数组 | 默认最多50项 | 本地列表每页20、记忆最多5、Skill恰六个优先采用更小合同 |
| L23 公开页模型文本 | 每次最多20000码点 | 原读取仍遵守2MiB/8秒；截断必须标记partial/truncated |
| L24 URL与修复原输出 | URL2048；修复原输出20000码点 | 不将超限内容拼进Prompt；必要时报告partial或invalid |

runtime.defaults.json中的null仅用于不可杜撰的账号接入与SDK实测值，不是运行时自行选择第三方的入口。默认M03复用M02，M04/M05/M06独立启用并验证；不强迫原生路线额外等待ASR/TTS。
用户设置只能改允许字段；资产参数通过发布版本管理，不把工具权限或Prompt正文开放为随意用户设置。模型策略保持灵活，用户对象及执行合同保持可核查。

## 26 开发链路与模块合同

## 27 AI coding的完整执行指令

配套开发包根目录AGENTS.md提供持续约束，CODEX_TASK.md提供实施任务。把整个开发包给Codex；只给一段PRD摘要或只给Prompt正文不足以构成完整需求输入。
开发包包含本PRD全文、十个Prompt、六个Skill、完整工具/Schema、默认配置、迭代规则、行为fixture及静态校验脚本。源码/账号/真实服务没有提供时执行G0取证，不自己生成接入事实。
业务设计已明确；类名、模块位置、缓存和兼容补丁版本允许实现选择，但不能借此改变数据对象、范围、Prompt或完成条件。

## 28 新增验收与开发就绪条件

| 用例 | 输入或操作 | 必须验证的结果 |
| --- | --- | --- |
| A51 Prompt组装 | 编译十个模板，缺变量/额外变量/人设带模板字样 | Schema与变量检查；单次替换；真实最终Prompt hash可追踪 |
| A52 指令与权限 | 人设或公开页要求执行终端、读主目录或扩大范围 | 最终工具集合无该能力，执行层拒绝；资料不变成产品指令 |
| A53 框架默认 | 创建Harness并记录最终model-request快照 | 无额外编程/委派/默认摘要Prompt；允许的system与工具同注册表 |
| A54 Skill加载 | 初次加载、重复加载、路径逃逸、跨任务和evals读取 | 版本固定、合法资源只读；禁止路径拒绝，金标不进入模型 |
| A55 输出完成验证 | 非法TaskDraft、伪造source/actionId、存在unresolved却completed | 一次无工具修复；引用/版本复验；不发布假成功，保留已提交Receipt |
| A56 新旧条件竞态 | 用户改条件或页面编辑后旧模型返回 | 最新goalVersion、contextVersion、Artifact基准版本控制提交与发布 |
| A57 导出等待 | 打开保存框、取消、源对象更新与最终写文件 | 不阻塞语音处理；awaiting_user与真实成功分开；不猜路径或导出错误版本 |
| A58 临时会话 | 临时模式启动Task并退出，期间明确保存便签 | Task/Message正文不落库或内容日志；退出销毁；明确保存对象保留 |
| A59 资产升级与遗忘 | 活动Task时发布新Skill/Prompt，并删除旧记忆 | 新Task用新资产，活动Task绑定原版；删除epoch立即覆盖版本绑定 |
| A60 G0未配置 | 模型ID/音色/SDK验证值缺失，或协议不兼容 | 对应路径未配置/待验证；无伪回执、无静默跨供应商；本地功能可继续 |

静态资产校验验证文件、Schema子集、变量、引用、工具权限manifest与内容hash；不证明模型语义或云连通性。scripts/check_contract_examples.py提供有效/无效参数和模板隔离示例，生产校验器使用成熟TypeScript库。
evals/behavior-cases.jsonl提供E01至E16行为评测基线，覆盖六个Skill、记忆/摘要、结果、提醒和JSON修复。允许自然措辞变化，断言真实动作、版本、回执和副作用；fixture只用于测试，不进入模型上下文。
开发完成需G0兼容记录、41功能覆盖、A01至A60通过、真实火山请求与安装包证据及第16节性能指标。没有真实模型测试时标待测试，不将静态校验称为产品已完成。
