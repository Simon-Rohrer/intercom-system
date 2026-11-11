'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),express=require('express')
const {createEventOps,eventOpsRouter}=require('../event-ops')
function setup(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'notion-routes-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));const args={dataDir,churchTools:{snapshot:()=>({})},getRoles:()=>[]};return {args,ops:createEventOps(args),dataDir}}
test('queue is saved atomically with new report; editing preserves original snapshot; survives restart',t=>{
 const {args,ops,dataDir}=setup(t),user={roleId:'light',name:'Test'}
 const {id}=ops.changeIssue(user,{device:'Mixer',title:'Test'})
 let stored=JSON.parse(fs.readFileSync(path.join(dataDir,'event-ops.json')))
 assert.equal(stored.issues[0].id,id);assert.equal(stored.notionJobs[id].issue.title,'Test')
 const item=ops.issues(user).issues[0];ops.changeIssue(user,{...item,title:'Updated',previous:item.updatedAt})
 const restarted=createEventOps(args);assert.equal(restarted.notion.status().pending,1)
 stored=JSON.parse(fs.readFileSync(path.join(dataDir,'event-ops.json')));assert.equal(stored.notionJobs[id].issue.title,'Test');assert.equal(stored.issues[0].title,'Updated')
 assert.equal(ops.issues(user).notion,undefined)
})
test('legacy reports do not silently enter queue',t=>{
 const {args,dataDir}=setup(t)
 fs.writeFileSync(path.join(dataDir,'event-ops.json'),JSON.stringify({version:1,revision:0,events:{},issues:[{id:'old',title:'Existing'}],history:[]}))
 const ops=createEventOps(args);assert.equal(ops.notion.status().pending,0);assert.equal(ops.issues({admin:true}).issues.length,1)
})
test('Notion configuration endpoints require admin; anonymous/chat/member denied',async t=>{
 const {ops}=setup(t),app=express();app.use(express.json())
 app.use('/ops',eventOpsRouter(ops,(req,res,next)=>{const r=req.get('x-role');if(!r)return res.status(401).end();req.user={admin:r==='admin',chatOnly:r==='chat'};next()},(req,res,next)=>req.user.admin?next():res.status(403).end()))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/ops/notion'
 for(const [role,status] of [['',401],['chat',403],['member',403],['admin',200]]){
  assert.equal((await fetch(url,{headers:role?{'x-role':role}:{}})).status,status)
  assert.equal((await fetch(url,{method:'POST',headers:{'x-role':role,'Content-Type':'application/json'},body:JSON.stringify({enabled:false})})).status,status)
 }
 const data=await (await fetch(url,{headers:{'x-role':'admin'}})).json();assert.equal(data.token,undefined);assert.equal(data.enabled,false)
})
