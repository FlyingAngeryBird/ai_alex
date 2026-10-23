<script setup>
import {
  ArrowLeft, ArrowRight, ArrowUp, AudioLines, Bell, Bookmark, Brain,
  Check, CheckCheck, ChevronDown, ChevronRight, CircleCheck, Clock3, Copy,
  Download, FileText, Globe, Headphones, Heart, History, ListMusic, LoaderCircle,
  MessageCircle, Mic, MicOff, Minus, Monitor, MoreHorizontal, NotebookPen,
  Pause, Pencil, Play, Plus, RotateCcw, Search, Settings2, ShieldCheck,
  SkipBack, SkipForward, Sparkles, Square, Timer, Trash2, Volume2, X
} from 'lucide-vue-next'

defineProps({ name: String, size: { type: Number, default: 19 } })
const icons = {
  ArrowLeft, ArrowRight, ArrowUp, AudioLines, Bell, Bookmark, Brain,
  Check, CheckCheck, ChevronDown, ChevronRight, CircleCheck, Clock3, Copy,
  Download, FileText, Globe, Headphones, Heart, History, ListMusic, LoaderCircle,
  MessageCircle, Mic, MicOff, Minus, Monitor, MoreHorizontal, NotebookPen,
  Pause, Pencil, Play, Plus, RotateCcw, Search, Settings2, ShieldCheck,
  SkipBack, SkipForward, Sparkles, Square, Timer, Trash2, Volume2, X
}
</script>

<template>
  <component :is="icons[name] || MessageCircle" :size="size" :stroke-width="1.6" aria-hidden="true" />
</template>
