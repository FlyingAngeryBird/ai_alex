# G1 契约与数据开发记录（未通过阶段门槛）

## 范围与用户可见差异

- DEC-R1-CONTRACT-002：机器工具合同已按最终 PRD 第 5.5 节升为 2.0.0，补齐 `linkPurpose`、关联提醒确认与分项回执；资产清单重建并通过静态校验。
- 新应用使用 `com.seamo.ai.r1` 和独立的 `Seamo AI R1` 数据目录。`lingli` 开发版与 `lingmo` 打包版的 JSON 只读导入，旧助手名不继承。已导入的音色和收藏在新应用的兼容界面中可见。
- SQLite `user_version=1` 保存 Persona、会话、记忆、话题、事项、提醒、任务、回执、音乐和工作稿表；未来 schema 会被拒绝打开。事项和提醒的类型化 IPC 已接入主进程。
- 待办完成、撤销、删除、提醒重复投递的事务已实现；事项提交后提醒失败保留事项。页面尚未接入新的事项/提醒 API。

## 验证

- `npm run build`：通过。
- `npm test`：33 个测试文件，211 项通过；其中 G1 SQLite 与事项/提醒事务共 8 项。
- `r1-assets/scripts/validate_assets.py` 与 `check_contract_examples.py`：通过。
- R1 `.app`：包内无 `.env`，`CFBundleIdentifier=com.seamo.ai.r1`，本机临时签名验证通过。
- 本机旧 `lingli` 的 `config.json`、`music.json` 可解析，存在 1 条音乐收藏；只读取文件结构，没有打印用户内容。

## 尚未达到的 G1 门槛

- SQLite 与现有 JSON 兼容存储仍并行；正式领域数据读写、备份/恢复预检、删除抑制跨恢复合并尚未完成。
- 临时会话内存隔离、记忆删除传播、Task/Artifact 状态机及完整 IPC 参数运行时校验尚未完成。
- 新事项/提醒 API 尚未接入页面或系统通知；需要 G3 端到端及休眠/权限测试。
- 旧版安装包未做安装验证；R1 未经 Developer ID 签名、公证及真实安装验证。

因此不创建 G1 阶段标签，也不将当前 `.app` 上传为正式 GitHub Release。回退方式是关闭 R1 后继续运行旧版独立工作树/应用；旧版数据目录未被 R1 写入。
