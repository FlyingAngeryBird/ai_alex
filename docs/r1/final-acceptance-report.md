> **alpha.26 音乐迭代（2026-10-22）：** [搜索、列表和粒子位置记录](2026-10-22-music-search-iteration.md)。当前候选见交付清单，前三项已交付；粒子算法未改，完整PRD验收及发布门槛仍保留。

> **2026-10-22 当前状态：** [E10功能与交互收尾记录](2026-10-22-r1-closure.md)优先于下方 alpha.23 历史报告。新候选与真实设备验收仍进行中，暂不批准正式发布。

> 最新接管说明（2026-10-19 E9）：后续由 Codex 直接开发，DeepSeek 暂停。凭据生命周期发现并修复状态查询隐式重读、同步阻塞、并发保存和诊断导出问题；定向 29 项与构建通过。本批仅源码，实际 alpha.22/候选 alpha.23 未替换，原生认证尚未恢复。用户截图证实 login 解锁且条目允许所有应用访问，本文历史“解锁 login 即可”的步骤不再作为有效处理建议。详情：[E9](2026-10-19-e9-credential-lifecycle.md)。

# Seamo AI R1 内部验收候选交付报告（最终版，alpha.23）

> 结论：**alpha.23 是内部验收候选，尚不批准“全部完成”。** 功能代码/E5 交互缺口与可自主执行的验证已收口；真实语音听感、真实边听边聊、系统权限/通知、全页面视觉与全 A/V 场景、Developer ID 签名/公证与正式安装验收仍需人工或外部条件。

## 1. 最终候选与历史包（版本/时点明确）
| 版本 | 源码提交 | 包路径 | ZIP 字节 | SHA256 | 说明 |
| --- | --- | --- | --- | --- | --- |
| **alpha.23（最终候选）** | `c4a390d` | `/Users/sea/Documents/Seamo-R1-Previews/2026-10-19-alpha23-e8/` | 148,713,656 | `920c0b00daeeabed81fc597791290c7c4325112bf8d6fe6a3ef7a506b709fb9b` | E8 凭据恢复/诊断；当前 final candidate |
| alpha.22（实际运行） | `5b291b9` | `2026-10-19-alpha22-f04a` | 148,712,396 | `b9d9681a…` | 实际 App 窗口运行；旧包保留 |
| alpha.21（保留） | `4221ac9` | `2026-10-19-alpha21-e6` | 148,709,464 | `2d4dbff9…` | E6 候选；实际 App 仍在运行并受钥匙串阻断 |
| alpha.20（保留） | `c4af1f5` | `2026-10-18-alpha20-r1-align` | 148,709,251 | `230b9e9c…` | 原型对齐候选 |
| alpha.19（保留） | `970bcbd` | `2026-10-18-alpha19-e5-retention` | 148,708,256 | `2b8a593d…` | E5 防丢候选 |
| alpha.18（保留） | `ebbc613` | `/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha18-e5/` | 148,708,227 | `898ac18dddd2e2dc4069b719cfa304879ab7a178f43797ffcd235defe137ecc4` | E5 集成前一候选，编辑保存竞态已在 alpha.19 修复 |
| alpha.17（保留） | `6a0f482` | `/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha17-e4fix/` | 148,705,341 | `c746ee0820184a41bc47463a1214588629dcfe798b1da7a8e129fa4b09631a5a` | 导出标题去重验证 |
| alpha.16（保留） | `164b354` | `/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha16-e2/` | 148,351,784 | `1530c8fd6fa0bb386d9bf54d476117afaa0d35f574d082d60c16fe048fbc43ff` | E1/E2 主要真实窗口证据所在包 |

- 共同版本：资产 3.5.7、工具 schema 3.2.1、SQLite 12、bundle `com.seamo.ai.r1`；本机 ad-hoc 签名、**未 Developer ID/未公证**；包内无 `.env`/凭据/用户库。
- 用户 alpha.17 验收窗口保持运行、未被替换/重启；各候选包并存可回退。

