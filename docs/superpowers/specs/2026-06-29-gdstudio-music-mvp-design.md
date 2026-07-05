# GD Studio 音乐播放 MVP 设计规格

## 1. 背景与目标

灵粒当前音乐模块仍偏 demo：已有音乐页、迷你播放器、暂停/继续/退出等 UI，但真实在线音乐搜索、播放链接、歌词同步、音频频谱驱动还没有完整接入。

本阶段目标是放弃 Apple Music 路线，改用 GD Studio 音乐 API 作为 MVP 内测音乐源，实现一条真实闭环：

用户发起点歌或点击播放音乐 -> 系统搜索歌曲 -> 获取可播放 URL -> 进入沉浸播放页 -> 真实音频播放 -> 歌词同步 -> 支持暂停、继续、退出 -> 失败时清楚提示。

本方案只改音乐相关逻辑，不改语音、LLM 对话、TTS、基础粒子组件结构等其他业务模块。

## 2. 范围

### 2.1 本阶段必须实现

- 使用 GD Studio API 作为 MVP 音乐源。
- 默认音乐源顺序固定为 `netease -> kuwo -> joox`。
- 搜索时按源顺序查询，并合并候选歌曲。
- 播放时如果候选歌曲播放 URL 为空，自动尝试下一首或下一源。
- 获取封面图片，能取到则展示，取不到则使用现有视觉兜底。
- 获取 LRC 歌词，能取到则解析并按播放时间高亮当前行。
- 没有歌词时展示歌曲信息和 AI 推荐语/氛围文案。
- 音乐播放页支持搜索歌曲，用户可手动输入关键词搜索并播放。
- 音乐播放页支持音源选择，音源范围为 `netease`、`kuwo`、`joox`。
- 音乐播放页展示专辑图片，图片加载失败时使用现有视觉兜底。
- 前端使用真实 `<audio>` 播放远程音频 URL。
- 暂停、继续、退出必须控制真实音频。
- 退出后清空播放状态，主窗口下方不再出现迷你播放器。
- 歌曲播放时粒子球进入专门的音乐律动效果，不沿用普通说话态或简单抖动。
- 删除或停用 Apple Music provider、Apple Music 环境变量与相关错误提示。
- 保留音乐 provider 边界，方便未来替换正式版权音乐服务。

### 2.2 本阶段不实现

- 不做 Apple Music / MusicKit 授权。
- 不做正式商业版权音乐接入。
- 不做歌曲下载、缓存保存、离线播放。
- 不做用户歌单、收藏、播放历史。
- 不做跨平台系统媒体键控制。
- 不改动语音识别、豆包对话、TTS 的业务链路。

## 3. GD Studio API 能力评估

文档地址：`https://music-api.gdstudio.xyz/api.php`

### 3.1 可用接口

搜索：

```text
GET https://music-api.gdstudio.xyz/api.php?types=search&source=[SOURCE]&name=[KEYWORD]&count=[COUNT]&pages=[PAGE]
```

返回字段包括：

- `id`：曲目 ID
- `name`：歌曲名
- `artist`：歌手数组
- `album`：专辑名
- `pic_id`：封面 ID
- `lyric_id`：歌词 ID
- `source`：音乐源

获取歌曲播放链接：

```text
GET https://music-api.gdstudio.xyz/api.php?types=url&source=[SOURCE]&id=[TRACK_ID]&br=[128/192/320/740/999]
```

返回字段包括：

- `url`：音乐播放链接
- `br`：实际码率
- `size`：文件大小

获取封面：

```text
GET https://music-api.gdstudio.xyz/api.php?types=pic&source=[SOURCE]&id=[PIC_ID]&size=[300/500]
```

返回字段包括：

- `url`：封面图片链接

获取歌词：

```text
GET https://music-api.gdstudio.xyz/api.php?types=lyric&source=[SOURCE]&id=[LYRIC_ID]
```

返回字段包括：

- `lyric`：LRC 原语种歌词
- `tlyric`：LRC 翻译歌词，可能为空

### 3.2 风险与限制

