// One real M01 lifecycle in isolated SQLite; synthetic Item only, no microphone/profile writes.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const db=openR1Database(':memory:'),assets=loadR1PromptAssets(resolve('r1-assets')),items=new R1Items(db),conversations=new R1Conversations(db)
const tasks=new R1TaskSupervisor(db,assets,()=>0),sessionId=conversations.start(),calls=[]
const seeded=items.create({actionId:randomUUID(),kind:'todo',title:'合成购物验收',body:'买茶和牛奶'}).item
const dueAtUtc=new Date(Date.now()+3600000).toISOString()
const dedicated=items.createReminder({actionId:randomUUID(),itemId:seeded.itemId,body:'合成购物到期',dueAtUtc,timezone:'Asia/Shanghai',linkPurpose:'todo_due'}).reminder
const independent=items.createReminder({actionId:randomUUID(),itemId:seeded.itemId,body:'独立合成提醒',dueAtUtc,timezone:'Asia/Shanghai',linkPurpose:'independent'}).reminder
const persona={version:1,assistantName:'Seamo AI',userAddress:'',style:'自然简洁',voiceId:''}
const provider=createArkResponsesProvider({timeoutMs:30000,fetch:async(url,init)=>{const r=await fetch(url,init),body=await r.clone().json();calls.push(...(body.output??[]).filter(v=>v.type==='function_call').map(v=>v.name));return r}})
const driver=new R1ConversationDriver(db,assets,tasks,provider,()=>persona,[])
try{
 for(const [phase,text,version,completed] of [
  ['edit','把“合成购物验收”这条待办的正文改成“买茶和燕麦奶”，标题保持不变。',2,false],
  ['complete','把“合成购物验收”这条待办标记为已完成。',3,true],
  ['undo','撤销“合成购物验收”这条待办的完成状态，重新变成未完成。',4,false]
 ]){
  calls.length=0;const source=conversations.append({sessionId,turnId:randomUUID(),role:'user',body:text,status:'final'}),started=Date.now()
  const result=await driver.reply({scope:{source,temporary:false,timezone:'Asia/Shanghai',persistenceConfirmed:false,assertCurrent(){}},messages:[{role:'user',content:text}],context:{sessionId,sessionGeneration:1,turnId:source.turnId,currentTime:source.createdAt,timezone:'Asia/Shanghai',temporary:false,contextVersion:1,personaVersion:1,deletionEpoch:0,selectedEntity:null,availableToolAliases:[],loadedSkillIds:['SK01'],recentTurns:[],memories:[],topics:[],activeTasks:[]}})
  const item=items.toolView(seeded.itemId);assert.equal(item.version,version);assert.equal(item.completed,completed);assert.equal(item.title,'合成购物验收');assert.equal(item.content,'买茶和燕麦奶');assert.equal(items.list().length,1);assert.equal(tasks.list().length,0)
  assert.ok(calls.includes(phase==='edit'?'notes_update':'notes_complete'),'MUTATION_TOOL_NOT_CALLED')
  const reminders=items.listReminders();assert.equal(reminders.find(v=>v.reminderId===dedicated.reminderId).status,completed?'cancelled':'scheduled');assert.equal(reminders.find(v=>v.reminderId===independent.reminderId).status,'scheduled')
  console.log(JSON.stringify({phase,status:'passed',reply:result.reply,calls:[...calls],itemId:item.itemId,version:item.version,completed:item.completed,dedicatedReminder:completed?'cancelled':'scheduled',independentReminder:'scheduled',elapsedMs:Date.now()-started,assetReleaseId:assets.releaseId,database:'isolated-in-memory',profileBusinessWrites:false,audioPlayed:false}))
 }
}catch(error){console.log(JSON.stringify({status:'failed',code:error.code??error.message,calls,profileBusinessWrites:false,database:'isolated-in-memory'}));process.exitCode=1}
finally{tasks.close();db.close()}
