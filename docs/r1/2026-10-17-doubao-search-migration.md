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

## DEC-R1-WEB-EVIDENCE-041：真实Bad Case的完成门槛与Skill入口修正

用户允许钥匙串后2b16802启动成功并恢复原只读Task；后台在零搜索/读页Receipt、loadedSkillIds为空的情况下发布completed，回答错误地混淆IAM与搜索专用Key，给出未经读取的URL。SQLite与任务结果UI一致复现。此结果判失败，历史证据保留，不能作为真实联网问答通过。

根因：M01委托toolAliases仅web_search/web_read_page，read_file随可选delegation被覆盖，SK02未加载而领域工具隐藏；requiredActions为空时Supervisor没有独立联网来源完成门槛。修正：start/steer始终保留既有受限虚拟read_file支架（只能当前Task材料和批准Skill，不开放宿主文件或新写权限）；已委托web_search/web_read_page的任务，completed必须分别包含真实成功回执以及其返回的来源sourceRef，读页须实际read/partial。无来源或无回执只能partial/needs_input，不因模型写了URL就算完成。允许partial保留真实失败原因。

这落实已有SK02“查询完成须有真实来源、关键结论定位实际已读来源”的合同，不新增Prompt/Skill/工具Schema或模型路由。批准资产2.5.1、SQLite11不变。新用例覆盖domain-only委托保留沙盒读取，requiredActions为空/无回执/只凭模型链接拒绝完成及允许诚实partial。此前误报已完成的历史记录不直接改写，验收报告明确作废，后续以新真实委托验证。

DEC-041后真实复测：M01曾调用旧Task结论再次复述错误入口；新增get_task旧结果保护，已完成web任务若缺少委托工具的成功回执则返回TASK_COMPLETION_WEB_EVIDENCE_MISSING，不把历史误报继续回注为成功。隔离旧库fixture复现并校验该拒绝。

新只读任务91c14091-6614-43da-8749-d890450a6383实际授权read_file/web_search/web_read_page，加载SK02及3条harness.readSkill回执。第一次模型没有执行搜索，诚实返回partial；从已加载Skill检查点继续后，真实web.search成功返回10条来源及候选，随后web.readPage失败PAGE_NO_READABLE_CONTENT，下一次错误sourceRef/URL组合被TASK_PAGE_SOURCE_INVALID拒绝。任务partial，未创建事项/提醒。由此真实通过M01受理→Task→Skill→Custom搜索→真实来源回执；完整“读官方正文→结论”仍未通过，不将摘要伪装已读。

来源绑定失败现移入executeReadTool的校验执行区，仍在任何HTTP读取前拒绝，形成固定错误码的failed Receipt，允许模型观察失败后按预算改查；不在异常处直接终止整个Task。回归验证不匹配URL时实际页面请求数为0、随后正确来源仍可读取。官方动态页面可读性仍为待验/能力限制，未增加浏览器登录、第三方抓取供应商或伪造正文回执。

## 最终交付检查点

源码ea9f64c已推送codex/seamo-r1，包含DEC-041及旧结果回注拒绝、失败回执恢复；90文件568项通过，构建与临时签名完整性通过。`/tmp/seamo-web-evidence-final-tests.log`、`/tmp/seamo-web-evidence-final-build.log`为本批日志。最终开发包`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha3-web-recovery/Seamo AI R1.app`已通过CUA实际启动（包URL核对），问候返回、麦克风未开启，原服务状态保留。

独立搜索/真实Task搜索已通过，动态官方正文读取和完整结论仍未通过。最新失败回执恢复代码已有自动化验证，但尚未在最终包重新完成实际动态页失败后的模型改查；不称全部联网A/V通过。正式签名、公证、音乐源及全量版本验收仍沿原未通过项。

## DEC-R1-PAGE-ANCHOR-042：长文档定位读取

最终恢复包ea9f64c追加只读RFC9110任务00d6601d-b3f4-4fd1-9413-f0de671f33bb：实际SK02加载、web.search成功、3次web.readPage成功但均为同一正文开头20000字（partial），不含POST目标章节，最后预算耗尽返回partial。既有完成保护没有把该链路写成查证成功。发现固定前缀窗口导致模型无法访问长文档后续章节。

补正既有URL读取语义：保留URL片段作为本页章节锚点，按HTML id/name精确匹配容器读取，不把片段当CSS或代码执行；片段不存在/无可读容器时返回固定失败码，不回退到文档开头冒称读取目标。HTTP仍请求同一公开资源，现有DNS/重定向/字节/文本界限不变；sourceRef与source URL保留锚点，防止不同章节证据混成同一页读取。带candidate sourceRef时只允许变化fragment，不允许改变host/path/query。纯文本未支持片段，明确失败。没有增加工具Schema、供应商或模型提示；不能解决登录墙/动态JS正文。

验证：90文件569项回归通过，随后12项读取/来源关联回归通过；构建通过。合成超长文档验证目标在默认20000窗口之外仍可按锚点取得，缺失明确失败；来源query改变仍禁止。真实生产读取器（非模拟网络）对RFC官网：`#section-9.3.1`返回3459字、以“9.3.1. GET”开头；`#section-9.3.3`返回2287字、以“9.3.3. POST”开头。因原HTML达到字节上限仍保留partial，不冒称完整原页已读。日志`/tmp/seamo-page-anchor-real-final.log`；先前未通过构建时的旧dist探测结果不作为此验证证据。此为真实定向读取通过，不等于模型整个查询已完成；端到端目标章节回答仍待最终包复测。