- 文档声明资源来自网络，仅限学习参考，严禁下载、传播或商用。
- 文档声明当前访问频率限制为 5 分钟不超过 50 次请求。
- 实测说明“搜索成功”不等于“可播放”。例如某些 `kuwo` 搜索结果可以返回歌词和封面，但播放 URL 可能为空。
- 某些源对某些关键词可能返回空列表。
- 远程音频链接可能过期或被目标源限制跨域。

结论：GD Studio API 可用于 MVP 内测体验验证，但不能作为正式商业发布的长期音乐版权方案。

## 4. 产品行为设计

### 4.1 点击“播放音乐”

用户点击主界面“播放音乐”：

1. 前端调用音乐模块，请求关键词 `适合此刻的音乐`。
2. 后端按 `netease -> kuwo -> joox` 搜索候选歌曲。
3. 后端按候选顺序尝试获取播放 URL。
4. 找到第一个非空播放 URL 后返回歌曲元数据、播放 URL、封面、歌词。
5. 前端进入沉浸播放页并自动播放。
6. 如果没有任何可播放歌曲，前端显示系统提示：`没有找到可播放的音乐，我换个关键词再试试。`

### 4.2 AI 点歌

用户说“播放一首轻松的音乐”：

1. LLM 继续负责识别 `intent: "play_music"` 和 `music.keyword`。
2. App 层调用音乐模块 `playRequest(keyword)`。
3. 后续流程与点击播放一致。
4. 音乐播放失败时，不影响对话状态，向消息列表追加清楚的系统提示。

### 4.3 沉浸播放页

沉浸播放页展示：

- 搜索框
- 音源选择
- 歌曲名
- 歌手
- 专辑
- 封面或视觉兜底
- 播放进度
- 暂停/继续按钮
- 返回按钮
- 退出按钮
- 歌词区域

返回按钮只离开沉浸页，音乐继续播放并显示底部迷你播放器。

退出按钮停止真实音频，清空播放状态，回到对话页，底部迷你播放器消失。

### 4.4 搜索与音源选择

音乐页顶部右侧增加一个透明玻璃质感搜索区，视觉上与现有深色、柔光、粒子背景保持一致，不做重型表单。

布局建议：

```text
┌ 返回 ─ Playing ─ 退出 ┐
                         ┌────────────────────────────┐
                         │ 搜索歌曲、歌手或专辑       │
                         │ [全部音源 v] [搜索]        │
                         └────────────────────────────┘

      专辑图       歌曲信息/进度/控制       歌词
```

搜索区设计原则：

- 使用半透明玻璃底，轻边框，背景模糊，避免破坏沉浸感。
- 输入框文案为 `搜索歌曲、歌手或专辑`。
- 音源选择提供 `全部音源`、`netease`、`kuwo`、`joox`。
- 默认选择 `全部音源`，实际搜索顺序仍为 `netease -> kuwo -> joox`。
- 当用户选择单一音源时，只搜索该音源；如果该音源无可播放结果，提示用户切换全部音源或其他音源，不自动跨源。
- 搜索时按钮进入加载态，避免重复请求。
- 搜索结果不新增独立大列表，MVP 直接播放第一个可播放结果；失败时自动尝试下一首。

### 4.5 歌词策略

如果接口返回 LRC：

- 解析为 `{ timeMs, text }[]`。
- 按真实音频 `currentTime` 高亮当前行。
- 自动滚动到当前歌词附近。

如果没有 LRC：

- 显示歌曲名、歌手、专辑。
- 显示推荐语：`这首歌适合现在放松一下。`
- 不显示假歌词，不固定高亮某一行。

### 4.6 音乐律动粒子效果

歌曲播放时粒子球使用专门的 `playing` 音乐律动效果。目标不是模拟说话嘴型，也不是随机抖动，而是表现“音乐正在通过灵粒流动”。

视觉方向：

- 粒子球保持球形主体，但在外层形成轻微的环形声波。
- 低频驱动整体半径轻微扩张，表现鼓点和节拍。
- 中高频驱动粒子颜色和局部波纹，表现旋律细节。
- 球体整体以稳定速度旋转，节拍强时产生一圈柔和光晕。
- 动效要柔和、艺术化，避免高频抖动和刺眼闪烁。

