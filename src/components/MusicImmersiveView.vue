<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MusicSourcePreference, MusicTrack, PlaybackState } from '@/types/app'
import { getCurrentLyricIndex } from '@/utils/musicLyrics'
import { ArrowLeft, Heart, Search, X, Volume2 } from 'lucide-vue-next'

const props = defineProps<{
  volume?: number
  assistantSpeaking?: boolean
  activeTab: 'search' | 'favorite'
  favorites: MusicTrack[]
  playback: PlaybackState
  searchHistory: string[]
  searchQuery: string
  searchResults: MusicTrack[]
  searchResultsVisible: boolean
  sourcePreference: MusicSourcePreference
}>()

const emit = defineEmits<{
  volumeChange: [value: number]
  back: []
  changeTab: [tab: 'search' | 'favorite']
  clearHistory: []
  exit: []
  nextTrack: []
  playAllFavorites: []
  previousTrack: []
  removeHistory: [query: string]
  search: [query: string, sourcePreference: MusicSourcePreference]
  selectFavorite: [track: MusicTrack]
  selectHistory: [query: string]
  selectSearchResult: [track: MusicTrack]
  sourceChange: [sourcePreference: MusicSourcePreference]
  toggleFavorite: [track: MusicTrack]
  togglePlayback: []
}>()

const LYRIC_CONTEXT_BEFORE = 8
const LYRIC_CONTEXT_AFTER = 8
const TITLE_PREVIEW_LENGTH = 5

const sourceOptions: Array<{ label: string; value: MusicSourcePreference }> = [
  { label: '全部', value: 'all' },
  { label: 'netease', value: 'netease' },
  { label: 'kuwo', value: 'kuwo' },
  { label: 'joox', value: 'joox' }
]

const searchInput = ref(props.searchQuery)
const libraryOpen = ref(false)

function showLibrary(tab: 'search' | 'favorite'): void {
  emit('changeTab', tab)
  libraryOpen.value = true
}

const progress = computed(() => {
  if (!props.playback.durationMs) {
    return 0
  }

  return Math.min(100, (props.playback.positionMs / props.playback.durationMs) * 100)
})

const currentLyricIndex = computed(() => {
  return getCurrentLyricIndex(props.playback.track?.lyrics, props.playback.positionMs)
})

const visibleLyrics = computed(() => {
  return props.playback.track?.lyrics?.length ? props.playback.track.lyrics : []
})

const displayedLyrics = computed(() => {
  const lyrics = visibleLyrics.value

  if (lyrics.length === 0) {
    return []
  }

  const currentIndex = Math.max(0, currentLyricIndex.value)
  const targetSize = LYRIC_CONTEXT_BEFORE + LYRIC_CONTEXT_AFTER + 1
  let start = Math.max(0, currentIndex - LYRIC_CONTEXT_BEFORE)
  let end = Math.min(lyrics.length, start + targetSize)
  start = Math.max(0, end - targetSize)

  return lyrics.slice(start, end).map((line, offset) => {
    const sourceIndex = start + offset

    return {
      line,
      distance: sourceIndex - currentIndex,
      position:
        sourceIndex === currentIndex
          ? 'current'
          : sourceIndex < currentIndex
            ? 'previous'
            : 'next',
      sourceIndex
    }
  })
})

const fallbackLines = computed(() => {
  const track = props.playback.track

  if (!track) {
    return ['正在寻找适合此刻的音乐。']
  }

  return [
    track.recommendation ?? '这首歌适合现在放松一下。',
    [track.title, track.artist, track.album].filter(Boolean).join(' · ')
  ]
})

const statusLabel = computed(() => {
  if (props.playback.status === 'loading') {
    return '正在缓冲'
  }

  if (props.playback.status === 'error') {
    return '播放失败'
  }

  return props.playback.status === 'playing' ? '正在播放' : '已暂停'
})

const emptyTitle = computed(() => {
  if (props.playback.status === 'error') {
    return '没有播放成功'
  }

  if (props.playback.status === 'loading') {
    return '正在寻找'
  }

  return '听你想听'
})

const emptySubtitle = computed(() => {
  if (props.playback.status === 'error') {
    return props.playback.errorMessage ?? '没有找到可播放的音乐，请换个关键词或音源再试试。'
  }

  if (props.playback.status === 'loading') {
    return '给这一刻挑一首合适的歌'
  }

  return ''
})

