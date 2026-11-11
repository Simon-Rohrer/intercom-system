'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {createEventOps}=require('../event-ops')
function setup(t,enabled=true){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'jms-backfill-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}))
 fs.writeFileSync(path.join(dataDir,'ops-notion.json'),JSON.stringify({enabled,token:'test-only'}))
 fs.writeFileSync(path.join(dataDir,'event-ops.json'),JSON.stringify({version:1,revision:0,events:{},history:[],issues:[{id:'legacy',title:'Existing',status:'resolved'},{id:'already-sent',title:'Sent'},{id:'waiting',title:'Pending'}],notionJobs:{'already-sent':{issue:{id:'already-sent'},sentAt:'2026-11-02'},waiting:{issue:{id:'waiting'},attempts:2,nextAt:99999999}}}))
 const args={dataDir,churchTools:{snapshot:()=>({})},getRoles:()=>[]};return {args,ops:createEventOps(args),file:path.join(dataDir,'event-ops.json')}
}
test('legacy import is durable, idempotent and preserves sent/pending jobs',t=>{
 const {ops,args,file}=setup(t);const before=JSON.parse(fs.readFileSync(file))
 const result=ops.importNotionIssues({admin:true,name:'Admin'});assert.equal(result.queued,1)
 const after=JSON.parse(fs.readFileSync(file));assert.deepEqual(after.issues,before.issues);assert.deepEqual(after.notionJobs.waiting,before.notionJobs.waiting);assert.deepEqual(after.notionJobs['already-sent'],before.notionJobs['already-sent']);assert.equal(after.notionJobs.legacy.issue.status,'resolved')
 assert.equal(createEventOps(args).importNotionIssues({admin:true}).queued,0);assert.equal(JSON.parse(fs.readFileSync(file)).history.length,1)
})
test('backfill rejects non-admin and disabled integration without altering data',t=>{
 const {ops,file}=setup(t,false),before=fs.readFileSync(file,'utf8')
 assert.throws(()=>ops.importNotionIssues({admin:false}),e=>e.status===403)
 assert.throws(()=>ops.importNotionIssues({admin:true}),/aktivieren/)
 assert.equal(fs.readFileSync(file,'utf8'),before)
})
