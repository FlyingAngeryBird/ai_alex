# Seamo AI R1 开发资产包 1.0.1
配套PRD v0.5.1。此包是产品与开发的确定输入，不是已实现的应用或已接通的火山SDK。六个Skill用于Seamo AI应用运行时，不安装为开发者个人Codex插件。


本次1.0.1修订统一正式名称与默认助手名为Seamo AI。PR01、PR04版本升为1.0.1；其他Prompt、六个Skill与字段合同版本保持1.0.0。

## 开始开发
1. 阅读docs/Seamo_AI_R1_PRD_v0.5.1.md与docs/AUDIT.md。
2. 按AGENTS.md和CODEX_TASK.md完成G0仓库/账号/API/SDK核验，再按工作包实施。
3. 用config/runtime.defaults.json建立配置与用户设置；null接入值必须通过G0填写，不能生成模型ID、音色、密钥或版本号。
4. 运行python3 scripts/validate_assets.py及python3 scripts/check_contract_examples.py；依赖见requirements-dev.txt。这是资产静态校验。
5. 修改资产后运行python3 scripts/rebuild_release.py，重建PRD摘录与manifest，再运行静态校验。
6. 集成后对evals/behavior-cases.jsonl执行真实模型、工具及状态断言，再跑PRD第16/17节。不要把静态通过写成云端或安装包验收通过。

## 确定的输入
- prompts/：PR01至PR10完整Prompt。
- config/prompt-registry.json：变量Schema、角色与组装规则。
- skills/：六个SKILL.md及示例资源，采用Agent Skills格式。
- config/skill-registry.json：固定版本、能力和工具范围，模型文本不能修改权限。
- contracts/tool-catalog.json：38个领域/任务操作与3个内部操作的别名、描述、参数Schema。
- schemas/：14个上下文与输出Schema。
- docs/ARCHITECTURE_CONTRACT.md：运行链路、权限、框架和协议边界。
- docs/CHANGE_POLICY.md：可调整项、版本、生效与回滚。
- scripts/render_prompts.py：无网络的模板编译参考实现；生产端可等价移植至TypeScript。
- evals/：行为用例与结构化合同样例；不注入运行时模型。
- asset-manifest.json：每个交付文件的SHA256；修改资产后必须重建manifest并跑回归。

这些Skill只读加载，R1不运行Skill附带脚本。真正的业务动作由领域服务实现。JSON Schema是应用合同，火山请求字段通过Adapter映射；不声称这些JSON能直接替代供应商原始payload。
