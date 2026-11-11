'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {createEventOps}=require('../event-ops'),{PAGE_ID,issueBlock}=require('../ops-notion')
const admin={admin:true,name:'Admin',roleId:'admin'}
function setup(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'issue-reason-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));const args={dataDir,churchTools:{snapshot:()=>({})},getRoles:()=>[]};return {args,ops:createEventOps(args),file:path.join(dataDir,'event-ops.json')}}
test('not implemented needs a nonblank reason and rejects invalid changes atomically',t=>{
 const {ops,file}=setup(t);const {id}=ops.changeIssue(admin,{device:'Mixer',title:'Example'});const x=ops.issues(admin).issues.find(x=>x.id===id),before=fs.readFileSync(file,'utf8')
 for(const nonImplementationReason of [undefined,'','   '])assert.throws(()=>ops.changeIssue(admin,{...x,status:'not_implemented',nonImplementationReason,previous:x.updatedAt}),/Grund/)
 assert.equal(fs.readFileSync(file,'utf8'),before)
})
test('reason persists across restart, can be edited, and survives reopen without hidden field submission',t=>{
 const {ops,args}=setup(t);const {id}=ops.changeIssue(admin,{device:'Mixer',title:'Example',status:'not_implemented',nonImplementationReason:'  Ersatz ist bestellt.  '});let x=createEventOps(args).issues(admin).issues.find(x=>x.id===id)
 assert.equal(x.status,'not_implemented');assert.equal(x.nonImplementationReason,'Ersatz ist bestellt.')
 ops.changeIssue(admin,{...x,nonImplementationReason:'Kein Budget',previous:x.updatedAt});x=ops.issues(admin).issues[0]
 ops.changeIssue(admin,{...x,status:'open',nonImplementationReason:undefined,previous:x.updatedAt});x=ops.issues(admin).issues[0];assert.equal(x.nonImplementationReason,'Kein Budget')
 ops.changeIssue(admin,{...x,status:'not_implemented',nonImplementationReason:undefined,previous:x.updatedAt});assert.equal(createEventOps(args).issues(admin).issues[0].nonImplementationReason,'Kein Budget')
})
test('reason changes retain existing ownership and optimistic concurrency restrictions',t=>{
 const {ops}=setup(t);ops.changeIssue({roleId:'light',name:'Licht'},{device:'Mixer',title:'Example'});const x=ops.issues(admin).issues[0]
 assert.throws(()=>ops.changeIssue({roleId:'sound',name:'Ton'},{...x,status:'not_implemented',nonImplementationReason:'Grund',previous:x.updatedAt}),e=>e.status===403)
 assert.throws(()=>ops.changeIssue(admin,{...x,status:'not_implemented',nonImplementationReason:'Grund',previous:'old'}),e=>e.status===409)
})
test('Notion does not silently reopen not-implemented; explicit check/uncheck restores it with its reason',async t=>{
 const {ops,args,file}=setup(t);ops.changeIssue(admin,{device:'Mixer',title:'Example',status:'not_implemented',nonImplementationReason:'Kein Budget'})
 const state=JSON.parse(fs.readFileSync(file)),id=state.issues[0].id;Object.assign(state.notionJobs[id],{sentAt:'2026-11-02',blockId:'block',syncChecked:false,syncedStatusVersion:0});fs.writeFileSync(file,JSON.stringify(state));fs.writeFileSync(path.join(args.dataDir,'ops-notion.json'),JSON.stringify({enabled:true,token:'test-only'}))
 let checked=false;let writes=0
 const notionFetch=async(url,options)=>{if(options.method==='PATCH'){writes++;checked=JSON.parse(options.body).to_do.checked}return {ok:true,json:async()=>({results:url.includes(PAGE_ID)?[{id:'section',type:'toggle',toggle:{rich_text:[{plain_text:'Technik-Mängel'}]}}]:[{id:'block',type:'to_do',to_do:{checked}}]})}}
 const linked=createEventOps({...args,notionFetch});await linked.notion.flush();assert.equal(linked.issues(admin).issues[0].status,'not_implemented')
 checked=true;await linked.notion.flush();assert.equal(linked.issues(admin).issues[0].status,'resolved')
 checked=false;await linked.notion.flush();const x=linked.issues(admin).issues[0];assert.equal(x.status,'not_implemented');assert.equal(x.nonImplementationReason,'Kein Budget');assert.equal(writes,0)
 assert.equal(issueBlock(x).to_do.checked,false);assert.match(JSON.stringify(issueBlock(x)),/Nicht umgesetzt/)
})