实现边界：

- `ParticleSphere` 继续接收 `state` 和 `audioLevel`，不破坏现有对话态接口。
- App 层从真实 `<audio>` 建立 Web Audio `AnalyserNode`。
- 音乐播放时传入真实频谱计算出的 `audioLevel`。
- 暂停时粒子从律动态回到低速呼吸态。
- 退出时断开音频分析节点，避免资源泄漏。

## 5. 技术设计

### 5.1 后端边界

新增或重构音乐 provider：

```text
GdStudioMusicProvider
```

职责：

- 接收搜索关键词。
- 按配置源顺序请求 GD Studio 搜索接口。
- 标准化搜索结果为项目内 `MusicTrack`。
- 对候选歌曲逐个请求播放 URL。
- 过滤空 URL。
- 请求封面 URL。
- 请求 LRC 歌词。
- 返回完整可播放曲目。

Provider 不负责真实音频播放。真实播放由前端 `<audio>` 控制。

### 5.2 前端边界

`useMusic` 职责调整：

- 调 `music.search` 和 `music.resolvePlayableTrack` 或直接调 `music.play` 获取可播放曲目。
- 保存当前 `PlaybackState`。
- 管理真实 `<audio>` 元素的播放、暂停、继续、停止。
- 监听 `loadedmetadata`、`timeupdate`、`ended`、`error`。
- 维护真实 `positionMs` 和 `durationMs`。

`MusicImmersiveView` 职责调整：

- 展示真实播放状态。
- 根据解析后的歌词和当前播放时间高亮当前歌词。
- 展示搜索框与音源选择。
- 提交搜索关键词并通知 `useMusic` 发起新播放请求。
- 显示专辑图或视觉兜底。
- 不再固定高亮第二行。

`ParticleSphere` 不改公共接口。音乐播放时进入专门的 `playing` 视觉配置，通过 App 层传入的真实音频分析值驱动律动。

### 5.3 搜索源模型

前端传入搜索源选择：

```ts
type MusicSourcePreference = 'all' | 'netease' | 'kuwo' | 'joox'
```

后端搜索策略：

- `all`：按 `netease -> kuwo -> joox` 搜索并合并候选。
- `netease`：只搜索 `netease`。
- `kuwo`：只搜索 `kuwo`。
- `joox`：只搜索 `joox`。

播放策略：

- `all` 模式下，某首歌 URL 为空时自动尝试下一首；当前源全部不可播放时尝试下一源。
- 单源模式下，某首歌 URL 为空时自动尝试同源下一首；该源全部不可播放时提示失败，不自动跨源。

### 5.4 数据类型调整

`MusicTrack` 需要支持：

```ts
type MusicTrack = {
  id: string
  source: 'netease' | 'kuwo' | 'joox'
  title: string
  artist: string
  album?: string
  artworkUrl?: string
  durationMs: number
  audioUrl: string
  lyrics?: LyricLine[]
  recommendation?: string
}

type LyricLine = {
  timeMs: number
  text: string
}
```

后端返回前必须确保 `audioUrl` 非空。

### 5.5 环境变量

移除 Apple Music 相关配置：

```env
APPLE_MUSIC_DEVELOPER_TOKEN
APPLE_MUSIC_STOREFRONT
```

新增 GD Studio 配置：

```env
MUSIC_PROVIDER=gdstudio
GD_MUSIC_API_BASE_URL=https://music-api.gdstudio.xyz/api.php
GD_MUSIC_DEFAULT_BR=320
GD_MUSIC_SEARCH_COUNT=5
GD_MUSIC_CACHE_TTL_MS=300000
```

### 5.6 缓存与限流

为降低 5 分钟 50 次请求限制风险：

- 搜索结果按 `source + keyword` 缓存 5 分钟。
- 播放 URL 按 `source + trackId + br` 缓存 5 分钟。
- 封面和歌词按 `source + id` 缓存 5 分钟。
- 单次播放请求最多尝试 15 个候选结果，避免无限请求。

