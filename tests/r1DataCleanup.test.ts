import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1DataManagement } from '../electron/main/r1/dataManagement'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1Items } from '../electron/main/r1/items'
import { createR1Backup, restoreR1BackupOffline } from '../electron/main/r1/backup'
import { memoryContextCutoff } from '../electron/main/r1/memoryContext'
const dirs: string[]=[]
afterEach(()=>{ for(const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}) })
function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'seamo-cleanup-')); dirs.push(dir)
 const path=join(dir,'r1.sqlite'), db=openR1Database(path), conversations=new R1Conversations(db), session=conversations.start()
 const source=conversations.append({sessionId:session,turnId:'fixture',role:'user',body:'合成测试来源',status:'final'})
 const memory=new R1MemoryStore(db).remember({content:'合成偏好',category:'preference',sourceMessageIds:[source.messageId]})
 const item=new R1Items(db).create({actionId:'create',kind:'note',title:'独立事项',body:'合成正文'}).item
 return {dir,path,db,session,memory,item,data:new R1DataManagement(db,path,dir)}
}
it('requires explicit scopes, the same owner, an unexpired unchanged preview and explicit confirmation',()=>{
 const s=fixture()
 try {
  expect(()=>s.data.prepareCleanup(1,{scopes:[]})).toThrow('DATA_SCOPE_REQUIRED')
  expect(()=>s.data.prepareCleanup(1,{scopes:['credentials']})).toThrow('DATA_SCOPE_REQUIRED')
  new R1MemoryStore(s.db).addManual({content:'独立手动记忆来源',category:'profile'})
  expect(s.data.prepareCleanup(1,{scopes:['history']}).counts.messages).toBe(1)
  const p=s.data.prepareCleanup(1,{scopes:['history'],sessionId:s.session})
  expect(()=>s.data.confirmCleanup(2,{ticket:p.ticket,confirmed:true})).toThrow('DATA_PREVIEW_EXPIRED')
  expect(()=>s.data.confirmCleanup(1,{ticket:p.ticket,confirmed:false} as any)).toThrow('DATA_CONFIRMATION_REQUIRED')
  s.db.prepare("UPDATE messages SET body='changed' WHERE session_id=?").run(s.session)
  expect(()=>s.data.confirmCleanup(1,{ticket:p.ticket,confirmed:true})).toThrow('DATA_CHANGED_REVIEW_AGAIN')
  const next=s.data.prepareCleanup(1,{scopes:['music']});s.data.cancel(1)
  expect(()=>s.data.confirmCleanup(1,{ticket:next.ticket,confirmed:true})).toThrow('DATA_PREVIEW_EXPIRED')
  let time=Date.now();const expiring=new R1DataManagement(s.db,s.path,s.dir,()=>time)
  const expired=expiring.prepareCleanup(1,{scopes:['music']});time+=300001
  expect(()=>expiring.confirmCleanup(1,{ticket:expired.ticket,confirmed:true})).toThrow('DATA_PREVIEW_EXPIRED')
 } finally{s.db.close()}
})
it('deletes only selected history offline, keeps independent memory/items, and accepts fresh messages above the old cutoff',async()=>{
 const s=fixture(),p=s.data.prepareCleanup(1,{scopes:['history'],sessionId:s.session})
 s.data.confirmCleanup(1,{ticket:p.ticket,confirmed:true})
 expect(()=>s.data.runAfterDatabaseClosed()).toThrow('DATA_DATABASE_STILL_OPEN')
 expect(new R1Conversations(s.db).messages(s.session)).toHaveLength(1)
 s.data.close();s.db.close();s.data.runAfterDatabaseClosed()
 const db=openR1Database(s.path)
 try{
  const data=new R1DataManagement(db,s.path,s.dir)
  expect(data.summary()).toMatchObject({counts:{sessions:0,memories:1,items:1},lastCleanup:{status:'succeeded'}})
  expect(new R1MemoryStore(db).list().entries).toHaveLength(1)
  const conversations=new R1Conversations(db),id=conversations.start()
  const source=conversations.append({sessionId:id,turnId:'new',role:'user',body:'清理后的新消息',status:'final'})
  expect(conversations.modelTurns(id)).toHaveLength(1)
  const sequence=(db.prepare('SELECT rowid AS n FROM messages WHERE message_id=?').get(source.messageId) as {n:number}).n
  expect(sequence).toBeGreaterThan(memoryContextCutoff(db))
  const exported=join(s.dir,'before.sqlite');await data.exportCleanupBackup(exported)
  expect(statSync(exported).mode&0o777).toBe(0o600)
  const before=openR1Database(exported)
  try{expect(new R1Conversations(before).messages(s.session)).toHaveLength(1)}finally{before.close()}
 }finally{db.close()}
})
it('clears memories without deleting history/items and keeps forgetting suppression across an older restore',async()=>{
 const s=fixture(),old=join(s.dir,'old.sqlite');await createR1Backup(s.db,old)
 const p=s.data.prepareCleanup(1,{scopes:['memory']});s.data.confirmCleanup(1,{ticket:p.ticket,confirmed:true})
 s.data.close();s.db.close();s.data.runAfterDatabaseClosed()
 let db=openR1Database(s.path)
 expect(new R1MemoryStore(db).list().entries).toHaveLength(0)
 expect(new R1Conversations(db).messages(s.session)).toHaveLength(1)
 expect(new R1Items(db).list()).toHaveLength(1)
 db.close();restoreR1BackupOffline(s.path,old);db=openR1Database(s.path)
 try{expect(new R1MemoryStore(db).list().entries).toHaveLength(0)}finally{db.close()}
})

it('rechecks selected content after services drain, before committing any deletion',()=>{
 const s=fixture(),p=s.data.prepareCleanup(1,{scopes:['history']})
 s.data.confirmCleanup(1,{ticket:p.ticket,confirmed:true})
 new R1Conversations(s.db).append({sessionId:s.session,turnId:'late',role:'user',body:'确认后结束前到达的内容',status:'final'})
 s.data.close();s.db.close();s.data.runAfterDatabaseClosed()
 const db=openR1Database(s.path)
 try{
  expect(new R1DataManagement(db,s.path,s.dir).summary().lastCleanup).toMatchObject({status:'failed'})
  expect(new R1Conversations(db).messages(s.session)).toHaveLength(2)
 }finally{db.close()}
})

it('upgrades an actual schema10 message layout without changing source identities or row ordering',()=>{
 const s=fixture()
 s.db.exec(`ALTER TABLE messages RENAME TO old_messages;
 CREATE TABLE messages(message_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(session_id),turn_id TEXT NOT NULL,response_id TEXT,role TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,played_until_ms INTEGER,created_at TEXT NOT NULL);
 INSERT INTO messages(rowid,message_id,session_id,turn_id,response_id,role,body,status,played_until_ms,created_at)
 SELECT rowid,message_id,session_id,turn_id,response_id,role,body,status,played_until_ms,created_at FROM old_messages;
 DROP TABLE old_messages;CREATE INDEX messages_session_time ON messages(session_id,created_at);PRAGMA user_version=10;`)
 const before=new R1Conversations(s.db).messages(s.session)[0]
 s.db.close();const db=openR1Database(s.path)
 try{
  expect(db.prepare('PRAGMA user_version').get()).toMatchObject({user_version:11})
  expect(new R1Conversations(db).messages(s.session)[0]).toEqual(before)
  expect(new R1MemoryStore(db).sources(s.memory.memoryId)[0].messageId).toBe(before.messageId)
 }finally{db.close()}
})
