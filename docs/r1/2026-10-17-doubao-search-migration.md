# DEC-R1-SEARCH-039：独立搜索切换豆包 Custom

## 依据与评估

用户明确要求解决Brave境外支付不可用，改用豆包搜索Custom，保留独立搜索API与当前模型自主调用。切换的是搜索供应商，不是回答模型或Task Harness。当前代码在主任务执行器和搜索IPC分别注入Brave，可在相同领域输出合同下替换这两个入口；前端主要变更加密配置字段和说明，无数据库迁移。

官方协议核对（2026-10-17）：

- [Custom独立API](https://docs.volcengine.com/docs/Networkedsearch/Networkedsearch-2?lang=zh)：POST `https://open.feedcoopapi.com/search_api/web_search`，搜索专用Bearer Key，`SearchType=web`；返回`Result.WebResults`，包含标题、链接、片段、相关摘要及可选发布时间。单次Query为1–100字符，可能在服务端截断。
- [计费及Key隔离](https://docs.volcengine.com/docs/Networkedsearch/Onlinesearchproductbilling?lang=zh)：搜索订阅和按量后付费使用不同Key；须在联网搜索控制台配置对应服务，不自动复用Ark模型Key。
- [方舟托管搜索](https://docs.volcengine.com/docs/ark/web-search?lang=en)：Responses的`web_search`/`sources=["doubao"]`是另一种集成方式，本批不启用该托管工具，不绕过现有工具曝光、执行和回执边界。

预期可消除Brave支付依赖，并保留查询、比较、改条件、候选选择、保存和提醒流程。尚无同题对照证据，不能声称准确率更高、费用更低或延迟更短。实际效果取决于召回来源、网页可读性、模型综合及使用次数。

## 实现与边界

- 新增独立Custom适配器，共用SearchProvider类型；主任务入口与搜索IPC均切换。原Brave适配仅保留作兼容/回退，不自动调用或降级到它。
- 新配置`DOUBAO_SEARCH_API_KEY`沿用加密vault，UI不回显。原Ark、语音和旧Brave密钥保留；不把任意已有Key自动复制为搜索Key。
- 请求最多10个结果，要求原文URL，关闭Query改写，12秒请求界限并传递取消，不为一次查询自动扇出多次收费请求。禁止重定向，避免认证头跟随到非预期目的地。
- 超过100码点在调用前拒绝，返回明确上限，不静默丢弃用户条件。既有领域工具Schema不变；该限制属于供应商能力边界。模型可以在原授权和预算内修订查询，程序不加入关键词路由或额外业务Prompt。
- 优先Summary、缺失时用Snippet；始终标记`search_summary`/`not_read`，不把服务端Content当应用已读正文。来源URL沿用稳定候选ID及过滤；缺URL结果剔除。发布时间有效时透传，1970占位或缺失仍为null；查询时间单独记录。
- 时间/地域沿用现有查询上下文，本批不谎称额外启用了硬时间/地域过滤；需要严格日期结论仍核对来源。
- HTTP和200内业务错误都处理，区分权限、服务开通、套餐/额度、限流；不将原始服务错误、密钥或请求头回传给模型/页面。不从一次返回条数推断还有更多可分页结果。
- 原型结构、10个Prompt、6个Skill、38业务工具、3内部工具及批准资产2.5.1不变；应用升为1.0.0-alpha.3。SQLite11不变，不改旧版目录/main。

## 验证与待验

关联适配器、IPC、凭据、任务回执/取消测试及构建通过。新增用例覆盖：真实协议形状的合成响应、摘要/日期/候选映射、长度/未配置不计费请求、业务错误脱敏、取消信号；同一TaskExecutor对两种适配器验证预算、来源、幂等和取消后不发布；加密凭据保存不覆盖其他Key。

完整回归90文件561项通过，生产构建通过（保留现有bundle体积提示），资产59哈希校验通过。日志：`/tmp/seamo-doubao-search-tests.log`、`/tmp/seamo-doubao-search-build.log`、`/tmp/seamo-doubao-search-assets.log`。用户已保存的Ark模型在alpha.2实际点击检测返回“请求通过”，但这不等于完整任务或搜索验收。

适配器用例是合成HTTP响应/隔离数据库测试，不是已调用真实Custom服务。必须由用户配置搜索专用Key后，实际验证成功与失败响应、引用是否支撑结论、追问与保存/提醒。当前未做Brave/Custom同题质量对照。

## 回退

源码和开发包可回退alpha.2的9017bf8（开发标签`r1-preview-1.0.0-alpha.2-build2`）。数据库和批准资产版本一致，密钥原值保留；回退旧R1代码不复活被清理/遗忘的数据。由于用户Brave支付条件不具备，回退不代表Brave真实搜索可用。

## 真实联调与 DEC-R1-SEARCH-040

用户保存搜索专用Key后，alpha.3实际点击查询“火山引擎 豆包搜索 Custom 官方文档”，返回9条有URL候选，首项为火山官方Custom接口文档，查询时间、摘要与仅搜索摘要标识正确显示。由此证明当前搜索鉴权与一次真实检索可用，尚不代表全量语义/费用/延迟验收。

真实主会话发送只查询、不保存/不创建提醒的官方Key入口问题后，M01受理并创建只读委托；任务`2fe9d98c-59d8-482f-94cc-e7b6cc870cdf`在M02请求阶段报`ARK_REQUEST_TIMEOUT`，状态partially_succeeded。该次尚无搜索/读页成功回执，不冒称查证完成。主会话受理成功也说明此前启动超时不是持续鉴权失败。

DEC-040：原后台M02和文字M01共用15秒模型请求上限，不能容纳当前真实模型的较长决策；仅将任务模型单次请求界限设为60秒、文字及连接检测30秒，仍保留调用方取消、目标/上下文校验、整体任务预算及并发隔离，不自动重试或增加工具次数。新增长界限下取消后迟到结果拒绝用例。此变更提高允许等待上限，不构成性能达标结论。

同时修正独立查询页：输入上限与Custom100字匹配，展示适配器实际收到的页面日期，缺失仍显示未知；此前固定显示未知会隐藏已有发布时间。批准资产/工具合同和数据库版本不变。

恢复后的真实M02返回ARK_RESPONSE_NOT_COMPLETED，仍无搜索/读页回执。补正DEC-040：分类型处理incomplete_details.reason（输出预算耗尽/内容过滤/其他），仅返回固定错误码，不发布部分函数参数；后台模型输出上限2048→8192（包含思考与回答），硬上限仍16000，无自动重试。此时尚无旧响应reason证据，因此不把预算耗尽写成已确认根因。官方依据：https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh 。主会话/后台次数预算和工具权限不变。

最终代码2b16802完整90文件565项通过，构建/临时签名完整性检查通过。修复包在`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha3-search-budget/Seamo AI R1.app`。启动采样停在SecItemCopyMatching/SecKeychainItemCopyContent，已请用户完成钥匙串验证；因此新预算下的原委托继续验收尚未开始，不能称已修复真实完整问答。第一次搜索成功及两次M02失败均保留。
