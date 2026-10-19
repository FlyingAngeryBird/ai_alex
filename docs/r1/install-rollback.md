# Seamo AI R1 内部候选安装/升级/回退（alpha.23）

## 包信息
- 最终候选：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-19-alpha23-e8/`
  - `Seamo AI R1.app`；ZIP `Seamo-AI-R1-1.0.0-alpha.23-mac-arm64.zip`（148,713,656 字节）
  - SHA256 `920c0b00daeeabed81fc597791290c7c4325112bf8d6fe6a3ef7a506b709fb9b`
  - 源码 `c4a390d`；资产 3.5.9、工具 schema 3.2.1、SQLite 12、bundle `com.seamo.ai.r1`
  - 本机 ad-hoc 签名，**未 Developer ID、未公证**；包内无 `.env`/凭据/用户库
- 保留历史包：alpha.18（`ebbc613`，SHA `898ac18d…`）、alpha.17（`6a0f482`，SHA `c746ee08…`）、alpha.16（`164b354`，SHA `1530c8fd…`），均未替换用户 alpha.17 窗口。

## 安装（普通用户/内部验收）
1. 解压 ZIP 或使用 `Seamo AI R1.app`；可放 `/Applications` 或预览目录。
2. 首次打开若被 Gatekeeper 拦截：右键 → 打开，或系统设置→隐私与安全性→“仍要打开”（由用户操作；本机包为 ad-hoc 未公证）。
3. 首次启动可能请求钥匙串授权（“Seamo AI R1 Safe Storage”）：输入 macOS 登录密码并选择允许/始终允许（用户操作；每个新二进制可能一次）。
4. 数据目录：`~/Library/Application Support/Seamo AI R1`；旧 alpha.10 数据不会被写入。

## 升级/回退（本机隔离已实测）
验证记录见 [install-upgrade-rollback](2026-10-18-alpha19-install-upgrade-rollback.md)，步骤：
1. 退出应用并备份 `~/Library/Application Support/Seamo AI R1`（`r1.sqlite`/`config.json`/`music.json`/`onboarding.json`）。
2. 用新 `.app` 替换旧 `.app`（同路径即原位升级）；启动后确认数据仍可读、版本/资产正确。
3. 回退：退出并用旧候选 `.app` 替换；若数据库 schema 相同（alpha.18↔alpha.19 均为 12），数据可直接读取；跨 schema 回退使用升级前快照，不要用旧包直接打开新 schema。
4. 实测：alpha.18→alpha.19 升级后原待办/提醒保留、新写入成功；回退 alpha.18 后 alpha.19 新增记录仍可读；隔离合成数据，未触碰用户 alpha.17。
5. 应用内数据恢复会生成 `*.pre-restore-*.sqlite` 回滚副本，保留至验收完成。

## 人工/系统与外部条件
- 原生诊断保存框：设置→数据与诊断→导出诊断→系统框默认 `Seamo-R1-diagnostics.json`→点“保存”；核对文件不含聊天/密钥/音频。该步骤为人工，不代点/不向其他应用发按键。
- 钥匙串、Gatekeeper、系统通知/麦克风权限均为用户/系统步骤；不代输密码、不改 ACL、不删 vault/重填 Key。
- Developer ID 签名与公证、正式安装包下载与系统级卸载验收为独立外部条件，不由本机隔离验证覆盖。

## alpha.20↔alpha.21（E6 追加）
- 隔离目录/fake HOME/合成数据：alpha.20→alpha.21 原数据保留+新写入成功，SQLite 12；回退 alpha.20 后 alpha.21 新增记录仍可读，SQLite 12。alpha.20 保留；未触碰用户 alpha.17。

## alpha.21↔alpha.22（F04a 修复候选追加）
- 隔离目录/fake HOME/合成数据：alpha.21→alpha.22 原数据保留+新写入成功，SQLite12；回退 alpha.21 后 alpha.22 新增记录仍可读，SQLite12。alpha.21/20/19 原包保留；未触碰用户实际 alpha.21 的 userData 与快照。