## 2. 验证证据（按版本/层级；历史证据保留时点）
### 真实窗口/真实服务（alpha.16、alpha.17）
- E1：真实任务搜索读页→候选并排比较→选中第2→自然保存→关联提醒→重复保存同一 Item（alpha.16）。
- E2：合成记忆记住/回想/更正/忘掉且下一轮不复活；临时对话不读长期记忆/不落消息/明确授权保存/退出清理；同包重启专注 paused、偏好/事项/提醒保留（alpha.16）。
- 工作稿：第二段续改 v3→撤销 v4→前三段保留→保存便签；TXT/MD 原生保存框保存成功（alpha.17，`~/Documents/出门前检查清单.txt/.md`）。
- 音乐：netease 真实播放/歌词时钟/真实 TTS 降音/暂停/音量优先（alpha.16）；真实 seek：播放中 120s→position 121.05s 且 LRC 立即重算，暂停 seek 45s→position 45s 仍 paused（alpha.17）。
- 未覆盖：真实用户语音边听边聊（钥匙串未恢复）、真实听感、系统通知权限/勿扰中心。

### 隔离/包内验证（alpha.16–alpha.19）
- E3 数据：备份排除凭据/legacy JSON；诊断不含正文/Key/音频；还原 schema/外键/完整性预检+回滚副本；删除抑制合并使旧备份不能复活遗忘/更正事实；62 项相关测试。
- 任务恢复：隔离真实 UI 受控注入 running→needs_resume→继续→执行不重放；首次引导跳过不启麦克风/自动会话/自动记忆。
- 窄窗：真实 renderer 900/700 覆盖；alpha.18/19 包 Esc 关闭设置/事项/音乐资料库。
- 搜索失败/重试（alpha.18/19 隔离包，mock provider）：失败提示含 `MUSIC_PROVIDER_UNAVAILABLE` +「重试搜索」，重试产生新请求（3→6），mock 恢复后重试成功渲染；真实 provider 当前状态不由此断言。
- 编辑防丢（alpha.18/19 隔离包）：8001 字保存失败时 Esc 面板保持、内容保留、错误“正文最多 8000 个字，当前文字已保留”；设置/陪伴导航被阻止且内容保留；alpha.19 修复有效保存后单次 Esc 关闭（artifact v3）。所有关闭/Esc/侧栏/视图切换/继续话题/临时模式切换均先 flush，失败不隐藏。
- 提醒/勿扰/回访（alpha.19 隔离包）：标准提醒到期 systemRequested=true/silent=false，多次 tick 无重复；DND=true 时 silent=true 仍投递；followup 仅一次；重启后 >24h→missed、≤24h→due/system_requested。
- 专注（alpha.19 隔离包）：start→pause→resume→stop v1→v4 状态/remaining 一致；60s 完成 remaining0/v2+deliveryId；`endMusicRule=pause_user_selected_track` 完成时暂停用户选中曲目。
- 音乐失败诊断（源码+单测）：`music_failure` 仅 provider/phase/安全错误码/upstreamStatus/traceId/耗时；实际 `buildDiagnosticExport` 对恶意额外字段脱敏、无敏感串、隐私标记 false；原生保存框文件落盘为人工步骤。
- E5 本地闭环（隔离 API）：F06b 完成/撤销与关联提醒去留、F06c 删除保留/取消/过期确认拒绝、F07b 改期取消同 ID/版本一致、F08d 收藏/dislike/skip 区分、F09b 长度/范围失败保留内容、F01c Space/IME/切页草稿。
- 安装/升级/回退（隔离目录+合成数据，alpha.18↔alpha.19、alpha.19↔alpha.20 与 alpha.20↔alpha.21）：install→upgrade→rollback 三步均启动成功，SQLite 12；alpha.19 新增数据在回退 alpha.18 后仍可读；未触碰用户 alpha.17。详见 [install-upgrade-rollback](2026-10-18-alpha19-install-upgrade-rollback.md)。

### 原型对照
- 五页面/设置辅助层、宽/窄窗、空/失败/长文已对照：结构整体一致；差异与明确视觉缺陷见 [原型对照](2026-10-18-alpha19-prototype-comparison.md)（含设置顶部空白“查看首次使用说明”按钮样式缺陷）。本对照不替代用户视觉验收。

