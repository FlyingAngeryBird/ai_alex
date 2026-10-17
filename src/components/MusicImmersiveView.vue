<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { MusicSourcePreference, MusicTrack, PlaybackState } from '@/types/app'
import { getCurrentLyricIndex } from '@/utils/musicLyrics'
import { ArrowLeft, ArrowUp, Ellipsis, Heart, ListMusic, Plus, Search, X, Volume2 } from 'lucide-vue-next'

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
  search: [query: string, sourcePreference: MusicSourcePreference]
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
  { label: 'netease', value: 'netease' },
  { label: 'kuwo', value: 'kuwo' },
  { label: 'joox', value: 'joox' }
]

const searchInput = ref(props.searchQuery)
const libraryOpen = ref(!props.playback.track)
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
function trackAvailability(track: MusicTrack): string {
  return props.playback.track && getTrackKey(track) === getTrackKey(props.playback.track) ? statusLabel.value : '待播放验证'
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
        @submit.prevent="submitSearch"
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
            <article
              v-for="track in searchResults"
              :key="`${track.source ?? 'unknown'}-${track.id}`"
              class="search-result-item"
            >
              <button type="button" class="r1-track-select" @click="selectSearchResult(track)">
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
              </span>
              <span class="search-result-source">{{ track.source ?? 'GD' }} · {{ trackAvailability(track) }}</span>
              </button>
              <button type="button" class="favorite-toggle" :aria-label="`加入队列${track.title}`" @click="addQueue(track)"><Plus :size="15" /></button>
              <button type="button"
                class="favorite-toggle"
                :data-favorited="isTrackFavorite(track)"
                :aria-label="isTrackFavorite(track) ? '取消收藏' : '收藏'"
                @click.stop="onToggleFavorite(track)"
              >{{ isTrackFavorite(track) ? '♥' : '♡' }}</button>
            </article>
            <p v-if="searchResults.length === 0 && !notice" class="search-empty">没有找到匹配歌曲</p>
          </div>
        </div>

        <div v-else-if="activeTab === 'queue'" class="result-list" aria-label="播放队列">
          <article v-for="(entry, index) in queue ?? []" :key="entry.entryId" class="search-result-item r1-queue-row">
            <button type="button" class="r1-track-title" @click="selectSearchResult(entry.track)">{{ entry.track.title }}<small>{{ entry.track.artist }} · {{ entry.track.source }}</small></button>
            <button type="button" class="favorite-toggle" :disabled="index === 0" :aria-label="`上移${entry.track.title}`" @click="moveQueue(entry.entryId)"><ArrowUp :size="15" /></button>
            <button type="button" class="favorite-toggle" :aria-label="`从队列移除${entry.track.title}`" @click="removeQueue(entry.entryId)"><X :size="15" /></button>
          </article>
          <p v-if="!queue?.length" class="search-empty">后续队列为空。在发现或收藏中加入歌曲。</p>
        </div>
        <div v-else>
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
              </span>
              <span class="search-result-source">{{ track.source ?? 'GD' }}</span>
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
        <p v-if="notice" class="r1-music-notice" role="status">{{ notice }}</p>
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
        <p v-if="notice" class="r1-music-notice" role="status">{{ notice }}</p>
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
    <div v-if="pendingSave" class="r1-music-confirm-backdrop" @click.self="pendingSave = null">
      <section ref="confirmationDialog" class="r1-music-confirm" role="alertdialog" aria-modal="true" aria-label="确认保留音乐操作" @keydown.tab="trapConfirmation" @keydown.esc.prevent="pendingSave = null">
        <h3>保留这项音乐操作？</h3><p>{{ pendingSave.description }}</p><button type="button" @click="pendingSave = null">取消</button><button type="button" @click="confirmSave">确认保留</button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.r1-track-select{display:flex;align-items:center;gap:12px;flex:1;min-width:0;border:0;background:none;text-align:left;color:inherit;cursor:pointer}
.r1-track-title{flex:1;min-width:0;border:0;background:none;text-align:left;color:var(--r1-text);font-size:13px;cursor:pointer}.r1-track-title small{display:block;color:var(--r1-muted);font-size:11px;margin-top:5px}
.r1-music-progress{width:100%;appearance:none;background:linear-gradient(to right,var(--r1-gold,#e8cd8c) var(--progress),#2d3032 var(--progress));height:3px;margin:0;cursor:pointer}.r1-music-progress::-webkit-slider-thumb{appearance:none;width:8px;height:8px;border-radius:50%;background:var(--r1-gold,#e8cd8c)}
.feedback-control{position:relative}.feedback-menu{position:absolute;bottom:calc(100% + 8px);left:0;min-width:146px;background:#1a2222;border:1px solid #46534b;border-radius:5px;padding:4px;box-shadow:0 12px 28px #0008;z-index:12}.feedback-menu button{display:block;width:100%;text-align:left;padding:9px 8px;color:#c9d5ca;font-size:11px;border:0;background:none;cursor:pointer}.feedback-menu button:hover{background:#2a3933}
.r1-music-notice{font-size:12px;line-height:1.7;color:var(--r1-muted)}.r1-music-confirm-backdrop{position:fixed;inset:0;background:#0009;z-index:100;display:grid;place-items:center}.r1-music-confirm{width:min(420px,90vw);padding:28px;background:var(--r1-surface,#101216);border:1px solid var(--r1-line);border-radius:8px}.r1-music-confirm h3{font-size:20px;color:var(--r1-text);font-weight:500}.r1-music-confirm p{font-size:13px;line-height:1.8;color:var(--r1-muted)}.r1-music-confirm button{margin:12px 20px 0 0;background:none;border:0;color:var(--r1-aqua);cursor:pointer}
.r1-music-volume{display:flex;align-items:center;gap:8px;margin-left:auto;color:var(--r1-muted)}
.r1-music-volume input{width:76px;height:3px;accent-color:var(--r1-aqua)}
.lyrics--speaking{opacity:.2;transition:opacity .2s ease}
</style>
