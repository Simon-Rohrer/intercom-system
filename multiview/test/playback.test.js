const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');const {createEventOps}=require('../event-ops');const admin={admin:true,name:'Operator',roleId:'admin'};
test('manual show: permissions, duplicate advance, persistent state, undo, scoped events, overrun and reset',async t=>{
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'playback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=Date.parse('2030-01-01T10:00:00Z');const events=[{id:42,name:'A',startDate:'2030-01-01T10:00:00Z',endDate:'2030-01-01T10:04:00Z'},{id:43,name:'B',startDate:'2030-01-02T10:00:00Z'}];let items=[{id:1,title:'Intro',duration:60,start:events[0].startDate},{id:2,type:'header',title:'Abschnitt',duration:0},{id:3,title:'Vortrag',duration:120,start:'2030-01-01T10:01:00Z'},{id:4,title:'Ende',duration:60,start:'2030-01-01T10:03:00Z'}];
const ct={snapshot:()=>({}),api:async p=>({data:p.startsWith('/events?')?events:p.startsWith('/events/')?{eventServices:[]}:[]}),agendaForEvent:async()=>({agenda:{items}})};const make=()=>createEventOps({dataDir:dir,churchTools:ct,getRoles:()=>[],now:()=>now});let ops=make();await ops.overview(admin);
await assert.rejects(ops.playback({admin:false},{action:'start',eventId:'42',index:0}),e=>e.status===403);
await assert.rejects(ops.playback(admin,{action:'start',eventId:'42',index:1}),e=>e.status===400);
await ops.playback(admin,{action:'start',eventId:'42',index:0});let d=await ops.overview(admin),token=d.playback.updatedAt;assert.equal(d.playback.steps[0].index,0);
now+=90000;let results=await Promise.allSettled([ops.playback(admin,{action:'next',eventId:'42',previous:token}),ops.playback(admin,{action:'next',eventId:'42',previous:token})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.status,409);
d=await ops.overview(admin);assert.equal(d.playback.steps.length,2);assert.equal(d.playback.steps[1].index,2);assert.equal(d.playback.steps[1].at,new Date(now).toISOString());
items=[{title:'CT changed',duration:100}];ops=make();d=await ops.overview(admin);assert.equal(d.agenda.items[0].title,'Intro');assert.equal(d.playback.steps.length,2);
now+=86400000;d=await ops.overview(admin);assert.equal(d.event.id,'42','manual running event remains selected past planned end');
await ops.playback(admin,{action:'back',eventId:'42',previous:d.playback.updatedAt});d=await ops.overview(admin);assert.equal(d.playback.steps.length,1);
await ops.mutateEvent(admin,{action:'select',eventId:'43',revision:d.revision});d=await ops.overview(admin);assert.equal(d.playback,null);await assert.rejects(ops.playback(admin,{action:'next',eventId:'42'}),e=>e.status===409);
await ops.mutateEvent(admin,{action:'select',eventId:'42',revision:d.revision});d=await ops.overview(admin);
for(let i=0;i<3;i++){await ops.playback(admin,{action:'next',eventId:'42',previous:d.playback.updatedAt});d=await ops.overview(admin)}assert.ok(d.playback.endedAt);await assert.rejects(ops.playback(admin,{action:'next',eventId:'42',previous:d.playback.updatedAt}),e=>e.status===409);
await ops.playback(admin,{action:'back',eventId:'42',previous:d.playback.updatedAt});d=await ops.overview(admin);assert.equal(d.playback.endedAt,null);
await ops.playback(admin,{action:'auto',eventId:'42',previous:d.playback.updatedAt});d=await ops.overview(admin);assert.equal(d.playback.mode,'auto');assert.equal(d.agenda.items[0].title,'CT changed');
});