const showSearchHistory = computed(() => {
  return (
    props.activeTab === 'search' &&
    props.searchResults.length === 0 &&
    props.searchHistory.length > 0
  )
})

function getTrackKey(track: MusicTrack): string {
  return `${track.source ?? 'unknown'}:${track.id}`
}

function isTrackFavorite(track: MusicTrack): boolean {
  return props.favorites.some((item) => getTrackKey(item) === getTrackKey(track))
}

const isCurrentFavorite = computed(() => {
  const track = props.playback.track

  return track ? isTrackFavorite(track) : false
})

function onToggleFavorite(track: MusicTrack): void {
  emit('toggleFavorite', track)
}

function onSelectFavorite(track: MusicTrack): void {
  emit('selectFavorite', track)
}

function onToggleCurrentFavorite(): void {
  const track = props.playback.track

  if (track) {
    emit('toggleFavorite', track)
  }
}

const displayTrackTitle = computed(() => {
  const title = props.playback.track?.title ?? ''
  const chars = Array.from(title)

  return chars.length > TITLE_PREVIEW_LENGTH
    ? `${chars.slice(0, TITLE_PREVIEW_LENGTH).join('')}...`
    : title
})

const isTrackTitleTruncated = computed(() => {
  return Array.from(props.playback.track?.title ?? '').length > TITLE_PREVIEW_LENGTH
})

watch(
  () => props.searchQuery,
  (nextQuery) => {
    searchInput.value = nextQuery
  }
)

