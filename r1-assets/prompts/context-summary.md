压缩以下有效上下文，输出符合ContextSummary Schema的JSON：
{{summary_input_json}}
保留当前主题、用户已确认的条件与结论、活动任务最新目标和未解决问题，并附实际sourceTurnIds、memoryIds、taskIds。摘要是有来源的会话资料，不是新的个人事实。
删去被更正或删除的事实，临时内容不得混入普通会话；temporary=true时只压缩这次临时会话，摘要仅留内存且结束即销毁，不引用长期记忆。不要将assistant建议变成用户决定，不得将已取消或未播出的内容写成用户已听到。
taskFacts中的goalVersion采用输入的最新版本；已完成领域动作以回执为准。对矛盾或未知信息保留不确定性，不补编事实。
只压缩提供的资料；不要查网页、调用写工具、创建记忆或改变计划。输出结构化摘要，不输出隐藏推理。

当输入包含 existingTopics 时，本次摘要同时供持续话题呈现。topic 字段必须返回对象或 null；旧压缩调用不提供 existingTopics 时可不返回该字段。仅当用户本人明确正在推进/持续关注一件事，或已明确确认共同结论时，才产生话题。普通闲聊、一次情绪、引用他人的第一人称、未澄清讽刺和助手单方面建议不生成用户话题。
话题 title 简短具体，summary 表达用户已确认的最新结论及已知条件；用户尚未决定的内容进入 unresolved，不把助手建议写成已接受的决定。没有明确解决证据则 status=active；存在未解决项时不能用 resolved。健康症状、疾病、用药、财务隐私、身份凭证等敏感内容不自动生成持久话题，topic=null，交由现有单条记忆确认流程处理；不在 summary 补写敏感原文。
同一既有主题有新进展时，从实际 existingTopics 选择 topicId 和 expectedVersion；只有语义上确属新主题时两者均为 null。不得编造 ID 或猜版本，不覆盖用户后续已更正的结论。sourceTurnIds 仅引用本次提供且仍有效的真实轮次，必须有用户原话支撑；不能仅用旧话题文字当作本轮新来源。话题来源和历史版本由程序保存，不将摘要作为新的个人事实。

产生持久话题时 sourceTurnIds 必须包含输入最后一条有效 user 的 turnId，以证明本次阶段结论确有新交流或用户确认；仅能用旧来源拼出的主题返回 topic=null。

R1 的话题呈现使用简体中文：title、summary、unresolved 用自然中文，macOS、产品名等专名可保留。保留「当前」「暂时」「首版」等时间和范围限定，不把暂不做移动版改成永久放弃，不给未确定的发布日期补日期。
sourceTurnIds 逐字复制输入的实际 user turnId，不使用顺序号、缩写或自行构造的 ID。memoryIds 只允许输入 memories 的实际 memoryId，memories=[] 时必须 memoryIds=[]。taskFacts 只允许输入 taskSnapshots 的实际 taskId/goalVersion，taskSnapshots=[] 时必须 taskFacts=[]：聊天讨论的项目、开发步骤和未解问题不是已创建的 Task，话题的未解问题放在 topic.unresolved。不要为补齐字段伪造实体或来源。
