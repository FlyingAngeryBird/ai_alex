// Real M01 read-only queries against domain-seeded synthetic Topics. No UI/audio acceptance claim.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
import { R1MemoryPolicy } from '../dist-electron/main/r1/memoryPolicy.js'
import { R1Topics } from '../dist-electron/main/r1/topics.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const db=openR1Database(':memory:'),conversations=new R1Conversations(db),memory=new R1MemoryStore(db),topics=new R1Topics(db)
const assets=loadR1PromptAssets(resolve('r1-assets')),policy=new R1MemoryPolicy(db)
policy.update({enabled:true,expectedVersion:1})
const seedSession=conversations.start(),user=conversations.append({sessionId:seedSession,turnId:randomUUID(),role:'user',body:'桌面版开发：先做中文macOS内部桌面版，移动版暂不做，发布日期未定。',status:'final'})
let topic=topics.commitSummary({result:{summary:user.body,sourceTurnIds:[user.turnId],memoryIds:[],taskFacts:[],topic:{topicId:null,expectedVersion:null,title:'桌面版开发',unresolved:['发布日期未定'],status:'active'}},sources:[user],existingTopics:[],authorizationVersion:2,deletionEpoch:0,assertCurrent(){}})
assert.ok(topic)
conversations.end(seedSession)
let observations=[],calls=[]
const provider=createArkResponsesProvider({timeoutMs:30000,fetch:async(url,init)=>{
 const input=JSON.parse(String(init.body)).input??[]
 for(const value of input.filter(item=>item.type==='function_call_output')){const data=JSON.parse(value.output);observations.push(data)}
 const response=await fetch(url,init),body=await response.clone().json()
 calls.push(...(body.output??[]).filter(item=>item.type==='function_call').map(item=>item.name))
 return response
}})
const tasks=new R1TaskSupervisor(db,assets,()=>memory.currentDeletionEpoch()),persona={version:1,assistantName:'Seamo AI',userAddress:'',style:'自然、简洁',voiceId:''}
const driver=new R1ConversationDriver(db,assets,tasks,provider,()=>persona,[])
try{
 for(const phase of ['original','corrected','forgotten']){
  if(phase==='corrected')topic=topics.update({topicId:topic.topicId,expectedVersion:topic.version,title:topic.title,summary:'桌面版开发已改为先完成Windows内部试用，移动版暂不做。发布日期仍未定。',unresolved:['发布日期未定'],status:'active'})
  if(phase==='forgotten')topics.forget({topicId:topic.topicId,expectedVersion:topic.version})
  const sessionId=conversations.start(),source=conversations.append({sessionId,turnId:randomUUID(),role:'user',body:'我们之前桌面版开发的结论是什么？简短告诉我平台和未解决事项。',status:'final'})
  observations=[];calls=[];const started=Date.now(),epoch=memory.currentDeletionEpoch()
  const result=await driver.reply({scope:{source,timezone:'Asia/Shanghai',temporary:false,persistenceConfirmed:false,assertCurrent(){assert.equal(memory.currentDeletionEpoch(),epoch)}},messages:[{role:'user',content:source.body}],context:{sessionId,sessionGeneration:1,turnId:source.turnId,currentTime:source.createdAt,timezone:'Asia/Shanghai',temporary:false,contextVersion:epoch+1,personaVersion:1,deletionEpoch:epoch,selectedEntity:null,availableToolAliases:[],loadedSkillIds:['SK01'],recentTurns:[],memories:[],topics:[],activeTasks:[]}})
  const seen=observations.flatMap(value=>value.data?.topics??[]),expected=seen.find(value=>value.topicId===topic.topicId&&value.version===topic.version)
  if(phase==='forgotten'){
   assert.equal(seen.length,0,'FORGOTTEN_TOPIC_RETURNED')
   assert.ok(observations.some(value=>value.data?.matchStatus==='no_match'),'NO_ACTUAL_NEGATIVE_READ')
   assert.doesNotMatch(result.reply,/Windows|macOS/i,'FORGOTTEN_PLATFORM_REAPPEARED')
  }else{
   assert.ok(expected,'CURRENT_TOPIC_NOT_READ')
   assert.match(result.reply,phase==='original'?/macOS/i:/Windows/i,'CURRENT_PLATFORM_NOT_ANSWERED')
   assert.match(result.reply,/未定|待定|没.*定|未.*确定/,'UNRESOLVED_DATE_LOST')
   if(phase==='corrected')assert.doesNotMatch(result.reply,/macOS/i,'OLD_PLATFORM_REAPPEARED')
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory').get().n,0,'TOPIC_CONVERTED_TO_MEMORY')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n,0,'UNREQUESTED_ITEM')
  assert.equal(tasks.list().length,0,'UNREQUESTED_TASK')
  console.log(JSON.stringify({phase,status:'passed',reply:result.reply,calls,observedTopicVersions:seen.map(value=>value.version),elapsedMs:Date.now()-started,assetReleaseId:assets.releaseId,scope:'real_M01_unselected_topic_recall_after_domain_correction_or_forgetting',database:'isolated-in-memory',profileBusinessWrites:false,audioPlayed:false}))
  conversations.end(sessionId)
 }
}catch(error){console.log(JSON.stringify({status:'failed',code:error.code??error.message,calls,observedTopicVersions:observations.flatMap(value=>value.data?.topics??[]).map(value=>value.version),database:'isolated-in-memory'}));process.exitCode=1}
finally{tasks.close();db.close()}
