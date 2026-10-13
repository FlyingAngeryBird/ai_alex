# 版本与恢复索引

| 标识 | 指向 | 内容 | 运行状态 |
| --- | --- | --- | --- |
| `legacy-mvp-2026-06-27` | `b85da0c` | GitHub 上最后发布的旧 MVP 源码 | 独立工作树构建通过、7 个测试文件 13 项通过；安装未验证 |
| `legacy-mvp-2026-07-05` | `5b1a56e` | 本机已提交的旧语音/音乐 MVP | 独立工作树构建通过、28 个测试文件 163 项通过；安装未验证 |
| `08554b7` | `codex/seamo-r1` 首提交 | 2026-10-13 工作区完整快照（不含忽略的 `.env`、依赖和构建物） | R1 基线构建与 203 项测试通过 |

旧标签只标识源码，不代表当时发布过可下载应用。仓库目前没有 GitHub Release。查看或构建旧版时，应使用独立工作树和隔离的用户数据；不要在有未提交修改的原工作目录直接切换提交。R1 阶段标签仅在相应门槛通过后建立，安装包另附测试与来源提交。

旧源码检出位置：`/Users/sea/Documents/ai_alex-legacy-2026-06-27` 和 `/Users/sea/Documents/ai_alex-legacy-2026-07-05`。可在相应目录运行 `npm ci`、`npm run build`、`npm test` 复验；旧应用的实际安装和用户数据回退仍须单独验证。

R1 当前是开发预览：应用 ID `com.seamo.ai.r1`，数据目录 `~/Library/Application Support/Seamo AI R1`，旧 `lingli`/`lingmo` 的 JSON 只读导入。构建出的 `.app` 仅本机临时签名，未经 Developer ID 签名、公证及安装验证，不能标成正式 Release。
