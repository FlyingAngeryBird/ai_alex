# 版本与恢复索引

| 标识 | 指向 | 内容 | 运行状态 |
| --- | --- | --- | --- |
| `legacy-mvp-2026-06-27` | `b85da0c` | GitHub 上最后发布的旧 MVP 源码 | 独立工作树构建通过、7 个测试文件 13 项通过；安装未验证 |
| `legacy-mvp-2026-07-05` | `5b1a56e` | 本机已提交的旧语音/音乐 MVP | 独立工作树构建通过、28 个测试文件 163 项通过；安装未验证 |
| `08554b7` | `codex/seamo-r1` 首提交 | 2026-10-13 工作区完整快照（不含忽略的 `.env`、依赖和构建物） | R1 基线构建与 203 项测试通过 |

旧标签只标识源码，不代表当时发布过可下载应用。仓库目前没有 GitHub Release。查看或构建旧版时，应使用独立工作树和隔离的用户数据；不要在有未提交修改的原工作目录直接切换提交。R1 阶段标签仅在相应门槛通过后建立，安装包另附测试与来源提交。

旧源码检出位置：`/Users/sea/Documents/ai_alex-legacy-2026-06-27` 和 `/Users/sea/Documents/ai_alex-legacy-2026-07-05`。可在相应目录运行 `npm ci`、`npm run build`、`npm test` 复验；旧应用的实际安装和用户数据回退仍须单独验证。

R1 当前是开发预览：应用 ID `com.seamo.ai.r1`，数据目录 `~/Library/Application Support/Seamo AI R1`，旧 `lingli`/`lingmo` 的 JSON 只读导入。构建出的 `.app` 仅本机临时签名，未经 Developer ID 签名、公证及安装验证，不能标成正式 Release。

