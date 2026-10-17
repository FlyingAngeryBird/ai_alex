# 可直接交给Codex的实施任务
在当前Seamo AI语音助手仓库内完成PRD v0.5.1定义的R1迭代。以本包AGENTS、PRD和机器可读资产为同一需求基线。

## 阶段0：建立真实映射
读取现有仓库说明与AGENTS，检查Electron/Vue、realtime、music、storage、IPC及现有缺陷。输出code-map.md：每个功能ID的当前实现、目标模块和依赖。填写compatibility.json：火山配置引用、协议版本、SDK确切版本和每个G0测试状态；不填伪值。

## 阶段1：先实现执行合同
实现配置、PromptRegistry、SkillRegistry、SchemaValidator、PromptBoundary、ToolExposure、ToolExecutor及TaskSupervisor。先验证白名单、临时隔离、版本、幂等和真实完成判定，再接模型。render_prompts.py为参考，生产实现用TypeScript和成熟Schema库；不另造业务指令。

## 阶段2：接火山模型与Harness
实现VolcRealtimeAdapter与ArkTaskModelAdapter；原生3.0 JSON与旧O/SC二进制严格区分。任务Requests显式store=false。Harness最终模型system与工具由应用边界组装；保留LangGraph状态运行能力，默认子Agent关闭。长工具快速受理，最终结果通过独立事件返回。

## 阶段3：落实领域与五个页面
按PRD工作包实现C01至C06、P01至P05/O01至O06、F01a至F11d。页面只渲染真实状态，编辑与语音用同一服务；保持现有粒子与音乐交互基线。按保存、改期、打断、遗忘、恢复等跨功能链路验证，不能只做按钮和文案。

## 阶段4：验收
执行资产校验，行为评测E01至E16，PRD A01至A50及新增A51至A60，最后跑第16节性能。记录模型/Prompt/Skill/config版本、输入、工具参数、真实回执、最终状态和耗时。fixture通过与真实通过分别标记。

## 输出
1. 按功能ID组织的代码变更及构建结果。
2. 覆盖矩阵：功能、页面、Skill、Prompt、Tool、用例、证据路径。
3. G0兼容记录和接入锁文件。
4. 发布资产manifest与变更记录。
5. 未完成/受阻项及具体原因，不用“理论支持”代替实际完成。

按阶段持续推进；对已明确事项执行实施。可自行作不改变行为合同的实现选择，不自由改写设计或扩大产品范围。
