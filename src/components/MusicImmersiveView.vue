<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { MusicSourcePreference, MusicTrack, PlaybackState } from '@/types/app'
import { getCurrentLyricIndex } from '@/utils/musicLyrics'
import { groupMusicResults, musicSourceLabel } from '@/utils/musicSearchResults'
import type { MusicSearchProgress } from '../../electron/main/music/gdstudioMusicProvider'
import { ArrowLeft, ArrowUp, ChevronDown, Ellipsis, Heart, ListMusic, LoaderCircle, Music2, Plus, Search, X, Volume2 } from 'lucide-vue-next'

const props = defineProps<{
  volume?: number
  assistantSpeaking?: boolean
  temporary?: boolean
  notice?: string
  queue?: Array<{ entryId: string; track: MusicTrack }>
  queueVersion?: number
  activeTab: 'search' | 'favorite' | 'queue'
  favorites: MusicTrack[]
  playback: PlaybackState
  searchHistory: string[]
  searchQuery: string
  searchResults: MusicTrack[]
  searchResultsVisible: boolean
  searchBusy?: boolean
  searchSources?: MusicSearchProgress['sources']
  sourcePreference: MusicSourcePreference
}>()

const emit = defineEmits<{
  volumeChange: [value: number]
  seek: [positionSec: number]
  addQueue: [track: MusicTrack, version: number, confirmed: boolean]
  removeQueue: [entryId: string, version: number, confirmed: boolean]
  moveQueue: [entryId: string, version: number, confirmed: boolean]
  feedback: [track: MusicTrack, kind: 'skip' | 'dislike', confirmed: boolean]
  back: []
  changeTab: [tab: 'search' | 'favorite' | 'queue']
  clearHistory: []
  exit: []
  nextTrack: []
  playAllFavorites: [confirmed: boolean]
  previousTrack: []
  removeHistory: [query: string]
  search: [query: string, sourcePreference: MusicSourcePreference, refresh?: boolean]
  selectFavorite: [track: MusicTrack]
  selectHistory: [query: string]
  selectSearchResult: [track: MusicTrack]
  sourceChange: [sourcePreference: MusicSourcePreference]
  toggleFavorite: [track: MusicTrack, confirmed: boolean]
  togglePlayback: []
}>()

const LYRIC_CONTEXT_BEFORE = 8
const LYRIC_CONTEXT_AFTER = 8
const TITLE_PREVIEW_LENGTH = 5

