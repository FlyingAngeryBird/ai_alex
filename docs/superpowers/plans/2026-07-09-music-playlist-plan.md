# 音乐歌单迭代技术方案

日期：2026-07-09
分支：feature/lingli-mvp
范围：收藏夹（单一）+ 搜索关键词历史 + tab 切换 + "听你想听"默认空状态。UI 见 [mockup](../mockups/music-playlist-tab.html)。

## 数据模型

独立 `userData/music.json`（不混入 config.json，音乐数据与配置分离），复用 configStore 模式：

```ts
type MusicLibrary = {
  favorites: MusicTrack[]   // 收藏列表，复用 MusicTrack（含 id/source/title/artist/album/artworkUrl/artworkId/playbackId/lyricId/durationMs）
  searchHistory: string[]   // 搜索关键词，上限 8
}
```

- 收藏去重 key：`${source}:${id}`（同 useMusic 的 `getTrackKey`）
- 搜索历史：去重 + 新的置顶 + `slice(0, 8)`，超 8 挤掉最旧

## 1. musicStore（新增 electron/main/music/musicStore.ts）

复用 [configStore](electron/main/config/configStore.ts) 模式：

- `loadLibrary()` / `getLibrary()`
- `toggleFavorite(track)`：存在则移除，不存在则添加（去重），返回最新 `favorites`
- `addSearchHistory(query)`：去重 + unshift + slice(0, 8)，返回最新 `searchHistory`
- `clearSearchHistory()`
- `initDefaultMusicStore(filePath)` / `getDefaultMusicStore()`（lazy 内存默认，便于测试）

[index.ts](electron/main/index.ts) `initDefaultConfigStore` 后 `initDefaultMusicStore`，`whenReady` 里 `loadLibrary`。

## 2. IPC 通道（新增 4 个，三处同步）

| 通道 | payload | 返回 |
|---|---|---|
| `music.getLibrary` | - | `{ favorites, searchHistory }` |
| `music.toggleFavorite` | `{ track: MusicTrack }` | `MusicTrack[]`（最新 favorites） |
| `music.addSearchHistory` | `{ query: string }` | `string[]`（最新 searchHistory） |
| `music.clearSearchHistory` | - | `string[]` |

[musicHandlers.ts](electron/main/ipc/musicHandlers.ts) 注册（注入 musicStore，便于测试）。三处同步：
1. [preload](electron/preload/index.ts) `exposedChannels`（在 `music.*` 区段，按字母序插）
2. [electron-api.d.ts](src/types/electron-api.d.ts) `LingliChannel`
3. [ipcContract.test.ts](tests/ipcContract.test.ts) 精确顺序断言

## 3. useMusic 改造

新增状态：
- `favorites = ref<MusicTrack[]>([])`
- `searchHistory = ref<string[]>([])`
- `activeTab = ref<'search' | 'favorite'>('search')`

新增方法：
- `loadLibrary()`：onMounted 调 `music.getLibrary`，填充 favorites/searchHistory
- `isFavorite(track)`：`favorites` 里按 trackKey 判断
- `toggleFavorite(track)`：调 `music.toggleFavorite` -> 更新 favorites
- `addSearchHistory(query)`：调 `music.addSearchHistory` -> 更新 searchHistory（`searchMusic` 成功后自动调）
- `removeSearchHistory(query)` / `clearSearchHistory()`：调 IPC -> 更新
- `playFavorite(track)`：复用 `playQueuedTrack` 逻辑（track 有 source/playbackId，走 trackId 路径）
- `playAllFavorites()`：`favorites[0]` 播放 + `playbackQueue = favorites.slice(1)`（顺序播放）
- `setActiveTab(tab)`：切换 tab

改造：
- `openImmersive()`：去掉 `if (playback.value.track)` 判断，**无条件 `viewMode = 'music'`**（无 track 时显示"听你想听"空状态）
- `searchMusic`：成功后 `addSearchHistory(query)`
- `nextTrack`：收藏播放全部时 queue 已是 favorites.slice(1)，无需改

## 4. MusicImmersiveView 改造

props 加：`favorites`、`searchHistory`、`activeTab`、`favoritePlayingId`（当前播放曲目 id，用于收藏列表高亮）
emits 加：`toggleFavorite`、`selectFavorite`、`playAllFavorites`、`clearHistory`、`removeHistory`、`selectHistory`、`changeTab`

模板：
- **music-tabs**（search-glass 顶部）：搜索 / 收藏（带计数），点击 `changeTab`
- **搜索 tab**（当前内容）：搜索框 + 搜索历史（`searchResults.length === 0 && searchHistory.length` 时显示，药丸 + ×）+ 音源 + 结果列表（每项右侧 `favorite-toggle` ♡/♥）
- **收藏 tab**：`favorites` 列表（复用 search-result-item，每项右侧 ♥ 移除）+ 头部"播放全部"按钮 + 空态"还没有收藏的歌曲"
- **播放页 control-row**：加 `favorite-toggle` ♥（当前曲目是否收藏）
- **空状态**：`!playback.track` 时显示"听你想听"（替代当前"正在寻找 / 给这一刻挑一首歌"）

样式（style.css 新增，参数复用 mockup）：
- `.music-tabs` / `.music-tab`（复用 source-chip 药丸语言，active 黄边）
- `.favorite-toggle`（圆形 30px，♡ 灰 / ♥ 黄）
- `.search-history` / `.history-chip`（药丸 + ×，hover 青边）
- `.compact-status-row` 同款居中（如需）

## 5. App.vue 改造

- `requestMusicPlayback`：`music.playRequest('适合此刻的音乐', 'all')` -> **`music.openImmersive()`**（进沉浸式不播放，显示"听你想听"）
- onMounted：`music.loadLibrary()`（加载收藏 + 历史）
- MusicImmersiveView 绑定新 props/emits（favorites/searchHistory/activeTab/toggleFavorite/selectFavorite/playAllFavorites/clearHistory/removeHistory/selectHistory/changeTab）

## 6. 测试点

**musicStore.test.ts**（新增）：
- loadLibrary 默认值 + 盘上数据合并
- toggleFavorite：添加 / 再次 toggle 移除 / 去重（同 source:id）
- addSearchHistory：去重 / 置顶 / 上限 8（第 9 条挤掉最旧）
- clearSearchHistory

**musicIpc.test.ts**（增补）：
- 4 个新 handler：fake ipc + fake musicStore，校验返回 + payload 校验失败码

**ipcContract.test.ts**：新增 4 通道顺序断言

**useMusic**（如需）：favorites 状态 / toggleFavorite / playAllFavorites 队列。现有 useMusic 测试在 uiState.test.ts，可能需补。

**回归**：现有音乐播放/搜索/下一首/歌词/粒子球不受影响。

## 7. 开发顺序

1. musicStore + musicStore.test.ts
2. musicHandlers 4 通道 + 三处同步 + musicIpc.test.ts 增补 + ipcContract.test.ts
3. useMusic 改造（favorites/searchHistory/activeTab/loadLibrary/toggleFavorite/playAllFavorites/openImmersive 无条件）
4. MusicImmersiveView 改造（tab/收藏/历史/空状态）+ style.css 新样式
5. App.vue requestMusic -> openImmersive + loadLibrary + props/emits 绑定
6. 联调 + 全量测试（typecheck + vitest + build）

## 不在本次范围

- 多歌单（单一收藏夹）
- 搜索结果持久（只记关键词）
- 收藏列表拖拽排序
- 云端同步