## 3. 之前旧结论的更正（明确版本时点）
- “音乐全部不可用”：**不再成立**。alpha.16/17 已验证 netease 备用曲目真实播放/歌词/seek；晴天等点名原版仍缺、joox 部分 503、kuwo 不支持，未静默替换。真实音源范围仍有限。
- “TXT/MD 待保存”：**alpha.17 已真实验证导出**并写入新文件；既有用户导出未被覆盖。仅原生诊断保存框仍列人工步骤。
- “Git 推送受阻”：代码/文档已用 SSH 推送；`gh` token 失效仅影响 PR 描述文本更新，不是分支同步阻断。
- “alpha.16 完整性”：属于 alpha.16 时点证据；当前最终候选为 alpha.23，完整性/清单以本报告与 manifest 为准。

## 4. 41 项状态摘要
逐项见 [R1-delivery-board.md](R1-delivery-board.md)。当前口径：
- 已验证（真实/隔离包）：F04a/F04d/F04e、F05b/F05c、F06a–F06d（导出/取消/防丢）、F07a/F07b/F07c(部分)/F07d/F08c/F08d/F08e/F08f/F09b/F09c、F10a/F10b(隔离)/F10c(部分)、F11a(部分)/F11b(隔离)/F11c(部分)/F11d(部分)、F01c(隔离部分)。
- 待用户/实包验收：F01a/F01b/F01d、F02、F03a/F03b(部分)、F05a/F05d、F06b/F06c 真机页面/语音联动、F07c 系统通知、F08a/F08b 真实音源/听感、F08e 听感、F10b 真实在飞重启、F11a 全页面视觉；F04b/F04c/F09a 已由小真实集验证，F04a 固定集达 90% 门槛；真实语音/系统仍待人工。
- 外部/人工：真实语音/边听边聊、系统权限/通知/勿扰中心、休眠唤醒、真实听感、全 A/V 场景、原生保存框人工步骤、Developer ID/公证、正式安装/回退验收。
- **不宣称 41 项全部满足。** F04a 仅一次 18/20（90%）通过，非稳定性；M03/M13 残留、run3 原始记录缺失；原数据集/scoring/模型/预算未改，不再重跑。E8 凭据恢复与系统阻塞见 docs/r1/2026-10-19-e8-credential-recovery.md。

## 5. 剩余工时（区分可自主与人工/外部）
- 自主编码/集成：**已知代码缺口 0**；如产品批准视觉修正（设置空白按钮等）约 0.5–1.5h + 集成验证 0.5–1h。
- 人工/系统 A/V：真实语音/听感/边听边聊、麦克风权限、通知/勿扰中心、休眠唤醒、设备路由、全页面视觉约 3–5h。
- 外部发布条件：Developer ID 签名/公证、正式安装包下载/Gatekeeper 验收、安装/卸载/回退用户验收约 2–4h。
- 人工原生保存框（诊断/导出）约 0.2h（可顺带完成）。
- 合计约 **5–9h 人工/外部**（不是全部人工；自主可完成项已在本轮完成）。

## 6. 未解决/需用户操作
1. login 钥匙串解锁：钥匙串访问→解锁 login→设置点一次「重新读取服务配置」；完成后才能做真实语音边听边聊/模型相关。
2. 真实听感/粒子视觉确认：播放音乐时确认是否听到、看到歌词/粒子；不代填。
3. 原生诊断保存框：设置→数据与诊断→导出诊断→系统框默认 `Seamo-R1-diagnostics.json`→点保存；核对无聊天/密钥/音频。
4. Developer ID/公证条件、Gatekeeper/正式安装验收由发布流程提供。
5. GitHub PR 描述更新需有效 `gh` token；代码分支已 SSH 同步。

## 7. 结论
- alpha.19 为可安装运行的内部候选，E5 交互缺口和可自主验证已收口；安装/升级/回退在隔离环境可执行；原型差异已逐项列出（含一处样式缺陷）。
- **未达到“全部验收通过”**：真实语音/听感、系统权限、全 A/V/视觉、Developer ID/公证与正式安装验收仍待人工/外部条件；不得合并 main 或正式发布。
