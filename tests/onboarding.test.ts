import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {R1Onboarding} from '../electron/main/r1/onboarding'
it('persists a skip as UI-only state without accepting extra consent fields',()=>{
 const dir=mkdtempSync(join(tmpdir(),'seamo-welcome-')),path=join(dir,'onboarding.json')
 try{
  const store=new R1Onboarding(path)
  expect(store.get()).toEqual({completed:false,skipped:false,completedAt:null})
  expect(()=>store.complete({skipped:true,memoryEnabled:true} as any)).toThrow('ONBOARDING_INPUT_INVALID')
  const saved=store.complete({skipped:true})
  expect(new R1Onboarding(path).get()).toEqual(saved)
  expect(statSync(path).mode&0o777).toBe(0o600)
  writeFileSync(path,'{}')
  expect(()=>store.get()).toThrow('ONBOARDING_STATE_INVALID')
 }finally{rmSync(dir,{recursive:true,force:true})}
})