## 6. 错误处理

| 场景 | 用户提示 | 行为 |
| --- | --- | --- |
| 搜索所有源为空 | 没有找到合适的音乐，我换个关键词再试试。 | 回到对话页 |
| 搜到但 URL 都为空 | 找到了歌曲，但暂时没有可播放链接。 | 回到对话页 |
| 单一音源无可播放结果 | 这个音源暂时没有可播放结果，可以切换全部音源再试。 | 保持音乐页 |
| 歌词为空 | 不提示错误，显示歌曲信息和推荐语 | 继续播放 |
| 封面为空 | 使用视觉兜底 | 继续播放 |
| 音频播放失败 | 这首歌暂时播放不了，我换一首再试试。 | 尝试下一个候选 |
| API 超时 | 音乐服务响应超时，请稍后再试。 | 回到对话页 |
| 触发频率限制 | 音乐服务请求太频繁，稍等一会儿再试。 | 回到对话页 |

## 7. Apple Music 移除范围

必须移除或替换：

- `createAppleMusicProvider`
- Apple Music provider tests
- Apple Music runtime state 文案
- Apple Music 环境变量示例
- `musicConfigured` 中 Apple Music token 判断
- “Apple Music 播放需要完成 MusicKit 用户授权”类错误提示

保留：

- 通用 `MusicProvider` 接口
- IPC 通道名称：`music.search`、`music.play`、`music.pause`、`music.resume`、`music.getPlaybackState`
- 前端音乐页与迷你播放器结构

## 8. 验收标准

### 8.1 功能验收

- 点击“播放音乐”后能进入音乐播放页并真实播放在线音频。
- AI 点歌后能按关键词搜索并播放。
- 音乐页支持手动搜索歌曲、歌手或专辑。
- 音乐页支持选择 `全部音源`、`netease`、`kuwo`、`joox`。
- 默认源顺序为 `netease -> kuwo -> joox`。
- 当 `netease` 无结果或不可播放时，能自动尝试 `kuwo` 和 `joox`。
- 当某首歌 URL 为空时，能自动尝试下一首。
- 专辑图片能展示；图片缺失或加载失败时显示视觉兜底。
- 有 LRC 时歌词按真实时间高亮。
- 无 LRC 时显示歌曲信息和推荐语，不显示假歌词。
- 暂停/继续控制真实音频。
- 返回按钮保留播放状态并显示迷你播放器。
- 退出按钮停止音频并清空迷你播放器。
- 音乐播放时粒子球使用专门的音乐律动效果，暂停后降低律动，退出后停止音频分析。
- Apple Music 相关配置、错误提示、测试不再出现。

### 8.2 技术验收

- 音乐 provider 单元测试覆盖搜索、播放 URL 解析、空 URL 降级、歌词解析、缓存。
- 前端 `useMusic` 测试覆盖真实播放状态机。
- 音乐搜索 UI 测试覆盖关键词提交和音源选择。
- LRC 解析测试覆盖时间戳解析、空行过滤、当前行计算。
- 音频分析逻辑测试覆盖播放、暂停、退出时资源连接和断开。
- `npm test` 通过。
- `npm run typecheck` 通过。
- `npm run build` 通过。
- 真实 Electron 窗口手动验证播放、暂停、继续、返回、退出。

## 9. 已确认事项

本规格已按用户确认固定以下决策：

- MVP 使用 GD Studio API。
- 默认源顺序：`netease -> kuwo -> joox`。
- 播放 URL 为空时自动尝试下一源/下一首。
- 歌词优先使用接口 LRC，没有歌词显示歌曲信息和 AI 推荐语。
- 彻底移除 Apple Music 相关逻辑。
- 音乐页增加透明玻璃质感搜索框和音源选择。
- 歌曲播放时粒子球需要专门的音乐律动效果。
- 接受该 API 仅用于 MVP 内测，不用于正式商业发布。
- 接受播放失败时自动换歌，而不是停在当前失败歌曲让用户手动处理。