2026-10-13 已在现有公开仓库建立远端 `main`（当前指向原 GitHub 旧版提交 `b85da0c`）、`codex/seamo-r1` 和两个旧版标签；原 `feature/lingli-mvp` 保留。R1 开发差异见草稿 PR [#1](https://github.com/FlyingAngeryBird/ai_alex/pull/1)。`main` 只接收后续已验收版本，开发提交不会自动合并。

## 开发分支增量（2026-10-17 D1–D3）

`codex/seamo-r1` 已包含 D1 事项删除/导出可信 UI 桥（DEC-053）、D2 查询→候选→保存/提醒完成合同（DEC-054）、D3 临时保存确认与播报审计（DEC-055）、D4 音乐本地闭环与死源退避。当前源码资产 3.5.2、工具 schema 3.2.0、SQLite 12。E1 更新包 `1.0.0-alpha.16`（包源 `164b354`，资产 3.5.7）：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha16-e2/`，ZIP 148,351,784 字节，SHA256 `1530c8fd6fa0bb386d9bf54d476117afaa0d35f574d082d60c16fe048fbc43ff`，本机 ad-hoc 签名、未公证。
E1 更新包 `1.0.0-alpha.15`（包源 `8e882b8`，资产 3.5.6）：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha15-e1/`，ZIP 148,348,837 字节，SHA256 `17577463e4333f7b84305ec070b045686f665336510ef69c04f5269a777a9f51`，本机 ad-hoc 签名、未公证。
E1 更新包 `1.0.0-alpha.12`（包源 `8dd48f0`，资产 3.5.3）：
`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha12-e1/`，ZIP 148,343,367 字节，SHA256 `7c59d8c082476083eb286b8b2e112fc4b5c4bef920d091ce1e04c7ca7156d821`，本机 ad-hoc 签名、未公证。
D5 内部验收包 `1.0.0-alpha.11`（包源 `29a2915`）保留在 `/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha11-d5/`。
alpha.10 及更早安装包不含 D1–D5 提交；旧包不能直接打开 SQLite12 数据，回退需使用对应升级前快照。E1 升级前快照：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha11-d5/pre-alpha11-data-20261017-2332/`。

## 最新预览与验收范围（2026-10-17）

alpha.10（DEC-049）源码`fc162d1`已同步GitHub并打包：资产3.3.0/SQLite11，当前候选上下文及页面/会话共用保存、关联提醒；真实搜索＋M01隔离库两阶段通过，97文件634项通过，alpha.10实际窗口已打开，页面后台查询Ark超时、未进入搜索，实际UI/语音V13未通过。普通提醒到期和专注结束短播报已在alpha.7实测6214/3409ms、heard，用户确认两次声音正常。见[candidate记录](2026-10-17-candidate-continuation-progress.md)与[提醒记录](2026-10-17-reminder-delivery-progress.md)。

| 版本 | 源码 | 资产 / SQLite | 验证范围 |
| --- | --- | --- | --- |
| alpha.9 | `22a4450` | 3.2.3 / 11 | 633项、构建通过；固定跨会话20题自动19/20、话题更正/忘记3步真实服务通过；尚未启动此包或验收实际语音 |
| alpha.8 | `321df09` | 3.2.1 / 11 | 提醒创建→同ID改期→取消→一次回访→缺时刻不写入5步真实文字服务通过；627项与构建通过 |
| alpha.7 | `25d277c` | 3.2.0 / 11 | 624项回归、构建、真实到期事件→Ark→TTS通过；实际窗口/出声待钥匙串确认后核验 |
| alpha.6 | `9a1ffda` | 3.1.1 / 11 | 用户确认短任务完成简报声音正常，设备heard/14817ms；同工作稿v1→v2局部修改通过 |
| alpha.4 | `1990b09`，标签`r1-preview-1.0.0-alpha.4` | 3.0.0 / 11 | 用户确认闲聊及天气＋RFC多问题实时检索提示、文字和声音测试无问题 |

alpha.9源码22a4450已同步现有GitHub开发分支；alpha.8/9独立预览包均保留来源、校验及验收文件，尚无实际启动通过声明。alpha.7源码亦已同步；没有合并main或宣称G阶段通过。预览包目录`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-alpha7-reminder-delivery/`保存ZIP、SHA256SUMS、来源与验收manifest。包使用本机临时签名，未经公证；alpha.6保留原路径，不覆盖。回退alpha.7代码和资产至`6fd0efd`对应alpha.6报告状态，数据schema不变；不覆盖现有数据库或遗忘抑制。

以下为历史检查点，旧的推送/锁屏/未配置状态以当时记录为准，当前状态见[交付状态](2026-10-17-current-status.md)和[兼容检查](compatibility.json)。

## 2026-10-17 开发检查点

alpha.2最终开发预览标签`r1-preview-1.0.0-alpha.2-build2`指向`9017bf8`，已同步GitHub；功能检查点标签`r1-preview-1.0.0-alpha.2`仍指向`6dae5ac`。最终包/142MB ZIP与SHA256见验收说明。DEC-038修正macOS产品版本元数据，最终启动升级因锁屏未验证。alpha.2源码新增范围清理/单历史删除/引导/任务恢复提示/错过提醒，SQLite11，资产2.5.1。自动保存升级前副本；回退旧R1代码须隔离数据并使用schema10升级前副本，不能直接降级打开schema11。交付范围与未验收项见[alpha.2验收说明](2026-10-17-alpha2-acceptance.md)，未打G阶段通过标签或创建正式Release。

当前稳定性预览为源码`f3eab20`：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-f3eab20/Seamo AI R1.app`。544项与构建通过，包内源提交匹配且签名完整性通过。旧8fbc6d6最后连接2轮无异常的诊断已保存；用户允许钥匙串后，f3eab20首页和新增诊断UI实际打开、配置恢复，麦克风关闭。已转入用户主动20轮/插话验证；自然20轮、噪声/设备及30分钟听测仍待验收，模拟结果不替代。详见[稳定性记录](2026-10-17-voice-stability.md)。

当前可复测开发包为源码`8fbc6d6`：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-audio-segments/Seamo AI R1.app`。用户实测字幕不重复、回复可出声；3次播放完成与heard回执已核验，538项回归和构建通过。仅短会话通过，1次欠载待长听观测；20轮、打断、工具/设备/延迟及正式签名/公证/安装仍未验收。以下21e027f为历史开发检查点。详见[音频联调记录](2026-10-17-native-audio-progress.md)。

音频传输和计数诊断源码`21e027f`已保存，86文件535项与生产构建通过。仓库外独立预览`/Users/sea/Documents/Seamo-R1-Previews/2026-10-17-21e027f/Seamo AI R1.app`已生成、签名完整性通过；启动暂时阻塞在系统钥匙串读取，尚未证明新页面可用或真实出声。用户上次实测无声/拥塞已记失败，详见[音频联调记录](2026-10-17-native-audio-progress.md)。本批源码回退`b02ceb7`，数据Schema不变；不标阶段通过或正式Release。

## 2026-10-15 开发检查点

最新交付修复以`ba000b4`为源码回退点：语音配置前检与真实恢复确认通过；打包完整生产依赖、可追溯构建信息和仓库外启动的记录见[交付进度](2026-10-15-delivery-progress.md)。下文「恢复确认UI未验收」为上一批历史状态。本机开发预览不等同正式Release。

源码`51f50e2`的开发预览已在仓库外独立启动：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-15-51f50e2/Seamo AI R1.app`。本机签名完整性通过，包内记录源提交及资产版本，508项回归通过。原生服务、音乐、全量A/V及正式安装验收未完成；无正式Release/阶段通过标签。

数据/诊断批次以 `1b294e7` 为源码回退点，SQLite10/资产2.5.1不变。完整备份、范围数量预检、窗口票据、离线恢复与正式主进程重启、删除抑制/授权保留、默认无正文诊断已有实现及证据；恢复确认UI、选择数据域及分类清理仍未验收/未补齐。详见 [数据记录](2026-10-15-data-progress.md)。不标G1/G5通过，不创建Release。

减少动态增量回退源码为 `da12758`，当前SQLite10、资产2.5.1；schema9升级前快照保留设备/勿扰偏好。完整81文件492项和生产构建通过，正式窗口动态开关重载持久化及首页/设置局部同尺寸对照有证据。详见 [设置与动态记录](2026-10-15-settings-progress.md)。仍无阶段通过标签、正式包或新推送成功证据。

设备与安静模式批次的回退源码为 `6b7aa5f`，SQLite9、资产2.5.1；schema8 升级前自动快照。81文件490项和后续77项关联检查、生产构建通过；真实桌面设置保存/重载与未配置反馈已核验，实际音频/通知权限和安装未验收。详见 [设置记录](2026-10-15-settings-progress.md)。

`codex/seamo-r1` 的本批音乐整合以父提交 `de8b600` 为回退源码点；报告为 [音乐进度](2026-10-15-music-progress.md)，资产2.5.1、SQLite8。升级前自动保留 schema7 快照；回退需隔离数据，旧代码不能直接打开 schema8。77文件472项及生产构建通过；实际音源核验失败、未听音或安装验收。未打 G4 通过标签，未创建 Release。最近一次推送因 HTTPS 未登录失败；没有新推送成功证据，不能认为本地开发提交已全部在 GitHub。

## 1.0.0-alpha.17（导出标题修复候选包，2026-10-18）
- 源码提交：`6a0f482`（修复：正文首个非空行与 Artifact 标题相同的 H1 时不再重复添加导出标题，TXT/MD 一致；保留正文与不同标题）。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha17-e4fix/`；ZIP `Seamo-AI-R1-1.0.0-alpha.17-mac-arm64.zip` 148,705,341 字节，SHA256 `c746ee0820184a41bc47463a1214588629dcfe798b1da7a8e129fa4b09631a5a`；资产 3.5.7、SQLite 12、bundle `com.seamo.ai.r1`，ad-hoc 未公证，无凭据/用户库。
- alpha.16 包与升级前快照保留；已导出用户文件未覆盖（验证写入新文件 `~/Documents/E4-fix-check.txt/.md`，184B 且内容一致）。

## 1.0.0-alpha.18（E5 集成候选，2026-10-18）
- 源码：E5 批量修复（Esc 面板/音乐资料库/任务面板防丢失、音乐搜索错误码+重试、music_failure 脱敏诊断、任务面板 flush）。
- 隔离验证：F06b/F06c/F07b/F08d/F09b/F01c/F11a Esc；搜索失败重试 mock；诊断 payload 脱敏。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha18-e5/`；ZIP `Seamo-AI-R1-1.0.0-alpha.18-mac-arm64.zip` 148,708,227 字节，SHA256 `898ac18dddd2e2dc4069b719cfa304879ab7a178f43797ffcd235defe137ecc4`；源码 `ebbc613`；资产 3.5.7、SQLite 12、ad-hoc 未公证、无凭据/用户库。
- 该包为 E5 集成候选（重建后含任务面板全离开路径 flush 守卫），未替换/未重启用户当前 alpha.17 窗口；隔离验证基于同产品源码提交（仅版本号差异）。

## 1.0.0-alpha.19（E5 编辑防丢最终集成候选，2026-10-18）
- 源码 `970bcbd`：alpha.18 基础上修复任务编辑器有效保存后 Esc 竞态误报未保存（flushEditing 失败后 250ms 复核一次）；产品行为仅此一处变化。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha19-e5-retention/`；ZIP 148,708,256 字节，SHA256 `2b8a593dcc5699fbbb6984504b1ac87f4202e2c96266702da5ced0749ce6d941`；资产 3.5.7、SQLite 12、ad-hoc、无凭据/用户库。
- alpha.18 包保留（源码 `ebbc613`，ZIP SHA256 `898ac18dddd2e2dc4069b719cfa304879ab7a178f43797ffcd235defe137ecc4`）；未替换/未重启用户当前 alpha.17 窗口。

## 1.0.0-alpha.20（原型对齐批次，2026-10-18）
- 源码 `c4af1f5`：首页问候/三快捷动作/真实上次聊到；音乐默认搜索+按需资料库；事项标题/未定时间；记忆相对日期；历史计数/本地标签/相对日期；设置说明入口与高级服务折叠；记忆 createdAt 透出。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-18-alpha20-r1-align/`；ZIP 148,709,251 字节，SHA256 `230b9e9c5813c62e64eee96787fafb6fac5cd51d3aacce60940d88c41712e955`；资产3.5.7/SQLite12/ad-hoc/无凭据。
- alpha.19 原包保留；用户 alpha.17 未替换/重启；原型对齐对照见 2026-10-18-alpha20-prototype-alignment.md。

## 1.0.0-alpha.21（E6 真实模型修复批次，2026-10-19）
- 源码 `4221ac9`：修复 memory_recall category/validUntil 序列化 null、ARK incomplete reason=length 分类；资产 3.5.8；E6 小真实集通过。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-19-alpha21-e6/`；ZIP 148,709,464 字节，SHA256 `2d4dbff978a2e18151ff01b6c85f5df9eb5dfc5b05fee7b1219584877df8f88a`；SQLite 12、ad-hoc、未公证、无凭据/用户库。alpha.20/19 保留；用户 alpha.17 未替换。

## 1.0.0-alpha.22（F04a 固定集修复，2026-10-19）
- 源码 `5b291b9`：保留否定偏好检索、避开/忌口→不喜欢规范化；PR01/PR03/SK01/SK05 memory-first 规则；资产 3.5.9、PR03 2.2.5；模型/预算/固定集/scoring 未改。
- F04a 20 例固定集：run1 14/20、run2 13/20、run4 17/20、run5 18/20（90%，通过）；失败样本与分类保留在 evidence/2026-10-19-e6/f04a-classification.md。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-19-alpha22-f04a/`；ZIP 148,712,396 字节，SHA256 `b9d9681a6cccc81ae8c8c51f93a33a97f758130bd6640e740546fdc897ccf5ec`；SQLite12、ad-hoc、未公证、无凭据/用户库。

## 1.0.0-alpha.23（E8 配置恢复/本机功能候选，2026-10-19）
- 源码 `c4a390d`：凭据读取失败分类、准确恢复提示、显式 recover（旧加密文件保留备份，不删除/不改 ACL/无明文）；资产3.5.9。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-19-alpha23-e8/`；ZIP 148,713,656字节，SHA256 `920c0b00daeeabed81fc597791290c7c4325112bf8d6fe6a3ef7a506b709fb9b`；SQLite12、ad-hoc、未公证、无凭据/用户库。alpha.22实际App与旧包保留。

## 1.0.0-alpha.24（E10 交互与状态收尾，2026-10-22）
- 源码 `9b23426653a1a5e8752b079ff35288a742e176fb`：编辑对象版本冻结、过期提醒分组、多行输入及单次提交、设置/任务编辑离开保护、弹窗焦点及提示文案。范围与41项状态见 [E10收尾记录](2026-10-22-r1-closure.md)。
- 包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-22-alpha24-e10/`；ZIP 148,716,946字节，SHA256 `1934ab5805477399b23da371d05c06b975a103cad90ec4531ba1fab7b8ee5479`；资产3.5.9、SQLite12、ad-hoc、未公证、无凭据/用户库。
- 109文件/700项、类型检查和构建通过；独立 fake HOME 包启动及签名完整性通过。随后真实用户数据快照完成并切换 alpha.24；原配置经一次手动重读可用，Ark 和实时连接检测通过，用户确认短句声音及字幕正常。长时语音、边听边聊和正式安装门槛仍待验收。

## 1.0.0-alpha.25（设置数据区交互与视觉修正，2026-10-22）
- 源码 `bf4969d5de0edc54e0eb6a906bcced3c4710dcc4`；包：`/Users/sea/Documents/Seamo-R1-Previews/2026-10-22-alpha25-data-layout/`，ZIP 148,717,740 字节，SHA256 `995b3fd8556465f6bc81a9719fe51263198ab1d7e3239fbb530e73caefeef577`；资产3.5.9、SQLite12、ad-hoc、未公证，包内无 `.env`、凭据或用户库。
- 修复「选择清理范围」复选框被通用输入样式拉伸为白色方块、选项文字偏移的问题。选项改为整行可点、清晰勾选状态；不改变预览、确认、清理和回退逻辑。
- 将备份、恢复、诊断分成独立操作区，保留未加密备份、凭据保留和诊断脱敏等必要说明；高影响的「清理本地内容」默认收起，展开后选范围、预览、再确认。
- 本批只涉及设置数据区及版本号。浏览器隔离预览已检查常规和700像素视口下的布局、勾选状态与预览门槛；typecheck/build、签名完整性通过。真实用户数据切换前已保存本机快照；alpha.25 实际应用启动、原历史可读、麦克风关闭，设置数据区可由辅助功能读取。实际窗口截图操作受界面工具限制，未把隔离预览写成正式包的视觉验收。

## 1.0.0-alpha.26（音乐搜索、结果归组与播放布局，2026-10-22）
- 三音源逐个返回即可展示与操作；搜索移除逐首封面请求、加入在途合并与缓存、失败退避及手动真实重试。默认全部，每源默认10条，展示全部返回结果。
- 同名同歌手归组并保留全部版本；修复歌曲列表窄列竖排、按钮挤压、面板和输入框遮挡。搜索与音源固定，结果独立滚动；播放球体适度右移，歌词保留右侧。
- 7文件55项相关测试、类型检查和生产构建通过；真实元数据样本首批约3.5秒、共20条约4.1秒、缓存2ms。浏览器生产组件桌面/700px隔离布局与操作验证通过；粒子动态算法本批未改。详见[本轮记录](2026-10-22-music-search-iteration.md)。
- 包源码 `ce3d860f0cf564e476a23c3a9504d8e609f39e23`；目录 `2026-10-22-alpha26-music-search`，ZIP 148,721,301字节，SHA256 `3a5fba0aad531cd10a4cc802fea74fb953f88fc98d1fc4e1ed0464ce35a6229d`。本机ad-hoc未公证，包内无环境密钥/凭据/用户库。实际应用已切换、历史可读、麦克风关闭、音乐入口可打开；服务状态读取失败仍待处理，不声称本候选语音/听感已验收。
