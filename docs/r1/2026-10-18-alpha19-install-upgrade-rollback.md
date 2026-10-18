# alpha.19 本机隔离安装/升级/回退验证（2026-10-18）

范围：仅使用本机生成的 alpha.18/alpha.19 包副本、独立 Applications 目录与独立 fake HOME；未读取/复制真实凭据，未触碰用户 alpha.17 数据目录，未删除/恢复任何用户数据。验证层级为“本机可执行步骤”，不等于 Developer ID 签名/公证后的正式分发验收。

## 1. 安装（隔离）
1. `mkdir -p /tmp/<chk>/Applications`；将 alpha.18 包 `Seamo AI R1.app` 复制到该目录（`ditto`）。
2. 以独立 home 启动：`CFFIXED_USER_HOME=/tmp/<home> HOME=/tmp/<home> <app>/Contents/MacOS/Seamo AI R1 --remote-debugging-port=<free>`，cwd 设为 `/tmp`（避免读取项目 `.env`）。
3. 首次启动：完成/跳过引导；创建合成待办、记忆、提醒各1条。
4. 结果：应用启动成功（title "Seamo AI R1"）；数据写入隔离 userData；SQLite `PRAGMA user_version=12`；无真实凭据。

## 2. 升级（alpha.18→alpha.19）
1. 退出应用；删除隔离目录内旧 `.app`，把 alpha.19 包复制到同一路径（模拟原位升级）。
2. 同一 fake HOME 启动；build-info 显示 `sourceCommit=970bcbd`、`appVersion=1.0.0-alpha.19`。
3. 结果：原合成待办/提醒仍可读；新增合成记录成功；`PRAGMA user_version=12`；无升级报错。

## 3. 回退（alpha.19→alpha.18）
1. 退出；删除 alpha.19 `.app`，复制 alpha.18 包回同一路径。
2. 同一 fake HOME 启动；build-info 显示 `sourceCommit=ebbc613`、`appVersion=1.0.0-alpha.18`。
3. 结果：alpha.19 期间新增的记录仍可读；原提醒/待办可读；`PRAGMA user_version=12`；无数据损坏。

## 4. 系统安全/人工步骤（不绕过）
- 本机 ad-hoc 签名、未公证；若从下载/隔离属性打开出现 Gatekeeper 拦截，需要用户在“系统设置→隐私与安全性”选择“仍要打开”或右键打开；本次验证从 Terminal/本地复制启动，未演示/不绕过 Gatekeeper。
- 新包首次启动可能出现钥匙串授权提示（Seamo AI R1 Safe Storage）：需用户输入 macOS 登录密码并选择允许；不代输、不改 ACL、不删除/重填 Key。
- Developer ID 签名与公证、真实安装包下载、系统级卸载/回退为独立外部条件，不由本验证覆盖。

## 5. 结论
- 本机隔离 install → upgrade → rollback 三步可执行且数据在 alpha.18/alpha.19 间保持；schema 12 双向兼容。
- 未发现安装/升级/回退代码阻断；剩余为 Gatekeeper/钥匙串人工步骤与 Developer ID/公证。