const sourceOptions: Array<{ label: string; value: MusicSourcePreference }> = [
  { label: '全部', value: 'all' },
  { label: '网易云', value: 'netease' },
  { label: '酷我', value: 'kuwo' },
  { label: 'JOOX', value: 'joox' }
]
const resultGroups = computed(() => groupMusicResults(props.searchResults, props.searchQuery))
const expandedGroups = ref(new Set<string>())
watch(() => [props.searchQuery, props.sourcePreference], () => { expandedGroups.value = new Set() })
function toggleVersions(key: string): void {
  const next = new Set(expandedGroups.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  expandedGroups.value = next
}
const sourceFailures = computed(() => (props.searchSources ?? []).filter(source => source.status === 'unavailable').map(source => musicSourceLabel(source.source)))
const searchStatus = computed(() => {
  if (props.searchBusy) return resultGroups.value.length ? '继续查找其他音源，已有结果可播放' : '正在搜索各音源…'
  if (sourceFailures.value.length && props.searchResults.length) return `${sourceFailures.value.join('、')}暂不可用，已显示其他音源结果`
  return '搜索结果不代表音频可用，播放时会检查资源'
})
function sourceStatus(source: MusicSourcePreference): string | undefined {
  return props.searchSources?.find(value => value.source === source)?.status
}

const searchInput = ref(props.searchQuery)
const libraryOpen = ref(false)
const failedArtworks = ref(new Set<string>())
function markArtworkFailed(url: string | undefined): void { if (url) failedArtworks.value.add(url) }
const feedbackOpen = ref(false)
const pendingSave = ref<{ description: string; run(): void } | null>(null), confirmationDialog = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null
function persistentAction(description: string, run: (confirmed: boolean) => void): void {
  if (!props.temporary) { run(false); return }
  restoreFocus = document.activeElement as HTMLElement | null
  pendingSave.value = { description, run: () => run(true) }
}
watch(() => props.playback.status, status => { if (status === 'playing') libraryOpen.value = false })
watch(pendingSave, async (value, previous) => {
  if (value) { await nextTick(); confirmationDialog.value?.querySelector<HTMLButtonElement>('button')?.focus() }
  else if (previous) restoreFocus?.focus()
})
function confirmSave(): void { const pending = pendingSave.value; pendingSave.value = null; pending?.run() }
function trapConfirmation(event: KeyboardEvent): void {
  const buttons = confirmationDialog.value?.querySelectorAll<HTMLButtonElement>('button')
  if (!buttons?.length) return
  if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus() }
  else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus() }
}
function addQueue(track: MusicTrack): void { const version = props.queueVersion ?? 0; persistentAction(`将「${track.title}」加入播放队列，结束临时对话后仍保留。`, confirmed => emit('addQueue', track, version, confirmed)) }
function moveQueue(entryId: string): void { const version = props.queueVersion ?? 0; persistentAction('调整播放队列顺序，结束临时对话后仍保留。', confirmed => emit('moveQueue', entryId, version, confirmed)) }
function removeQueue(entryId: string): void { const version = props.queueVersion ?? 0; persistentAction('从播放队列移除这首歌，当前歌曲继续播放。', confirmed => emit('removeQueue', entryId, version, confirmed)) }
function sendFeedback(kind: 'skip' | 'dislike'): void {
  const track = props.playback.track; if (!track) return
  feedbackOpen.value = false
  if (kind === 'skip' && props.temporary) { emit('nextTrack'); return }
  persistentAction(kind === 'skip' ? `记下这次跳过「${track.title}」，不把它永久拉黑。` : `保存对「${track.title}」的不喜欢反馈，并跳过这首。`, confirmed => emit('feedback', track, kind, confirmed))
}

function showLibrary(tab: 'search' | 'favorite' | 'queue'): void {
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
    !props.searchBusy && !props.searchResultsVisible &&
    props.searchHistory.length > 0
  )
})

function getTrackKey(track: MusicTrack): string {
  return `${track.source ?? 'unknown'}:${track.id}`
}

function isTrackFavorite(track: MusicTrack): boolean {
  return props.favorites.some((item) => getTrackKey(item) === getTrackKey(track))
}
function trackAvailability(track: MusicTrack): string {
  return props.playback.track && getTrackKey(track) === getTrackKey(props.playback.track) ? statusLabel.value : ''
}

const isCurrentFavorite = computed(() => {
  const track = props.playback.track

  return track ? isTrackFavorite(track) : false
})

function onToggleFavorite(track: MusicTrack): void {
  persistentAction(`${isTrackFavorite(track) ? '取消' : '保存'}「${track.title}」的收藏，结束临时对话后仍保留。`, confirmed => emit('toggleFavorite', track, confirmed))
}

function onSelectFavorite(track: MusicTrack): void {
  libraryOpen.value = false
  emit('selectFavorite', track)
}
function playAllFavorites(): void {
  persistentAction('用收藏列表更新播放队列并开始播放，队列在临时对话结束后仍保留。', confirmed => { libraryOpen.value = false; emit('playAllFavorites', confirmed) })
}