function formatTime(ms: number | null): string {
  if (!ms) {
    return '0:00'
  }

  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function submitSearch(): void {
  const query = searchInput.value.trim()

  if (!query) {
    return
  }

  emit('search', query, props.sourcePreference)
}

function selectSource(sourcePreference: MusicSourcePreference): void {
  emit('sourceChange', sourcePreference)
}

function selectSearchResult(track: MusicTrack): void {
  emit('selectSearchResult', track)
}

function lyricStyle(distance: number): Record<string, string> {
  return {
    '--lyric-distance': distance.toString()
  }
}
</script>

<template>
  <section class="music-view" aria-label="音乐沉浸页">
    <header class="music-topbar">
      <div class="top-left">
        <button class="r1-music-back" type="button" aria-label="返回对话" @click="$emit('back')"><ArrowLeft :size="17" />返回对话</button>
        <div class="r1-music-mode"><span class="status-dot" />{{ playback.track ? statusLabel : '音乐陪伴' }}</div>
      </div>
      <div class="r1-music-tools">
        <button type="button" aria-label="搜索音乐" title="搜索音乐" @click="showLibrary('search')"><Search :size="17" /></button>
        <button type="button" aria-label="收藏音乐" title="收藏音乐" @click="showLibrary('favorite')"><Heart :size="17" /></button>
        <button v-if="playback.track" type="button" class="r1-music-exit" @click="$emit('exit')">退出播放</button>
      </div>
    </header>
      <form
        v-if="libraryOpen"
        class="search-glass"
        :data-results="searchResultsVisible"
        aria-label="歌曲搜索"
        @submit.prevent="submitSearch"
      >
        <div class="r1-music-library-head"><span>{{ activeTab === 'search' ? '寻找音乐' : '我喜欢的' }}</span><button type="button" aria-label="关闭音乐资料库" @click="libraryOpen = false"><X :size="17" /></button></div>
        <div class="music-tabs">
          <button
            type="button"
            class="music-tab"
            :data-active="activeTab === 'search'"
            @click="emit('changeTab', 'search')"
          >
            搜索
          </button>
          <button
            type="button"
            class="music-tab"
            :data-active="activeTab === 'favorite'"
            @click="emit('changeTab', 'favorite')"
          >
            收藏 <span class="tab-count">{{ favorites.length }}</span>
          </button>
        </div>

        <div v-if="activeTab === 'search'">
          <div class="search-row">
            <input
              v-model="searchInput"
              class="search-field"
              placeholder="搜索歌曲、歌手或专辑"
              aria-label="搜索歌曲、歌手或专辑"
            />
            <button class="search-button" type="submit" aria-label="搜索歌曲">⌕</button>
          </div>
          <div v-if="showSearchHistory" class="search-history">
            <span class="history-label">最近搜索</span>
            <button
              v-for="query in searchHistory"
              :key="query"
              type="button"
              class="history-chip"
              @click="emit('selectHistory', query)"
            >
              {{ query }} <span class="x" @click.stop="emit('removeHistory', query)">×</span>
            </button>
          </div>
          <div class="source-row" aria-label="音源选择">
            <button
              v-for="source in sourceOptions"
              :key="source.value"
              class="source-chip"
              :data-active="sourcePreference === source.value"
              type="button"
              @click="selectSource(source.value)"
            >
              {{ source.label }}
            </button>
          </div>
          <div v-if="searchResultsVisible" class="search-result-list" aria-label="搜索结果">
            <button
              v-for="track in searchResults"
              :key="`${track.source ?? 'unknown'}-${track.id}`"
              class="search-result-item"
              type="button"
              @click="selectSearchResult(track)"
            >
              <img
                v-if="track.artworkUrl"
                class="search-result-thumb search-result-thumb--image"
                :src="track.artworkUrl"
                alt=""
                aria-hidden="true"
              />
              <span v-else class="search-result-thumb" aria-hidden="true" />
              <span class="search-result-copy">
                <span class="search-result-title">{{ track.title }}</span>
                <span class="search-result-meta">
                  {{ [track.artist, track.album].filter(Boolean).join(' · ') || '未知歌手' }}
                </span>
              </span>
              <span class="search-result-source">{{ track.source ?? 'GD' }}</span>
              <span
                class="favorite-toggle"
                :data-favorited="isTrackFavorite(track)"
                :aria-label="isTrackFavorite(track) ? '取消收藏' : '收藏'"
                @click.stop="onToggleFavorite(track)"
              >{{ isTrackFavorite(track) ? '♥' : '♡' }}</span>
            </button>
            <p v-if="searchResults.length === 0" class="search-empty">没有找到匹配歌曲</p>
          </div>
        </div>

        <div v-else>
          <div class="favorite-header">
            <span class="history-label">我喜欢的 · {{ favorites.length }} 首</span>
            <button
              v-if="favorites.length"
              type="button"
              class="history-chip"
              @click="emit('playAllFavorites')"
            >
              播放全部
            </button>
          </div>
          <div class="result-list" aria-label="收藏列表">
            <button
              v-for="track in favorites"
              :key="`${track.source ?? 'unknown'}-${track.id}`"
              class="search-result-item"
              type="button"
              @click="onSelectFavorite(track)"
            >
              <img
                v-if="track.artworkUrl"
                class="search-result-thumb search-result-thumb--image"
                :src="track.artworkUrl"
                alt=""
                aria-hidden="true"
              />
              <span v-else class="search-result-thumb" aria-hidden="true" />
              <span class="search-result-copy">
                <span class="search-result-title">{{ track.title }}</span>
                <span class="search-result-meta">
                  {{ [track.artist, track.album].filter(Boolean).join(' · ') || '未知歌手' }}
                </span>
              </span>
              <span class="search-result-source">{{ track.source ?? 'GD' }}</span>
              <span
                class="favorite-toggle"
                data-favorited="true"
                aria-label="移除收藏"
                @click.stop="onToggleFavorite(track)"
              >♥</span>
            </button>
            <p v-if="favorites.length === 0" class="search-empty">还没有收藏的歌曲，去搜索添加吧</p>
          </div>
        </div>
      </form>

    <section v-if="playback.track" class="music-layout music-layout-v10" aria-label="音乐播放">
      <div class="cover-frame">
        <img
          v-if="playback.track.artworkUrl"
          class="cover-art cover-art--image"
          :src="playback.track.artworkUrl"
          alt=""
          aria-hidden="true"
        />
        <div v-else class="cover-art" aria-hidden="true" />
        <span class="cover-label">{{ playback.track.album || playback.track.source || 'Seamo AI' }}</span>
      </div>

      <section class="music-copy" aria-label="当前歌曲">
        <p class="eyebrow">
          {{ playback.track.source ? `SEAMO SESSIONS · ${playback.track.source}` : 'SEAMO SESSIONS' }}
        </p>
        <div class="track-head">
          <h2
            class="track-title"
            :data-full-title="playback.track.title"
            :data-truncated="isTrackTitleTruncated"
            :title="playback.track.title"
          >
            {{ displayTrackTitle }}
          </h2>
          <p class="artist">{{ playback.track.artist }}</p>
        </div>

        <div class="progress-block">
          <div class="progress-track" aria-hidden="true">
            <span :style="{ width: `${progress}%` }" />
          </div>
          <div class="time-row">
            <span>{{ formatTime(playback.positionMs) }}</span>
            <span>{{ formatTime(playback.durationMs) }}</span>
          </div>
        </div>

        <div class="control-row">
          <button
            class="icon-play-button track-skip-button"
            type="button"
            aria-label="上一首"
            @click="$emit('previousTrack')"
          >
            ‹
          </button>
          <button
            class="icon-play-button"
            type="button"
            :aria-label="playback.status === 'playing' ? '暂停' : '继续播放'"
            @click="$emit('togglePlayback')"
          >
            <span v-if="playback.status === 'playing'" class="pause-bars" aria-hidden="true">
              <span />
              <span />
            </span>
            <span v-else aria-hidden="true">▶</span>
          </button>
          <button
            class="icon-play-button track-skip-button"
            type="button"
            aria-label="下一首"
            @click="$emit('nextTrack')"
          >
            ›
          </button>
          <button
            class="favorite-toggle"
            type="button"
            :data-favorited="isCurrentFavorite"
            :aria-label="isCurrentFavorite ? '取消收藏' : '收藏'"
            @click="onToggleCurrentFavorite"
          >{{ isCurrentFavorite ? '♥' : '♡' }}</button>
          <span class="source-note">
            {{ playback.status === 'loading' ? '正在寻找可播放版本' : '旋律流动中' }}
          </span>
          <label class="r1-music-volume"><Volume2 :size="16" /><input type="range" min="0" max="100"
            aria-label="音乐音量" :value="volume ?? 100"
            @input="emit('volumeChange', Number(($event.target as HTMLInputElement).value))" /></label>
        </div>
      </section>

      <aside class="lyrics" :class="{ 'lyrics--speaking': assistantSpeaking }" aria-label="同步歌词">
        <TransitionGroup
          v-if="displayedLyrics.length"
          name="lyric-drift"
          tag="div"
          class="lyric-stack"
        >
          <p
            v-for="item in displayedLyrics"
            :key="`${item.line.timeMs}-${item.line.text}`"
            :data-current="item.position === 'current'"
            :data-distance="item.distance"
            :data-position="item.position"
            :style="lyricStyle(item.distance)"
            class="lyric-line"
          >
            {{ item.line.text }}
          </p>
        </TransitionGroup>
        <div v-else class="lyric-stack lyric-stack--fallback">
          <p
            v-for="line in fallbackLines"
            :key="line"
            class="lyric-line"
          >
            {{ line }}
          </p>
        </div>
      </aside>
    </section>

    <section
      v-else
      class="music-layout music-layout--loading"
      :data-error="playback.status === 'error'"
      :aria-label="playback.status === 'error' ? '音乐播放失败' : playback.status === 'loading' ? '音乐加载中' : '尚未播放音乐'"
    >
      <div class="music-copy">
        <p class="eyebrow">SEAMO SESSIONS</p>
        <h2>{{ emptyTitle }}</h2>
        <p v-if="emptySubtitle" class="artist">{{ emptySubtitle }}</p>
      </div>
      <aside class="r1-music-empty-lyric" aria-label="歌词状态">
        <h3>{{ playback.status === 'loading' ? '正在寻找可播放版本' : '把时间，留给一首歌。' }}</h3>
        <p>{{ playback.status === 'error' ? '你可以打开搜索，更换歌曲或音源。' : '选好音乐后，歌词会在这里跟随真实播放时间出现。' }}</p>
      </aside>
    </section>
  </section>
</template>

<style scoped>
.r1-music-volume{display:flex;align-items:center;gap:8px;margin-left:auto;color:var(--r1-muted)}
.r1-music-volume input{width:76px;height:3px;accent-color:var(--r1-aqua)}
.lyrics--speaking{opacity:.2;transition:opacity .2s ease}
</style>
