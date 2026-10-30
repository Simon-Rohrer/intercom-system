'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {createEventOps}=require('../event-ops'),{createChurchTools}=require('../churchtools')
const admin={admin:true,roleId:'admin',name:'Test'}
test('selected event agenda switches by ID; failures never show another event agenda',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agenda-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=Date.parse('2030-01-01T09:00:00Z'),broken=false,calls=[]
 const events=[{id:42,name:'A',startDate:'2030-01-01T10:00:00Z',endDate:'2030-01-01T12:00:00Z'},{id:43,name:'B',startDate:'2030-01-02T10:00:00Z',endDate:'2030-01-02T12:00:00Z'}]
 const ct={snapshot:()=>({}),api:async p=>({data:p.startsWith('/events?')?events:p.startsWith('/events/')?{eventServices:[]}:[]}),agendaForEvent:async e=>{calls.push(e.id);if(broken)throw Error('offline');return {agenda:{items:[{title:'',duration:0,start:e.startDate},{title:'Ablauf '+e.name,duration:60}]}}}}
 const ops=createEventOps({dataDir:dir,churchTools:ct,getRoles:()=>[],now:()=>now})
 let d=await ops.overview(admin);assert.equal(d.agenda.items.length,1);assert.equal(d.agenda.items[0].title,'Ablauf A');await ops.overview(admin);assert.equal(calls.length,1)
 await ops.mutateEvent(admin,{action:'select',eventId:'43',revision:d.revision});broken=true;d=await ops.overview(admin);assert.equal(d.agenda.eventId,'43');assert.equal(d.agenda.items.length,0);assert.equal(d.agenda.stale,true)
 now+=61000;broken=false;d=await ops.overview(admin);assert.equal(d.agenda.items[0].title,'Ablauf B');const last=d.agenda.updatedAt
 now+=61000;broken=true;d=await ops.overview(admin);assert.equal(d.agenda.items[0].title,'Ablauf B');assert.equal(d.agenda.updatedAt,last);assert.equal(d.agenda.stale,true)
})
test('selected agenda uses shared CT normalization: ordering, time, responsibility and notes',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agenda-ct-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'churchtools-secret.json'),JSON.stringify({url:'https://ct.test',token:'test-only'}));let seen=[]
 t.mock.method(globalThis,'fetch',async url=>{seen.push(url);const payload=url.endsWith('/servicegroups')?{data:[{id:3,name:'Technik'}]}:{data:{name:'Testablauf',items:[{id:2,position:2,title:'Vortrag',duration:600,responsible:{text:'[Ton]',persons:[{service:'Ton',person:{title:'Alex'},accepted:true}]},note:'Mikrofon',serviceGroupNotes:[{serviceGroupId:3,note:'Lichtwechsel'}]},{id:1,position:1,title:'Begrüßung',duration:120}]}};return {ok:true,status:200,text:async()=>JSON.stringify(payload)}})
 const ct=createChurchTools({dataDir:dir,getConfig:()=>({timeZone:'Europe/Berlin'}),onUpdate:()=>{}});const d=await ct.agendaForEvent({id:'42',startDate:'2030-01-01T10:00:00Z'});assert.equal(d.agenda.items[0].title,'Begrüßung');assert.equal(d.agenda.items[1].start,'2030-01-01T10:02:00.000Z');assert.equal(d.agenda.items[1].responsible,'Alex');assert.equal(d.agenda.items[1].columns[0].note,'Lichtwechsel');assert.ok(seen[0].endsWith('/events/42/agenda'))
})
test('missing agenda remains a meaningful empty/error response',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agenda-empty-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const e={id:1,name:'Empty',startDate:'2030-01-01T10:00:00Z'};
 const ct={snapshot:()=>({}),api:async p=>({data:p.startsWith('/events?')?[e]:p.startsWith('/events/')?{eventServices:[]}:[]}),agendaForEvent:async()=>({agenda:null,agendaError:'Kein Ablauf hinterlegt'})};const ops=createEventOps({dataDir:dir,churchTools:ct,getRoles:()=>[],now:()=>Date.parse('2030-01-01')});const d=await ops.overview(admin);assert.deepEqual(d.agenda.items,[]);assert.equal(d.agenda.error,'Kein Ablauf hinterlegt');assert.equal(d.agenda.stale,false)
})
