'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {createEventOps}=require('../event-ops'),{createNotionSync,PAGE_ID}=require('../ops-notion')
const admin={admin:true,name:'Test Admin',roleId:'admin'}
function setup(t,{status='open',checked=false,legacy=false}={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'notion-status-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}))
 const issue={id:'one',title:'Wackler',device:'HDMI',description:'Original',status,updatedAt:'2026-01-01T00:00:00Z',createdAt:'2026-01-01T00:00:00Z',createdBy:'Test',owner:'admin',priority:'normal'}
 const job={issue:{...issue},sentAt:'2026-01-01T00:00:00Z',blockId:'block',...(legacy?{}:{syncChecked:status==='resolved',localStatusVersion:0,syncedStatusVersion:0}),reopenStatus:status==='working'?'working':'open'}
 fs.writeFileSync(path.join(dataDir,'event-ops.json'),JSON.stringify({version:1,revision:0,events:{},issues:[issue],history:[],notionJobs:{one:job}}))
 fs.writeFileSync(path.join(dataDir,'ops-notion.json'),JSON.stringify({enabled:true,token:'test-key'}))
 const remote={id:'block',type:'to_do',to_do:{checked,rich_text:[{text:{content:'User wording unchanged'}}]}},calls=[]
 let error=0,afterPatch,missing=false,lostResponse=false
 const response=(data,status=200)=>({ok:status===200,status,headers:new Headers(),json:async()=>structuredClone(data)})
 const fetchImpl=async(url,options)=>{
  calls.push({url,options})
  if(error)return response({},error)
  if(options.method==='PATCH'){
   const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['to_do']);assert.deepEqual(Object.keys(body.to_do),['checked'])
   remote.to_do.checked=body.to_do.checked
   if(afterPatch){const fn=afterPatch;afterPatch=null;fn()}
   if(lostResponse){lostResponse=false;throw Error('lost response')}
   return response(remote)
  }
  if(url.includes(PAGE_ID))return response({results:[{id:'section',type:'toggle',toggle:{rich_text:[{plain_text:'Technik-Mängel'}]}}]})
  return response({results:missing?[]:[remote]})
 }
 const args={dataDir,churchTools:{snapshot:()=>({})},getRoles:()=>[],notionFetch:fetchImpl},ops=createEventOps(args)
 const get=()=>ops.issues(admin).issues[0],edit=status=>{const x=get();return ops.changeIssue(admin,{...x,status,previous:x.updatedAt})},state=()=>JSON.parse(fs.readFileSync(path.join(dataDir,'event-ops.json')))
 return {dataDir,args,ops,get,edit,state,remote,calls,setError:x=>error=x,setMissing:()=>missing=true,onPatch:fn=>afterPatch=fn,lose:()=>lostResponse=true}
}
test('Notion checked and unchecked propagate atomically, restore working, and preserve content',async t=>{
 const x=setup(t,{status:'working',checked:true,legacy:true});await x.ops.notion.flush();assert.equal(x.get().status,'resolved');assert.equal(x.get().updatedBy,'Notion');assert.equal(x.get().description,'Original');assert.equal(x.state().notionJobs.one.syncChecked,true)
 x.remote.to_do.checked=false;await x.ops.notion.flush();assert.equal(x.get().status,'working');assert.equal(x.state().history.length,2);assert.equal(x.calls.filter(c=>c.options.method==='PATCH').length,0)
 await x.ops.notion.flush();assert.equal(x.state().history.length,2)
})
test('dashboard resolve/reopen patch only checked; restarts preserve acknowledgement and do not echo',async t=>{
 const x=setup(t);x.edit('resolved');assert.equal(x.ops.notion.status().statusPending,1);await x.ops.notion.flush();assert.equal(x.remote.to_do.checked,true);assert.equal(x.ops.notion.status().statusPending,0)
 x.edit('open');await x.ops.notion.flush();assert.equal(x.remote.to_do.checked,false);const count=x.calls.filter(c=>c.options.method==='PATCH').length;await createEventOps(x.args).notion.flush();assert.equal(x.calls.filter(c=>c.options.method==='PATCH').length,count)
 assert.equal(x.remote.to_do.rich_text[0].text.content,'User wording unchanged')
})
test('in-flight dashboard change remains pending and is pushed next cycle',async t=>{
 const x=setup(t);x.edit('resolved');x.onPatch(()=>x.edit('open'));await x.ops.notion.flush();assert.equal(x.get().status,'open');assert.equal(x.remote.to_do.checked,true);assert.equal(x.ops.notion.status().statusPending,1)
 await x.ops.notion.flush();assert.equal(x.remote.to_do.checked,false);assert.equal(x.ops.notion.status().statusPending,0)
})
test('two local toggles during an outage are not lost even when final value equals baseline',async t=>{
 const x=setup(t);x.edit('resolved');x.edit('open');x.remote.to_do.checked=true;await x.ops.notion.flush();assert.equal(x.get().status,'open');assert.equal(x.remote.to_do.checked,false)
})
test('failed status PATCH stays queued across restart and lost response is reconciled',async t=>{
 const x=setup(t);x.edit('resolved');x.lose();await x.ops.notion.flush();assert.equal(x.remote.to_do.checked,true);assert.equal(x.ops.notion.status().statusPending,1);assert(x.ops.notion.status().error)
 const s=x.state();s.notionJobs.one.nextAt=0;fs.writeFileSync(path.join(x.dataDir,'event-ops.json'),JSON.stringify(s));const ops=createEventOps(x.args);await ops.notion.flush();assert.equal(ops.notion.status().statusPending,0);assert.equal(ops.notion.status().error,'');assert.equal(x.calls.filter(c=>c.options.method==='PATCH').length,1)
})
test('missing block does not erase or resolve dashboard issue, and reports a sync error',async t=>{
 const x=setup(t);x.setMissing();await x.ops.notion.flush();assert.equal(x.get().status,'open');assert.match(x.ops.notion.status().error,/fehlt/);assert.equal(x.calls.filter(c=>c.options.method==='PATCH').length,0)
})
test('read errors do not change issues and remain visible for already exported jobs',async t=>{
 const x=setup(t);x.setError(403);await x.ops.notion.flush();assert.equal(x.get().status,'open');assert.match(x.ops.notion.status().error,/Aktualisieren/);const count=x.calls.length;await x.ops.notion.flush();assert.equal(x.calls.length,count)
})
test('legacy already resolved dashboard status wins over stale exported snapshot',async t=>{
 const x=setup(t,{legacy:true});const s=x.state();s.issues[0].status='resolved';fs.writeFileSync(path.join(x.dataDir,'event-ops.json'),JSON.stringify(s));await createEventOps(x.args).notion.flush();assert.equal(x.remote.to_do.checked,true)
})
