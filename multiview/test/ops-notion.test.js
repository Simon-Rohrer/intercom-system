'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {createNotionSync,PAGE_ID}=require('../ops-notion')
const issue={id:'issue-123',title:'Wackler',device:'HDMI',description:'Bild fällt aus',createdBy:'Test',createdAt:'2026-11-02T10:00:00Z',priority:'urgent',status:'open'}
function setup(t){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'notion-test-'));t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}))
 const jobs={[issue.id]:{issue,attempts:0,nextAt:0}},remote=[],calls=[]
 let clock=1000000,failAfterWrite=false,rateLimit=false
 const response=(body,status=200)=>({ok:status===200,status,headers:new Headers(status===429?{'retry-after':'180'}:{}),json:async()=>body})
 const fetchImpl=async(url,options)=>{
  calls.push({url,options})
  if(url.endsWith('/pages/'+PAGE_ID))return response({id:PAGE_ID})
  if(rateLimit)return response({},429)
  if(url.includes('/blocks/'+PAGE_ID+'/'))return response({results:[{id:'section',type:'toggle',toggle:{rich_text:[{plain_text:'Technik-Mängel'}]}}]})
  if(options.method==='PATCH') {const block={id:'notion-block',...JSON.parse(options.body).children[0]};remote.push(block);if(failAfterWrite){failAfterWrite=false;throw Error('network timeout with private details')}return response({results:[block]})}
  return response({results:remote})
 }
 const args={dataDir,getJobs:()=>jobs,updateJob:(id,patch)=>Object.assign(jobs[id],patch),fetchImpl,now:()=>clock}
 return {args,jobs,remote,calls,sync:createNotionSync(args),tick:()=>clock+=4000000,ambiguous:()=>failAfterWrite=true,limit:()=>rateLimit=true}
}
test('disabled integration makes no requests; token stays out of status and persists with mode 0600',async t=>{
 const x=setup(t);await x.sync.flush();assert.equal(x.calls.length,0)
 await x.sync.configure({enabled:true,token:'test-secret'});assert(!JSON.stringify(x.sync.status()).includes('test-secret'))
 assert.equal(fs.statSync(path.join(x.args.dataDir,'ops-notion.json')).mode&0o777,0o600)
 assert.equal(createNotionSync(x.args).status().configured,true)
})
test('issue becomes a distinct todo with metadata, then is never resent',async t=>{
 const x=setup(t);await x.sync.configure({enabled:true,token:'test-secret'});await x.sync.flush();await x.sync.flush()
 assert.equal(x.remote.length,1);assert.match(x.remote[0].to_do.rich_text[0].text.content,/HDMI: Wackler \[JMS:issue-123\]/)
 assert.match(JSON.stringify(x.remote),/Bild fällt aus/);assert.equal(x.sync.status().sent,1)
 assert(x.calls.every(c=>c.url.startsWith('https://api.notion.com/v1/')))
})
test('lost write response reconciles on restart without duplicate',async t=>{
 const x=setup(t);await x.sync.configure({enabled:true,token:'test-secret'});x.ambiguous();await x.sync.flush()
 assert.equal(x.remote.length,1);assert.equal(x.sync.status().pending,1);assert(!x.jobs[issue.id].error.includes('private'))
 x.tick();await createNotionSync(x.args).flush();assert.equal(x.remote.length,1);assert.equal(x.sync.status().sent,1)
})
test('rate limit respects retry-after, stores failure, and does not hammer API',async t=>{
 const x=setup(t);await x.sync.configure({enabled:true,token:'test-secret'});x.limit();await x.sync.flush()
 assert.equal(x.jobs[issue.id].nextAt,1180000);const count=x.calls.length;await x.sync.flush();assert.equal(x.calls.length,count)
 assert.equal(x.sync.status().pending,1)
})
test('concurrent worker calls serialize; disable retains queue',async t=>{
 const x=setup(t);await x.sync.configure({enabled:true,token:'test-secret'});await Promise.all([x.sync.flush(),x.sync.flush()]);assert.equal(x.remote.length,1)
 x.jobs.another={issue:{...issue,id:'another'},nextAt:0};await x.sync.configure({enabled:false,token:''});await x.sync.flush();assert.equal(x.sync.status().pending,1);assert.equal(x.sync.status().configured,true)
})
test('failed credential verification leaves saved configuration unchanged',async t=>{
 const x=setup(t);await x.sync.configure({enabled:false,token:'original'})
 const sync=createNotionSync({...x.args,fetchImpl:async()=>({ok:false,status:401,headers:new Headers()})})
 await assert.rejects(sync.configure({enabled:true,token:'invalid'}),/Schlüssel ungültig/)
 assert.equal(sync.status().enabled,false);assert.equal(JSON.parse(fs.readFileSync(path.join(x.args.dataDir,'ops-notion.json'))).token,'original')
})
test('pagination finds existing marker on later pages',async t=>{
 const x=setup(t);await x.sync.configure({enabled:true,token:'test-secret'})
 const sync=createNotionSync({...x.args,fetchImpl:async(url,options)=>{
   if(options.method==='PATCH')assert.fail('must not duplicate')
   const results=url.includes(PAGE_ID)?[{id:'section',type:'toggle',toggle:{rich_text:[{plain_text:'Technik-Mängel'}]}}]:url.includes('start_cursor')?[{id:'existing',type:'to_do',to_do:{rich_text:[{plain_text:'HDMI [JMS:issue-123]'}]}}]:[]
   return {ok:true,json:async()=>({results,has_more:url.endsWith('section/children?page_size=100'),next_cursor:'second'})}
 }})
 await sync.flush();assert.equal(x.jobs[issue.id].blockId,'existing')
})
