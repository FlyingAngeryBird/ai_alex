// Actual search receipts and M01 decisions; public synthetic request, isolated SQLite, no microphone/audio.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1TaskToolExecutor } from '../dist-electron/main/r1/taskToolExecutor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { currentCandidateContext } from '../dist-electron/main/r1/sessionMode.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
import { createDoubaoSearchProvider } from '../dist-electron/main/providers/doubaoSearchProvider.js'
const db=openR1Database(':memory:'),assets=loadR1PromptAssets(resolve('r1-assets')),conversations=new R1Conversations(db),items=new R1Items(db)
const sessionId=conversations.start(),tasks=new R1TaskSupervisor(db,assets,()=>0)
const persona={version:1,assistantName:'Seamo AI',userAddress:'',style:'自然简洁',voiceId:''}
let calls=[],receipts=[]
const provider=createArkResponsesProvider({timeoutMs:30000,fetch:async(url,init)=>{
 const request=JSON.parse(String(init.body))
 for(const value of request.input??[])if(value.type==='function_call_output')receipts.push(JSON.parse(value.output))
 const response=await fetch(url,init),body=await response.clone().json()
 calls.push(...(body.output??[]).filter(value=>value.type==='function_call').map(value=>({alias:value.name,args:JSON.parse(value.arguments)})))
 return response
}})
const driver=new R1ConversationDriver(db,assets,tasks,provider,()=>persona,['read_file','web_search'])
try{
 const seed=conversations.append({sessionId,turnId:randomUUID(),role:'user',body:'查找 RFC 9110 HTTP Semantics 官方标准。',status:'final'})
 const task=tasks.accept({requestKey:randomUUID(),sourceMessageId:seed.messageId,timezone:'Asia/Shanghai',goal:seed.body,constraints:[],authorizedAliases:['read_file','web_search'],complexity:'complex'})
 const active=tasks.claimNext(),executor=new R1TaskToolExecutor(tasks,assets,items,createDoubaoSearchProvider({resultLimit:3,timeoutMs:8000}))
 executor.execute(active.lease,'read_file',{file_path:'/skills/web-qa/SKILL.md'})
 const searched=await executor.executeAsync(active.lease,'web_search',{query:'RFC 9110 HTTP Semantics site:rfc-editor.org'},'actual-search')
 assert.equal(searched.status,'succeeded','SEARCH_NOT_SUCCEEDED')
 const web=tasks.get(task.taskId).webResult,candidate=web.candidates.find(candidate=>candidate.sourceRefs.some(ref=>web.sources.some(source=>source.sourceRef===ref&&new URL(source.url).hostname==='www.rfc-editor.org')))
 assert.ok(candidate,'OFFICIAL_CANDIDATE_MISSING')
 const mode={temporary:false,sessionId,selectedCandidate:{taskId:task.taskId,goalVersion:task.goalVersion,candidateId:candidate.candidateId,candidateVersion:tasks.candidateVersion(task.taskId,candidate.candidateId)}}
 const currentCandidate=currentCandidateContext(mode,tasks);assert.ok(currentCandidate)
 for(const phase of ['save_and_remind','repeat_save']){
  const source=conversations.append({sessionId,turnId:randomUUID(),role:'user',body:phase==='save_and_remind'?'把当前选中的官方标准结果原样记下来，明天上午九点提醒我阅读，提醒关联这条便签。':'把当前选中的结果再记下来，之前保存过的话沿用那条便签，不要再建提醒。',status:'final'})
  calls=[];receipts=[];const started=Date.now()
  const result=await driver.reply({scope:{source,temporary:false,timezone:'Asia/Shanghai',persistenceConfirmed:false,assertCurrent(){assert.deepEqual(currentCandidateContext(mode,tasks),currentCandidate)}},messages:[{role:'user',content:source.body}],context:{sessionId,sessionGeneration:1,turnId:source.turnId,currentTime:source.createdAt,timezone:'Asia/Shanghai',temporary:false,contextVersion:1,personaVersion:1,deletionEpoch:0,selectedEntity:driver.selectedEntity(mode),currentCandidate,availableToolAliases:[],loadedSkillIds:['SK01'],recentTurns:[],memories:[],topics:[],activeTasks:[]}})
  assert.equal(items.list().length,1,'DUPLICATED_OR_MISSING_ITEM')
  assert.equal(items.listReminders().length,1,'DUPLICATED_OR_MISSING_REMINDER')
  const item=items.list()[0],reminder=items.listReminders()[0]
  assert.equal(reminder.itemId,item.itemId,'REMINDER_WRONG_ITEM')
  const tomorrow=new Date(Date.parse(source.createdAt)+86400000+8*3600000).toISOString().slice(0,10)
  assert.equal(reminder.dueAtUtc,new Date(`${tomorrow}T09:00:00+08:00`).toISOString(),'REMINDER_WRONG_TIME')
  assert.deepEqual(items.toolView(item.itemId).sourceRefs,candidate.sourceRefs,'SOURCES_NOT_PRESERVED')
  assert.match(item.body,/rfc-editor.org/,'ACTUAL_SOURCE_CONTENT_MISSING')
  assert.ok(calls.some(value=>value.alias==='notes_create'&&value.args.candidateTarget?.candidateId===candidate.candidateId),'M01_DID_NOT_BIND_SELECTION')
  assert.ok(receipts.some(value=>value.tool==='notes.create'&&value.status==='succeeded'&&value.entityId===item.itemId),'ACTUAL_ITEM_RECEIPT_MISSING')
  if(phase==='save_and_remind')assert.ok(receipts.some(value=>value.tool==='reminders.create'&&value.status==='succeeded'),'ACTUAL_REMINDER_RECEIPT_MISSING')
  console.log(JSON.stringify({phase,status:'passed',reply:result.reply,calls:calls.map(value=>value.alias),itemId:item.itemId,reminderId:reminder.reminderId,candidateId:candidate.candidateId,sourceUrls:currentCandidate.sources.map(value=>value.url),elapsedMs:Date.now()-started,assetReleaseId:assets.releaseId,database:'isolated-in-memory',profileBusinessWrites:false,audioPlayed:false}))
 }
}catch(error){console.log(JSON.stringify({status:'failed',code:error.code??error.message,assertion:error.message,calls:process.env.SEAMO_CHECK_DIAGNOSTIC==='1'?calls:calls.map(value=>value.alias),receipts:receipts.map(value=>({tool:value.tool,status:value.status,errorCode:value.errorCode})),database:'isolated-in-memory',profileBusinessWrites:false}));process.exitCode=1}
finally{tasks.close();db.close()}
