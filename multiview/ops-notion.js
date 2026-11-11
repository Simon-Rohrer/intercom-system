'use strict'
const fs = require('fs')
const path = require('path')
const PAGE_ID = '3f2e7078-4cde-811a-8868-de9dbfb3d318'
const PAGE_URL = 'https://www.notion.so/' + PAGE_ID.replaceAll('-', '')
const rich = content => [{type:'text',text:{content}}]
const plain = block => (block[block.type]?.rich_text || []).map(x=>x.plain_text ?? x.text?.content ?? '').join('')
const paragraph = content => ({object:'block',type:'paragraph',paragraph:{rich_text:rich(content)}})
function issueBlock(x) {
  const status = {open:'Offen',working:'In Bearbeitung',resolved:'Erledigt',not_implemented:'Nicht umgesetzt'}[x.status]
  return {object:'block',type:'to_do',to_do:{checked:x.status==='resolved',rich_text:rich(`${x.priority==='urgent'?'DRINGEND · ':''}${x.device}: ${x.title} [JMS:${x.id}]`),children:[
    paragraph(x.description || 'Keine weitere Beschreibung.'),
    paragraph(`Gemeldet von: ${x.createdBy}\nErfasst: ${x.createdAt}\nVeranstaltung: ${x.eventName || 'Keine zugeordnet'}\nZuständig: ${x.assignee || 'Noch offen'}\nStatus bei Meldung: ${status}${x.photo?'\nFoto: im geschützten JMS Dashboard verfügbar.':''}`)
  ]}}
}
function createNotionSync({dataDir,getJobs,updateJob,getIssue=id=>getJobs()[id]?.issue,applyRemoteChecked,fetchImpl=globalThis.fetch,now=Date.now,requestIntervalMs=350}) {
  const file=path.join(dataDir,'ops-notion.json')
  let config={enabled:false,token:''}, busy=false, timer, lastRequest=0
  try { config=JSON.parse(fs.readFileSync(file,'utf8')); if(typeof config.token!=='string'||typeof config.enabled!=='boolean')throw Error('Invalid Notion configuration') }
  catch(e){if(e.code!=='ENOENT')throw e}
  const problem=(message,status=400)=>Object.assign(new Error(message),{status})
  async function request(route,{token=config.token,method='GET',body}={}) {
    const delay=requestIntervalMs-(Date.now()-lastRequest)
    if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay))
    lastRequest=Date.now()
    let response
    try { response=await fetchImpl('https://api.notion.com/v1'+route,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Notion-Version':'2025-09-03','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined}) }
    catch { throw problem('Notion ist derzeit nicht erreichbar. Die Meldung bleibt gespeichert.',503) }
    if(!response.ok){
      const message=response.status===401?'Notion-Schlüssel ungültig. Bitte die Verbindung neu einrichten.':response.status===403||response.status===404?'Notion-Zugriff fehlt: Die Verbindung für „JMS Server“ freigeben und Lesen, Einfügen sowie Aktualisieren erlauben.':response.status===429?'Notion begrenzt gerade Anfragen. Die Übertragung wird später wiederholt.':'Notion konnte die Anfrage nicht verarbeiten. Die Meldung bleibt gespeichert.'
      const e=problem(message,502);e.retryAfter=Math.max(0,Math.min(86400000,(Number(response.headers.get('retry-after'))||0)*1000));throw e
    }
    return response.json()
  }
  async function children(id){
    const all=[];let cursor
    do {const d=await request(`/blocks/${id}/children?page_size=100${cursor?'&start_cursor='+encodeURIComponent(cursor):''}`);all.push(...d.results);cursor=d.has_more?d.next_cursor:null}while(cursor)
    return all
  }
  function status(){
    const entries=Object.entries(getJobs()),jobs=entries.map(([,j])=>j)
    return {enabled:config.enabled,configured:!!config.token,pageUrl:PAGE_URL,
      pending:jobs.filter(j=>!j.sentAt).length,sent:jobs.filter(j=>j.sentAt).length,
      statusPending:entries.filter(([id,j])=>j.sentAt && ((j.localStatusVersion||0)!==(j.syncedStatusVersion||0) || (getIssue(id)?.status==='resolved')!==(j.syncChecked ?? (j.issue.status==='resolved')))).length,
      lastCheckedAt:jobs.map(j=>j.lastCheckedAt).filter(Boolean).sort().at(-1)||null,
      lastSentAt:jobs.filter(j=>j.sentAt).map(j=>j.sentAt).sort().at(-1)||null,
      error:jobs.filter(j=>j.error).sort((a,b)=>b.attemptAt-a.attemptAt)[0]?.error || ''}
  }
  async function configure(body){
    if(busy)throw problem('Die Übertragung läuft gerade. Bitte kurz warten und erneut speichern.',409)
    const token=typeof body.token==='string'&&body.token.trim()?body.token.trim():config.token
    if(token.length>512||/[\r\n]/.test(token))throw problem('Ungültiger Notion-Schlüssel.')
    const enabled=body.enabled===true
    if(enabled&&!token)throw problem('Bitte zuerst den Notion-Integrationsschlüssel eintragen.')
    busy=true
    try {
      if(enabled)await request('/pages/'+PAGE_ID,{token})
      const next={enabled,token}
      fs.mkdirSync(dataDir,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.chmodSync(file+'.tmp',0o600);fs.renameSync(file+'.tmp',file);config=next
      // Resume promptly after corrected credentials; retries still reconcile remote IDs.
      for(const [id] of Object.entries(getJobs()))updateJob(id,{nextAt:0,error:''})
      return {ok:true,...status()}
    }finally{busy=false}
  }
  function failed(id,e){
    const job=getJobs()[id];if(!job)return
    const attempts=(job.attempts||0)+1
    updateJob(id,{attempts,attemptAt:now(),nextAt:now()+Math.max(60000,Math.min(3600000,30000*2**Math.min(attempts,7)),e.retryAfter||0),error:e.status?e.message:'Statusabgleich unterbrochen. Die Meldung bleibt gespeichert.'})
  }
  async function reconcile(id,block){
    const job=getJobs()[id],issue=getIssue(id)
    if(!job || !issue)return
    if(!block || block.archived || block.in_trash || block.type!=='to_do')throw problem('Das verknüpfte Notion-To-do fehlt oder wurde verändert. Bitte in Notion wiederherstellen.',409)
    const version=job.localStatusVersion||0,local=issue.status==='resolved',remote=block.to_do.checked===true
    const baseline=job.syncChecked ?? (job.issue.status==='resolved')
    const localPending=version!==(job.syncedStatusVersion||0) || local!==baseline
    const patch={attempts:0,error:'',nextAt:0,lastCheckedAt:new Date(now()).toISOString(),syncedStatusVersion:version}
    // An explicit local status change stays queued, including toggling twice during an outage.
    // A concurrent local edit during PATCH keeps its newer version and is sent next time.
    if(localPending){
      if(local!==remote)await request('/blocks/'+block.id,{method:'PATCH',body:{to_do:{checked:local}}})
      updateJob(id,{...patch,syncChecked:local})
    }else if(remote!==local){
      if(!applyRemoteChecked)throw problem('Statusübernahme ist nicht eingerichtet.',500)
      applyRemoteChecked(id,remote,version,{...patch,syncChecked:remote})
    }else updateJob(id,{...patch,syncChecked:remote})
  }
  async function flush(){
    if(busy||!config.enabled||!config.token)return
    const due=Object.entries(getJobs()).filter(([,j])=>(j.nextAt||0)<=now())
    if(!due.length)return
    busy=true
    try {
      const roots=await children(PAGE_ID)
      let section=roots.find(x=>x.type==='toggle'&&plain(x)==='Technik-Mängel')
      const pending=due.find(([,j])=>!j.sentAt)
      if(!section && pending){const d=await request('/blocks/'+PAGE_ID+'/children',{method:'PATCH',body:{children:[{object:'block',type:'toggle',toggle:{rich_text:rich('Technik-Mängel')}}]}});section=d.results[0]}
      if(!section)throw problem('Der Abschnitt „Technik-Mängel“ fehlt in Notion. Bitte wiederherstellen.',409)
      const items=await children(section.id)
      if(pending){
        const [id,job]=pending
        try{
          let block=items.find(x=>x.type==='to_do'&&plain(x).includes(`[JMS:${id}]`))
          if(!block){const d=await request('/blocks/'+section.id+'/children',{method:'PATCH',body:{children:[issueBlock(job.issue)]}});block=d.results[0]}
          updateJob(id,{sentAt:new Date(now()).toISOString(),blockId:block.id,error:'',nextAt:0,attempts:0,syncChecked:job.issue.status==='resolved',syncedStatusVersion:0})
        }catch(e){failed(id,e)}
      }
      // Read all linked checkboxes with a paginated list, not one request per Pi or per issue.
      for(const [id,job] of due.filter(([,j])=>j.sentAt)){
        try{await reconcile(id,items.find(x=>x.id===job.blockId))}catch(e){failed(id,e)}
      }
    }catch(e){for(const [id] of due)failed(id,e)}finally{busy=false}
  }
  function start(){if(!timer){timer=setInterval(()=>void flush().catch(()=>{}),30000);timer.unref();void flush().catch(()=>{})}}
  function stop(){clearInterval(timer);timer=null}
  return {status,configure,flush,start,stop}
}
module.exports={createNotionSync,issueBlock,PAGE_ID}
