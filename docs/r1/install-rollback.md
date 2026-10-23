# Seamo AI R1 内部候选安装/升级/回退（alpha.28）

## 包信息
- 当前内部候选：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-23-alpha28-music-quality/`
  - `Seamo AI R1.app`；ZIP `Seamo-AI-R1-1.0.0-alpha.28-mac-arm64.zip`（151,358,294 字节）
  - SHA256 `ae7ea3e0d83acb76606e43d6d081d633111009732dc564a7333eb49cdf3ed46f`
  - 源码 `431f108027e861cbe3521312f4b44001b742fc77`；资产 3.5.9、工具 schema 3.2.1、SQLite 12、bundle `com.seamo.ai.r1`
  - 本机 ad-hoc 签名，**未 Developer ID、未公证**；包内无 `.env`/凭据/用户库
- alpha.28 音乐体验迭代：类型检查/构建、7文件60项音乐相关测试、签名完整性通过；真实元数据/封面探测及生产组件隔离图片显示有记录。本次未强制切换真实用户窗口，实包实际点歌/听感仍待验收。请先退出当前应用，再启动新包，避免多个版本共用同一数据目录。
- alpha.27及更早包完整保留；本次没有制作新真实数据快照或执行真实数据回退，最近的快照仍为alpha.27切换前快照。

## 安装（内部验收）
1. 解压 ZIP 或使用 `Seamo AI R1.app`；可放 `/Applications` 或预览目录。
2. 首次打开若被 Gatekeeper 拦截：右键 → 打开，或系统设置→隐私与安全性→“仍要打开”（由用户操作；本机包为 ad-hoc 未公证）。
3. 首次启动可能请求钥匙串授权（“Seamo AI R1 Safe Storage”）；如系统显示提示，仅由用户确认请求者并操作。此前 login 已解锁仍发生 `-25293`，所以解锁不能保证预览包可读；若读取失败，保留旧加密文件，不重置钥匙串、不改 ACL、不覆写凭据。
4. 数据目录：`~/Library/Application Support/Seamo AI R1`；与更旧产品标识的数据分离。alpha.27 切换前的真实数据快照保存在本机 `2026-10-22-alpha27-mini-cover/pre-switch-user-data-20261022/`，目录权限 0700，不随安装包分发。更早的快照也保留。

## 升级/回退（本机隔离已实测）
验证记录见 [install-upgrade-rollback](2026-10-18-alpha19-install-upgrade-rollback.md)，步骤：
1. 退出应用并备份 `~/Library/Application Support/Seamo AI R1`（包括 `r1.sqlite`、配置及加密凭据文件；备份限本机且权限仅本人）。
2. 用新 `.app` 替换旧 `.app`（同路径即原位升级）；启动后确认数据仍可读、版本/资产正确。
3. 回退：退出并用旧候选 `.app` 替换；若数据库 schema 相同（alpha.18↔alpha.19 均为 12），数据可直接读取；跨 schema 回退使用升级前快照，不要用旧包直接打开新 schema。
4. 既有实测：alpha.18→alpha.19 升级后原待办/提醒保留、新写入成功；回退 alpha.18 后 alpha.19 新增记录仍可读。本次隔离 alpha.22→alpha.24→alpha.22 启动链中合成事项仍为 1 条、schema 12 且完整性检查通过。真实用户已切换并可读；**真实数据回退仍未执行**，因此不将隔离结果冒充真实回退验收。
5. 应用内数据恢复会生成 `*.pre-restore-*.sqlite` 回滚副本，保留至验收完成。

## 人工/系统与外部条件
- 原生诊断保存框：设置→数据与诊断→导出诊断→系统框默认 `Seamo-R1-diagnostics.json`→点“保存”；核对文件不含聊天/密钥/音频。该步骤为人工，不代点/不向其他应用发按键。
- 钥匙串、Gatekeeper、系统通知/麦克风权限均为用户/系统步骤；不代输密码、不改 ACL、不删 vault/重填 Key。
- Developer ID 签名与公证、正式安装包下载与系统级卸载验收为独立外部条件，不由本机隔离验证覆盖。

## alpha.20↔alpha.21（E6 追加）
- 隔离目录/fake HOME/合成数据：alpha.20→alpha.21 原数据保留+新写入成功，SQLite 12；回退 alpha.20 后 alpha.21 新增记录仍可读，SQLite 12。alpha.20 保留；未触碰用户 alpha.17。

## alpha.21↔alpha.22（F04a 修复候选追加）
- 隔离目录/fake HOME/合成数据：alpha.21→alpha.22 原数据保留+新写入成功，SQLite12；回退 alpha.21 后 alpha.22 新增记录仍可读，SQLite12。alpha.21/20/19 原包保留；未触碰用户实际 alpha.21 的 userData 与快照。
