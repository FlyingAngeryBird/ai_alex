<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
const props=defineProps<{ busy:boolean; error:string; nativeConfigured:boolean; textConfigured:boolean }>()
const emit=defineEmits<{ complete:[target:'home'|'settings'|'services'] }>()
const dialog=ref<HTMLElement|null>(null)
const previous=document.activeElement as HTMLElement|null
function keys(event:KeyboardEvent){
 if(event.key==='Escape'&&!props.busy){emit('complete','home');return}
 if(event.key!=='Tab')return
 const buttons=[...dialog.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],first=buttons[0],last=buttons.at(-1)
 if(!first){event.preventDefault();return}
 if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.value)){event.preventDefault();last?.focus()}
 else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.value)){event.preventDefault();first.focus()}
}
onMounted(()=>dialog.value?.focus())
onBeforeUnmount(()=>previous?.isConnected&&previous.focus())
</script>
<template>
 <Teleport to="body"><div class="r1-memory-modal-backdrop" style="position:fixed;z-index:100" @keydown.stop="keys">
  <section ref="dialog" class="r1-memory-modal r1-welcome-dialog" role="dialog" aria-modal="true" aria-labelledby="r1-welcome-title" tabindex="-1">
   <small>SEAMO / FIRST MEETING</small><h2 id="r1-welcome-title">从一句话开始认识彼此</h2>
   <p>可以先设置称呼和声音，也可以直接进入空间，稍后再设置。</p>
   <p>自动会话需要你主动开启才收音；按住说话使用独立语音识别配置。自动记忆默认关闭，跳过引导不会开启它们。</p>
   <dl><div><dt>实时语音</dt><dd>{{nativeConfigured?'已填写，连接可在设置中检测':'待配置密钥与音色'}}</dd></div><div><dt>文字与后台任务</dt><dd>{{textConfigured?'已填写，连接可在设置中检测':'待配置对话模型'}}</dd></div></dl>
   <p>普通对话保存在本机；临时对话不写长期历史、也不读取长期记忆。设备、安静模式与数据管理都在设置中。</p>
   <p v-if="error" role="alert">{{error}}</p>
   <div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="emit('complete','settings')">设置称呼与声音</button><button type="button" :disabled="busy" @click="emit('complete','services')">配置服务与设备</button><button type="button" :disabled="busy" @click="emit('complete','home')">暂时跳过，进入空间</button></div>
  </section>
 </div></Teleport>
</template>
<style scoped>.r1-welcome-dialog{max-height:calc(100vh - 40px);overflow:auto}.r1-welcome-dialog:focus-visible{outline:2px solid var(--r1-aqua);outline-offset:3px}.r1-welcome-dialog small{font-size:10px;letter-spacing:2px;color:var(--r1-aqua)}h2{font-size:22px;font-weight:400}p{font-size:13px;line-height:1.8}dl{margin:20px 0}dl div{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--r1-line);font-size:12px}dd{margin:0;color:var(--r1-aqua)}.r1-memory-dialog-actions{flex-wrap:wrap}</style>
