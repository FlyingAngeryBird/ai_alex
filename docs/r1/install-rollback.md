# Seamo AI R1 内部验收包安装与回退（alpha.18）

## 包信息
- 路径：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha18-e5/`
- App：`Seamo AI R1.app`；ZIP：`Seamo-AI-R1-1.0.0-alpha.18-mac-arm64.zip`（148,708,227 字节）
- SHA256：`898ac18dddd2e2dc4069b719cfa304879ab7a178f43797ffcd235defe137ecc4`
- 源码：`ebbc613`（E5 修复：Esc/搜索重试/诊断/任务面板 flush）；资产 3.5.7；工具 schema 3.2.1；SQLite 12；bundle id `com.seamo.ai.r1`；alpha.16/alpha.17 包保留可回退
- 签名：本机 ad-hoc；**未 Developer ID 签名、未公证**；包内无 `.env`/凭据/用户数据库

## 安装
1. 解压 ZIP 或直接使用 `Seamo AI R1.app`；可放 `/Applications` 或预览目录运行。
2. 首次打开若被 Gatekeeper 拦截：右键 → 打开（内部验收包，非正式分发）。
3. 首次启动会请求钥匙串授权（"Seamo AI R1 Safe Storage"）：输入登录钥匙串密码并选择允许/始终允许（由用户操作；临时签名每次新包可能再次询问）。
4. 数据目录：`~/Library/Application Support/Seamo AI R1`；旧 alpha.10 数据不会被写入。

## 回退
1. 退出应用；保留当前包与数据目录副本。
2. 升级前快照：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha11-d5/pre-alpha11-data-20261017-2332/`（schema 11；**不能**直接给 alpha.10 打开 schema12 数据）。
3. 若需回到 alpha.15/更早包：先备份当前 `r1.sqlite`/`config.json`/`music.json`/`onboarding.json`，再用对应版本的升级前快照替换；不要用旧包直接打开 schema12 数据。
4. 应用内数据恢复会生成 `*.pre-restore-*.sqlite` 回滚副本；保留它直到验收完成。
5. 不覆盖用户原有数据、不复制 vault/`.env`；钥匙串条目由系统管理。

## 已知人工/外部条件
- TXT/Markdown 导出：系统保存框出现后由用户点“保存”。
- 真实可用音乐源（netease 目标原版/joox 资源恢复）；Developer ID 签名与公证；真实设备语音/通知/安装回退验收。
