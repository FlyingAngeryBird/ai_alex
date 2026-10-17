<script setup lang="ts">
import { computed } from 'vue'
import type { TaskCompletionNotice } from '../composables/useTasks'

const props = defineProps<{ notice: TaskCompletionNotice; count: number }>()
defineEmits<{ view: []; dismiss: [] }>()
const heading = computed(() => ({
  completed: '委托已完成', partial: '委托已有部分结果',
  needs_input: '委托需要你补充条件', failed: '委托未能完成'
})[props.notice.completionStatus])
</script>

<template>
  <aside class="r1-reminder-toast r1-task-completion-notice" role="status" aria-label="委托结果提示">
    <div>
      <strong>{{ heading }}</strong>
      <p class="r1-task-notice-copy">{{ notice.brief }}</p>
      <small v-if="count > 1">还有 {{ count - 1 }} 项结果待查看</small>
    </div>
    <button type="button" @click="$emit('view')">查看结果</button>
    <button type="button" @click="$emit('dismiss')">关闭</button>
  </aside>
</template>
