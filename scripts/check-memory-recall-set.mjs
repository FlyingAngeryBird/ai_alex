// Frozen synthetic retrieval set; real M01 and tools after an actual SQLite close/reopen.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..')
const imp=p=>import(`${root}/dist-electron/main/${p}`)
const {openR1Database}=await imp('r1/database.js'),{R1Conversations}=await imp('r1/conversations.js'),{R1MemoryStore}=await imp('r1/memory.js')
const {R1TaskSupervisor}=await imp('r1/taskSupervisor.js'),{R1ConversationDriver}=await imp('r1/conversationDriver.js')
const {loadR1PromptAssets}=await imp('r1/promptAssets.js'),{createArkResponsesProvider}=await imp('providers/arkResponsesProvider.js')
const cases=[
 ['M01','preference','用户喜欢无糖绿茶。','我的茶通常要不要加糖？','无糖|不.*加糖'],
 ['M02','profile','用户每周六上午练习吉他。','吉他练习安排在一周中的什么时候？','周六.*上午|星期六.*上午'],
 ['M03','profile','用户家里养的猫叫团子。','我家毛孩子叫什么名字？','团子'],
 ['M04','preference','用户看电影更喜欢科幻片。','看电影时我偏爱哪类题材？','科幻'],
 ['M05','conclusion','提案项目先支持macOS桌面版。','提案项目优先支持哪个平台？','macOS|Mac'],
 ['M06','ongoing','红豆项目定于2026年11月2日内部评审。','红豆项目什么时候内部过一遍？','11.*2|十一.*二'],
 ['M07','preference','用户工作日午休时不接受主动语音播报。','上班日中午我对主动播报有什么要求？','不.*播|不要|关闭|静默|勿扰'],
 ['M08','preference','用户写作时喜欢先列提纲再写正文。','我组织文章时通常按什么顺序？','提纲.*正文'],
 ['M09','preference','用户喜欢步行通勤。','平时上班路上我偏好哪种出行方式？','步行|走路'],
 ['M10','profile','用户用蓝色笔记本记录想法。','记录灵感我用什么颜色的本子？','蓝'],
 ['M11','preference','用户喜欢温热的水，不加冰。','喝水时我对温度有什么偏好？','温热|温水|热水'],
 ['M12','conclusion','新项目先邀请三位同事内部试用。','新项目先邀请多少人试用？','三|3'],
 ['M13','conclusion','预算比较等收到正式报价后再继续。','预算比较下一步要等什么？','正式报价'],
 ['M14','ongoing','蓝鲸项目尚未决定是否开启移动端。','蓝鲸项目关于手机端做决定了吗？','未.*决定|还没.*决定|尚未'],
 ['M15','preference','用户整理文字常用Markdown格式。','整理文字时我通常用哪种标记格式？','Markdown'],
 ['M16','preference','用户不喜欢香菜。','点菜时有哪些配料我希望避开？','香菜'],
 ['M17','preference','用户专注时通常每段25分钟。','我的专注段一般持续多长？','25|二十五'],
 ['M18','preference','用户晚间喜欢轻柔的纯音乐。','晚上我适合听哪类音乐？','纯音乐'],
 ['M19','profile','用户每周日傍晚整理下周待办。','一周的待办一般什么时候梳理？','周日.*傍晚|星期日.*傍晚'],
 ['M20','profile','用户希望被称呼为小海。','平时应该怎么称呼我？','小海']
]
const datasetSha256=createHash('sha256').update(JSON.stringify(cases)).digest('hex')
const dir=mkdtempSync(join(tmpdir(),'seamo-memory-recall-')),path=join(dir,'test.sqlite'),assets=loadR1PromptAssets(join(root,'r1-assets'))
let db=openR1Database(path),conversations=new R1Conversations(db),store=new R1MemoryStore(db)
const seedSession=conversations.start(),ids=new Map()
for(const [id,category,fact] of cases){const source=conversations.append({sessionId:seedSession,turnId:randomUUID(),role:'user',body:`请记住，${fact}`,status:'final'});ids.set(id,store.remember({content:fact,category,sourceMessageIds:[source.messageId]}).memoryId)}
conversations.end(seedSession);db.close()
db=openR1Database(path);conversations=new R1Conversations(db);store=new R1MemoryStore(db)
const tasks=new R1TaskSupervisor(db,assets,()=>store.currentDeletionEpoch()),persona={version:1,assistantName:'Seamo AI',userAddress:'',style:'自然、简洁',voiceId:''}
let observed=new Set(),calls=[]
const provider=createArkResponsesProvider({timeoutMs:30000,fetch:async(url,init)=>{
 const input=JSON.parse(String(init.body)).input??[]
 for(const item of input.filter(i=>i.type==='function_call_output')){
  const out=JSON.parse(item.output)
  for(const memory of out.data?.memories??[])observed.add(memory.memoryId)
 }
 const response=await fetch(url,init),data=await response.clone().json()
 for(const call of (data.output??[]).filter(i=>i.type==='function_call'))calls.push({name:call.name,args:JSON.parse(call.arguments)})
 return response
}})
const driver=new R1ConversationDriver(db,assets,tasks,provider,()=>persona,[]),results=[]
try{
 const limit=Number(process.env.SEAMO_MEMORY_CASE_LIMIT||20)
 console.log(JSON.stringify({scope:'recall_evaluation_config',datasetSha256,assetReleaseId:assets.releaseId,modelProfile:'configured_ark',historyUsed:false}))
 for(const [id,,fact,question,pattern] of cases.slice(0,limit)){
  observed=new Set();calls=[];const sessionId=conversations.start(),source=conversations.append({sessionId,turnId:randomUUID(),role:'user',body:question,status:'final'}),started=Date.now()
  try{
   const result=await driver.reply({scope:{source,timezone:'Asia/Shanghai',temporary:false,persistenceConfirmed:false,assertCurrent(){}},messages:[{role:'user',content:question}],context:{sessionId,sessionGeneration:1,turnId:source.turnId,currentTime:source.createdAt,timezone:'Asia/Shanghai',temporary:false,contextVersion:1,personaVersion:1,deletionEpoch:0,selectedEntity:null,availableToolAliases:[],loadedSkillIds:['SK01'],recentTurns:[],memories:[],activeTasks:[]}})
   const actualSourceRead=observed.has(ids.get(id)),answerMatches=new RegExp(pattern,'i').test(result.reply),passed=actualSourceRead&&answerMatches
   const row={id,status:passed?'passed':'failed',question,expectedFact:fact,reply:result.reply,actualSourceRead,answerMatches,calls,elapsedMs:Date.now()-started};results.push(row);console.log(JSON.stringify(row))
  }catch(error){const row={id,status:'failed',code:error.code??error.message,calls,elapsedMs:Date.now()-started};results.push(row);console.log(JSON.stringify(row))}
  conversations.end(sessionId)
 }
 console.log(JSON.stringify({scope:'real_M01_cross_session_recall_after_sqlite_reopen',datasetSha256,assetReleaseId:assets.releaseId,total:results.length,passed:results.filter(x=>x.status==='passed').length,threshold:0.9,sourceFactsSeeded:20,memoryRows:db.prepare('SELECT COUNT(*) AS n FROM memory').get().n,fullSetExecuted:results.length===20,database:'isolated-temporary-file',profileBusinessWrites:false,microphoneOpened:false,audioPlayed:false}))
 if(db.prepare('SELECT COUNT(*) AS n FROM memory').get().n!==20 || db.prepare('SELECT COUNT(*) AS n FROM memory WHERE version<>1').get().n!==0 || db.prepare('SELECT COUNT(*) AS n FROM items').get().n!==0 || tasks.list().length!==0 || results.filter(x=>x.status==='passed').length/results.length<0.9)process.exitCode=1
}finally{tasks.close();db.close();rmSync(dir,{recursive:true,force:true})}
