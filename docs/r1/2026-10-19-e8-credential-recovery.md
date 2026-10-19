# E8 配置恢复与本机功能收口（2026-10-19）

## 结论
- **应用可用**：alpha.22 实际窗口正常（Finder/LaunchServices），麦克风关闭；本批代码修复在 **alpha.23** 候选（未切换实际 App）。
- **保存配置访问仍不可用，但不是 login 钥匙串缺失/锁定**：Security framework 只读核验显示默认钥匙串和 search list 都指向存在的 login，`SecKeychainGetStatus` flags=7（unlocked/read/write）；login 文件存在且是 Keychain File。用户看到的是 Keychain Access “Keychain Not Found … Cancel / Reset to Defaults”，已取消，未重置。当前没有可见 Allow/Touch ID 提示，因此不再要求用户认证或解锁。
- 剩余可能原因是应用 safeStorage/条目 ACL/签名身份（0 个有效签名身份，各预览 ad-hoc CDHash 不同）；`credentials.bin` 307 字节原样保留，未删除/改 ACL/未使用明文/env fallback。

## 已确认/修复的应用原因
1. 正常启动无窗口：陈旧 Electron `SingletonLock/Cookie/Socket` 运行时文件，已清理（不碰 vault/DB/ACL），Finder 启动正常；alpha.22 实际窗口已恢复。
2. 错误提示原先把任何失败都指向“解锁 login”，不准确。alpha.23 区分 `SYSTEM_SECRET_STORAGE_UNAVAILABLE` / `CREDENTIAL_DECRYPT_FAILED` / `CREDENTIAL_FILE_INVALID`，明确“访问失败、文件保留、恢复路径”。
3. 新增显式恢复路径：旧 vault 不可读时，用户填写新配置后可创建新加密 vault；**只包含本次新填字段，留空字段视为未配置，不从旧配置合并**；旧加密文件保留为备份，失败写入回滚旧字节；不会自动执行，也不修复系统安全存储不可用、不改 ACL、无明文降级。

## 无需模型的功能（alpha.23 隔离包实测）
- 专注冲突/新时长：已有活动专注时 `FOCUS_ALREADY_ACTIVE`；停止后可新建 120 秒专注，状态 running。
- 本地提醒：创建后实际收到 in-app due 事件（kind=standard，systemRequested=true）；系统通知权限未断言。
- 设备/权限：读取到 2 个音频输入、2 个音频输出；未开麦。
- 诊断：`data.summary` 可读；原生保存框未自动操作，仍为人工步骤。

## 候选
- alpha.23：源码 `c4a390d`，ZIP 148,713,656 字节，SHA256 `920c0b00daeeabed81fc597791290c7c4325112bf8d6fe6a3ef7a506b709fb9b`，资产 3.5.9；alpha.22 实际 App/旧包保留，未重新切换。
- 目标测试：12 项凭据/IPC 通过；构建/typecheck 通过；不重复全量回归。

## F04a 限制
- 仅一次 18/20（90%）通过，不是稳定性结论；M03/M13 残留，run3 原始记录缺失；不再重跑或换供应商。
