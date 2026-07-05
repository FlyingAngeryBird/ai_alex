<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MusicSourcePreference, MusicTrack, PlaybackState } from '@/types/app'
import { getCurrentLyricIndex } from '@/utils/musicLyrics'

const props = defineProps<{
  playback: PlaybackState
  searchQuery: string
  searchResults: MusicTrack[]
  searchResultsVisible: boolean
  sourcePreference: MusicSourcePreference
}>()

const emit = defineEmits<{
  back: []
  exit: []
  nextTrack: []
  previousTrack: []
  search: [query: string, sourcePreference: MusicSourcePreference]
  selectSearchResult: [track: MusicTrack]
  sourceChange: [sourcePreference: MusicSourcePreference]
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
    return 'Loading'
  }

  if (props.playback.status === 'error') {
    return 'Error'
  }

  return props.playback.status === 'playing' ? 'Playing' : 'Paused'
})

const emptyTitle = computed(() => {
  return props.playback.status === 'error' ? '没有播放成功' : '正在寻找'
})

const emptySubtitle = computed(() => {
  return props.playback.status === 'error'
    ? props.playback.errorMessage ?? '没有找到可播放的音乐，请换个关键词或音源再试试。'
    : '给这一刻挑一首合适的歌'
})

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
        <button class="round-button" type="button" aria-label="返回聊天" @click="$emit('back')">
          ←
        </button>
        <div class="status-pill"><span class="status-dot" />{{ statusLabel }}</div>
        <button class="exit-button" type="button" @click="$emit('exit')">退出</button>
      </div>

      <form
        class="search-glass"
        :data-results="searchResultsVisible"
        aria-label="歌曲搜索"
        @submit.prevent="submitSearch"
      >
        <div class="search-row">
          <input
            v-model="searchInput"
            class="search-field"
            placeholder="搜索歌曲、歌手或专辑"
            aria-label="搜索歌曲、歌手或专辑"
          />
          <button class="search-button" type="submit" aria-label="搜索歌曲">⌕</button>
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
          </button>
          <p v-if="searchResults.length === 0" class="search-empty">没有找到匹配歌曲</p>
        </div>
      </form>
    </header>

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
        <span class="cover-label">{{ playback.track.album || playback.track.source || 'lingmo' }}</span>
      </div>

      <section class="music-copy" aria-label="当前歌曲">
        <p class="eyebrow">
          {{ playback.track.source ? `GD Studio · ${playback.track.source}` : 'GD Studio' }}
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
          <span class="source-note">
            {{ playback.status === 'loading' ? '正在寻找可播放版本' : '旋律流动中' }}
          </span>
        </div>
      </section>

      <aside class="lyrics" aria-label="同步歌词">
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
      :aria-label="playback.status === 'error' ? '音乐播放失败' : '音乐加载中'"
    >
      <div class="music-copy">
        <p class="eyebrow">GD Studio</p>
        <h2>{{ emptyTitle }}</h2>
        <p class="artist">{{ emptySubtitle }}</p>
      </div>
    </section>
  </section>
</template>