function onToggleCurrentFavorite(): void {
  const track = props.playback.track

  if (track) {
    onToggleFavorite(track)
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

function submitSearch(refresh = false): void {
  const query = searchInput.value.trim()

  if (!query) {
    return
  }

  emit('search', query, props.sourcePreference, refresh)
}

function submitDefaultSearch(): void {
  if (!searchInput.value.trim()) return
  libraryOpen.value = true
  submitSearch()
}

function selectSource(sourcePreference: MusicSourcePreference): void {
  if (sourcePreference === props.sourcePreference) return
  emit('sourceChange', sourcePreference)
  if (searchInput.value.trim()) emit('search', searchInput.value.trim(), sourcePreference)
}

function selectSearchResult(track: MusicTrack): void {
  libraryOpen.value = false
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
        <button type="button" aria-label="播放队列" title="播放队列" @click="showLibrary('queue')"><ListMusic :size="17" /></button>
        <button v-if="playback.track" type="button" class="r1-music-exit" @click="$emit('exit')">退出播放</button>
      </div>
    </header>
      <form
        v-if="libraryOpen"
        class="search-glass"
        :data-results="searchResultsVisible"
        aria-label="歌曲搜索"
        @submit.prevent="submitSearch()"
        @keydown.esc.prevent="libraryOpen = false"
      >
        <div class="r1-music-library-head"><span>{{ activeTab === 'search' ? '寻找音乐' : activeTab === 'queue' ? '播放队列' : '我喜欢的' }}</span><button type="button" aria-label="关闭音乐资料库" @click="libraryOpen = false"><X :size="17" /></button></div>
        <div class="music-tabs">
          <button
            type="button"
            class="music-tab"
            :data-active="activeTab === 'search'"
            @click="emit('changeTab', 'search')"
          >
            发现
          </button>
          <button type="button" class="music-tab" :data-active="activeTab === 'queue'" @click="emit('changeTab', 'queue')">队列 <span class="tab-count">{{ queue?.length ?? 0 }}</span></button>
          <button
            type="button"
            class="music-tab"
            :data-active="activeTab === 'favorite'"
            @click="emit('changeTab', 'favorite')"
          >
            收藏 <span class="tab-count">{{ favorites.length }}</span>
          </button>
        </div>

        <div v-if="activeTab === 'search'" class="music-library-content music-search-content">
          <div class="search-row">
            <input
              v-model="searchInput"
              class="search-field"
              placeholder="搜索歌曲、歌手或专辑"
              aria-label="搜索歌曲、歌手或专辑"
            />
            <button class="search-button" type="submit" :disabled="searchBusy && searchInput.trim() === searchQuery" aria-label="搜索歌曲"><LoaderCircle v-if="searchBusy" :size="17" class="music-search-spinner" /><Search v-else :size="17" /></button>
          </div>
          <p v-if="notice && activeTab === 'search'" class="r1-music-notice r1-music-search-error" role="status">
            {{ notice }}<button type="button" class="music-retry" @click="submitSearch(true)">重试搜索</button>
          </p>
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
              :data-active="sourcePreference === source.value" :data-status="sourceStatus(source.value)" :aria-pressed="sourcePreference === source.value"
              type="button"
              @click="selectSource(source.value)"
            >
              {{ source.label }}<span v-if="sourceStatus(source.value) === 'searching'" class="music-source-pending" aria-label="搜索中" />
            </button>
          </div>
          <div v-if="searchResultsVisible" class="music-results-summary" role="status" aria-live="polite">
            <strong v-if="resultGroups.length">{{ resultGroups.length }} 首歌曲 <span>· {{ searchResults.length }} 条音源结果</span></strong>
            <p :class="{ 'is-searching': searchBusy }">{{ searchStatus }}</p>
          </div>
          <div v-if="searchResultsVisible" class="search-result-list music-group-list" aria-label="搜索结果" :aria-busy="searchBusy">
            <article v-for="group in resultGroups" :key="group.key" class="music-result-group">
              <div class="music-track-row">
                <button type="button" class="r1-track-select" :aria-label="`播放${group.primary.title}，${group.primary.artist}，${musicSourceLabel(group.primary.source)}`" @click="selectSearchResult(group.primary)">
                  <img v-if="group.primary.artworkUrl && !failedArtworks.has(group.primary.artworkUrl)" @error="markArtworkFailed(group.primary.artworkUrl)" class="search-result-thumb search-result-thumb--image" :src="group.primary.artworkUrl" alt="" />
                  <span v-else class="search-result-thumb music-track-placeholder" aria-hidden="true"><Music2 :size="19" /></span>
                  <span class="search-result-copy">
                    <span class="search-result-title" :title="group.primary.title">{{ group.primary.title }}</span>
                    <span class="search-result-meta" :title="[group.primary.artist, group.primary.album].filter(Boolean).join(' · ')">{{ [group.primary.artist, group.primary.album].filter(Boolean).join(' · ') }}</span>
                    <span class="music-track-source">{{ musicSourceLabel(group.primary.source) }}<span v-if="trackAvailability(group.primary)" class="music-track-playing"> · {{ trackAvailability(group.primary) }}</span></span>
                  </span>
                </button>
                <div class="music-track-actions">
                  <button type="button" class="favorite-toggle" :aria-label="`加入队列${group.primary.title}`" title="加入队列" @click="addQueue(group.primary)"><Plus :size="16" /></button>
                  <button type="button" class="favorite-toggle" :data-favorited="isTrackFavorite(group.primary)" :aria-label="`${isTrackFavorite(group.primary) ? '取消收藏' : '收藏'}${group.primary.title}`" title="收藏" @click="onToggleFavorite(group.primary)"><Heart :size="16" :fill="isTrackFavorite(group.primary) ? 'currentColor' : 'none'" /></button>
                </div>
              </div>
              <button v-if="group.versions.length > 1" type="button" class="music-versions-toggle" :aria-expanded="expandedGroups.has(group.key)" @click="toggleVersions(group.key)">{{ group.versions.length }} 个音源版本 <ChevronDown :size="13" :class="{ rotated: expandedGroups.has(group.key) }" /></button>
              <div v-if="expandedGroups.has(group.key)" class="music-track-versions">
                <div v-for="track in group.versions" :key="getTrackKey(track)" class="music-track-version">
                  <button type="button" class="music-version-play" @click="selectSearchResult(track)"><span>{{ musicSourceLabel(track.source) }}</span><small>{{ track.album || track.title }}</small></button>
                  <button type="button" class="favorite-toggle" :aria-label="`加入队列${track.title} ${musicSourceLabel(track.source)}`" @click="addQueue(track)"><Plus :size="14" /></button>
                  <button type="button" class="favorite-toggle" :data-favorited="isTrackFavorite(track)" :aria-label="`${isTrackFavorite(track) ? '取消收藏' : '收藏'}${track.title} ${musicSourceLabel(track.source)}`" @click="onToggleFavorite(track)"><Heart :size="14" :fill="isTrackFavorite(track) ? 'currentColor' : 'none'" /></button>
                </div>
              </div>
            </article>
            <div v-if="searchBusy && !resultGroups.length" class="music-search-skeleton" aria-hidden="true"><span v-for="index in 4" :key="index"><i /><b /></span></div>
            <p v-if="!searchBusy && searchResults.length === 0 && !notice" class="search-empty">没有找到匹配歌曲，试试歌名或歌手。</p>
          </div>
        </div>

        <div v-else-if="activeTab === 'queue'" class="result-list music-library-content" aria-label="播放队列">
          <article v-for="(entry, index) in queue ?? []" :key="entry.entryId" class="search-result-item r1-queue-row">
            <button type="button" class="r1-track-title" @click="selectSearchResult(entry.track)">{{ entry.track.title }}<small>{{ entry.track.artist }} · {{ entry.track.source }}</small></button>
            <button type="button" class="favorite-toggle" :disabled="index === 0" :aria-label="`上移${entry.track.title}`" @click="moveQueue(entry.entryId)"><ArrowUp :size="15" /></button>
            <button type="button" class="favorite-toggle" :aria-label="`从队列移除${entry.track.title}`" @click="removeQueue(entry.entryId)"><X :size="15" /></button>
          </article>
          <p v-if="!queue?.length" class="search-empty">后续队列为空。在发现或收藏中加入歌曲。</p>
        </div>
        <div v-else class="music-library-content">
          <div class="favorite-header">
            <span class="history-label">我喜欢的 · {{ favorites.length }} 首</span>
            <button
              v-if="favorites.length"
              type="button"
              class="history-chip"
              @click="playAllFavorites"
            >
              播放全部
            </button>
          </div>
          <div class="result-list" aria-label="收藏列表">
            <article
              v-for="track in favorites"
              :key="`${track.source ?? 'unknown'}-${track.id}`"
              class="search-result-item"
            >
              <button type="button" class="r1-track-select" @click="onSelectFavorite(track)">
              <img
                v-if="track.artworkUrl && !failedArtworks.has(track.artworkUrl)"
                @error="markArtworkFailed(track.artworkUrl)"
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
                <span class="music-track-source">{{ musicSourceLabel(track.source) }}</span>
              </span>
              </button>
              <button type="button" class="favorite-toggle" :aria-label="`加入队列${track.title}`" @click="addQueue(track)"><Plus :size="15" /></button>
              <button type="button"
                class="favorite-toggle"
                data-favorited="true"
                aria-label="移除收藏"
                @click.stop="onToggleFavorite(track)"
              >♥</button>
            </article>
            <p v-if="favorites.length === 0" class="search-empty">还没有收藏的歌曲，去搜索添加吧</p>
          </div>
        </div>
        <p v-if="notice && activeTab !== 'search'" class="r1-music-notice" role="status">{{ notice }}</p>
      </form>

    <section v-if="playback.track" class="music-layout music-layout-v10" aria-label="音乐播放">
      <div class="cover-frame">
        <img
          v-if="playback.track.artworkUrl && !failedArtworks.has(playback.track.artworkUrl)"
          @error="markArtworkFailed(playback.track.artworkUrl)"
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
          <input class="progress-track r1-music-progress" type="range" min="0" :max="(playback.durationMs ?? 0) / 1000" step="0.1" :value="playback.positionMs / 1000"
            :disabled="!playback.durationMs || playback.status === 'loading'" aria-label="歌曲进度" :style="{ '--progress': `${progress}%` }" @change="emit('seek', Number(($event.target as HTMLInputElement).value))" />
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
          <div class="feedback-control">
            <button class="favorite-toggle" type="button" aria-label="歌曲反馈" :aria-expanded="feedbackOpen" @click="feedbackOpen = !feedbackOpen"><Ellipsis :size="18" /></button>
            <div v-if="feedbackOpen" class="feedback-menu" @keydown.esc.prevent="feedbackOpen = false"><button type="button" @click="sendFeedback('skip')">这次跳过</button><button type="button" @click="sendFeedback('dislike')">以后少推荐这类</button></div>
          </div>
          <span class="source-note">
            {{ playback.status === 'loading' ? '正在寻找可播放版本' : playback.status === 'playing' ? '旋律流动中' : playback.status === 'error' ? '播放未完成' : '已暂停' }}
          </span>
          <label class="r1-music-volume"><Volume2 :size="16" /><input type="range" min="0" max="100"
            aria-label="音乐音量" :value="volume ?? 100"
            @input="emit('volumeChange', Number(($event.target as HTMLInputElement).value))" /></label>
        </div>
        <p v-if="notice && activeTab !== 'search'" class="r1-music-notice" role="status">{{ notice }}</p>
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
        <form v-if="!playback.track" class="r1-music-default-search" @submit.prevent="submitDefaultSearch">
          <input v-model="searchInput" class="search-field" placeholder="搜索歌曲、歌手或专辑" aria-label="搜索歌曲、歌手或专辑" />
          <button class="search-button" type="submit" :disabled="searchBusy && searchInput.trim() === searchQuery" aria-label="搜索歌曲"><LoaderCircle v-if="searchBusy" :size="17" class="music-search-spinner" /><Search v-else :size="17" /></button>
        </form>
      </div>
      <aside class="r1-music-empty-lyric" aria-label="歌词状态">
        <h3>{{ playback.status === 'loading' ? '正在寻找可播放版本' : '把时间，留给一首歌。' }}</h3>
        <p>{{ playback.status === 'error' ? '你可以打开搜索，更换歌曲或音源。' : '选好音乐后，歌词会在这里跟随真实播放时间出现。' }}</p>
      </aside>
    </section>
    <div v-if="pendingSave" class="r1-music-confirm-backdrop" @click.self="pendingSave = null">
      <section ref="confirmationDialog" class="r1-music-confirm" role="alertdialog" aria-modal="true" aria-label="确认保留音乐操作" @keydown.tab="trapConfirmation" @keydown.esc.prevent="pendingSave = null">
        <h3>保留这项音乐操作？</h3><p>{{ pendingSave.description }}</p><button type="button" @click="pendingSave = null">取消</button><button type="button" @click="confirmSave">确认保留</button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.r1-track-select{display:grid;grid-template-columns:42px minmax(0,1fr);align-items:center;gap:11px;width:100%;min-width:0;padding:0;border:0;background:none;text-align:left;color:inherit;font:inherit;cursor:pointer}
.search-result-item{grid-template-columns:minmax(0,1fr) 30px 30px;gap:8px;border-radius:8px}.r1-track-select .search-result-copy{min-width:0}.r1-track-select .search-result-thumb{width:42px;height:42px;flex:none;border-radius:6px}
.music-result-group{min-width:0;border:1px solid var(--r1-line);border-radius:8px;background:#ffffff03;overflow:hidden}.music-result-group:hover{border-color:#a1d9cf3b;background:#a1d9cf07}.music-track-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;min-height:82px;padding:12px}.music-track-actions{display:flex;gap:4px}.music-track-actions .favorite-toggle,.music-track-version .favorite-toggle{width:28px;height:28px;border:0;background:transparent}.music-track-actions .favorite-toggle:hover,.music-track-version .favorite-toggle:hover{color:var(--r1-aqua);background:#a1d9cf12}.music-track-placeholder{display:grid;place-items:center;background:#a1d9cf0b;color:#a1d9cf9c}.music-track-source{display:block;margin-top:4px;font-size:10px;line-height:1.4;color:#82978e;white-space:nowrap}.music-track-playing{color:var(--r1-gold)}
.music-versions-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;padding:7px 12px;border:0;border-top:1px solid var(--r1-line);background:#ffffff02;color:#92a39b;font:inherit;font-size:11px;cursor:pointer}.music-versions-toggle:hover{color:var(--r1-aqua)}.music-versions-toggle svg{transition:transform .15s}.music-versions-toggle .rotated{transform:rotate(180deg)}.music-track-versions{padding:2px 10px 8px;border-top:1px solid var(--r1-line)}.music-track-version{display:grid;grid-template-columns:minmax(0,1fr) 28px 28px;align-items:center;gap:4px;padding:5px 0}.music-version-play{display:flex;align-items:center;gap:9px;min-width:0;padding:6px 2px;border:0;background:none;color:#d5e0d8;font:inherit;text-align:left;cursor:pointer;font-size:11px}.music-version-play span{flex:none}.music-version-play small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7b8e84;font-size:10px}
.music-results-summary{margin:15px 0 10px}.music-results-summary strong{font-size:12px;font-weight:500;color:#d4dfd6}.music-results-summary strong span{color:#7f8e87;font-weight:400;font-size:11px}.music-results-summary p{margin:6px 0 0;color:#7f9188;font-size:10px;line-height:1.6}.music-results-summary .is-searching{color:var(--r1-aqua)}.music-group-list{gap:8px}.source-chip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.source-chip[data-status=unavailable]{color:#7e8580}.music-source-pending{width:4px;height:4px;border-radius:50%;background:var(--r1-aqua)}.music-search-spinner{animation:music-search-spin 1s linear infinite}.search-button{display:grid;place-items:center}.search-button:disabled{opacity:.55;cursor:default}.music-search-skeleton{display:grid;gap:8px}.music-search-skeleton>span{display:flex;align-items:center;gap:12px;height:82px;padding:12px;border:1px solid var(--r1-line);border-radius:8px}.music-search-skeleton i{width:42px;height:42px;border-radius:6px;background:#a1d9cf09}.music-search-skeleton b{width:55%;height:25px;border-top:6px solid #a1d9cf0b;border-bottom:4px solid #a1d9cf06}
@keyframes music-search-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.music-search-spinner{animation:none}}
.r1-track-title{flex:1;min-width:0;border:0;background:none;text-align:left;color:var(--r1-text);font-size:13px;cursor:pointer}.r1-track-title small{display:block;color:var(--r1-muted);font-size:11px;margin-top:5px}
.r1-music-progress{width:100%;appearance:none;background:linear-gradient(to right,var(--r1-gold,#e8cd8c) var(--progress),#2d3032 var(--progress));height:3px;margin:0;cursor:pointer}.r1-music-progress::-webkit-slider-thumb{appearance:none;width:8px;height:8px;border-radius:50%;background:var(--r1-gold,#e8cd8c)}
.feedback-control{position:relative}.feedback-menu{position:absolute;bottom:calc(100% + 8px);left:0;min-width:146px;background:#1a2222;border:1px solid #46534b;border-radius:5px;padding:4px;box-shadow:0 12px 28px #0008;z-index:12}.feedback-menu button{display:block;width:100%;text-align:left;padding:9px 8px;color:#c9d5ca;font-size:11px;border:0;background:none;cursor:pointer}.feedback-menu button:hover{background:#2a3933}
.r1-music-notice{font-size:12px;line-height:1.7;color:var(--r1-muted)}.r1-music-search-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.music-retry{background:none;border:1px solid var(--r1-line);border-radius:6px;color:var(--r1-aqua);font-size:12px;padding:3px 8px;cursor:pointer}.r1-music-confirm-backdrop{position:fixed;inset:0;background:#0009;z-index:100;display:grid;place-items:center}.r1-music-confirm{width:min(420px,90vw);padding:28px;background:var(--r1-surface,#101216);border:1px solid var(--r1-line);border-radius:8px}.r1-music-confirm h3{font-size:20px;color:var(--r1-text);font-weight:500}.r1-music-confirm p{font-size:13px;line-height:1.8;color:var(--r1-muted)}.r1-music-confirm button{margin:12px 20px 0 0;background:none;border:0;color:var(--r1-aqua);cursor:pointer}
.r1-music-volume{display:flex;align-items:center;gap:8px;margin-left:auto;color:var(--r1-muted)}
.r1-music-volume input{width:76px;height:3px;accent-color:var(--r1-aqua)}
.r1-music-default-search{display:flex;align-items:center;gap:8px;max-width:420px;margin:20px 0 0}.r1-music-default-search .search-field{flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid var(--r1-line);border-radius:6px;background:#ffffff06;color:var(--r1-text);font:inherit;font-size:12px;outline:0}.r1-music-default-search .search-field:focus-visible{outline:2px solid var(--r1-aqua);outline-offset:2px}.r1-music-default-search .search-button{height:38px;padding:0 13px;border:1px solid var(--r1-line);border-radius:6px;background:#1b2422;color:var(--r1-aqua);font:inherit;cursor:pointer}
.lyrics--speaking{opacity:.2;transition:opacity .2s ease}
</style>
