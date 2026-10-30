'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')

const STATES = ['preparing', 'ready', 'help']
const ISSUE_STATES = ['open', 'working', 'resolved']
const text = (x, max = 500) => String(x ?? '').trim().slice(0, max)
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const stamp = () => new Date().toISOString()
const changedAt = previous => new Date(Math.max(Date.now(),Date.parse(previous || '1970-01-01')+1)).toISOString()
function technicalTeam(event, services, groups) {
  const techGroups = new Set(groups.filter(g => /technik|technical|production/i.test(g.nameTranslated || g.name)).map(g => String(g.id)))
  const defs = new Map(services.filter(s => techGroups.has(String(s.serviceGroupId))).map(s => [String(s.id), s]))
  return (event.eventServices || []).filter(s => defs.has(String(s.serviceId)) && s.isValid !== false).map(s => {
    const def = defs.get(String(s.serviceId)), p = s.person
    return { id: String(s.id), serviceId: String(s.serviceId), service: text(def.nameTranslated || def.name, 100),
      slot: s.index || null, name: def.hidePersonName ? 'Name in ChurchTools verborgen' : text(p?.title || s.name || '', 150),
      assigned: Boolean(p || s.personId || s.name), accepted: s.isAccepted === true, sort: def.sortKey ?? 0 }
  }).sort((a,b) => a.sort - b.sort || (a.slot || 0) - (b.slot || 0))
}
function createEventOps({ dataDir, churchTools, getRoles, getChecks = async () => [], now = Date.now }) {
  const file = path.join(dataDir, 'event-ops.json')
  let state
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); if (state.version !== 1 || !state.events || !Array.isArray(state.issues)) throw new Error('Invalid operations state') }
  catch(e) { if(e.code !== 'ENOENT') throw e; state = {version:1, revision:0, selectedEventId:'', events:{}, issues:[], history:[]} }
  let catalog = {at:0, events:[], error:''}, catalogFlight, teamFlight
  let teamCache = {id:'', at:0, rows:[], error:''}
  const agendaCache = new Map(), agendaFlights = new Map()
  let checksCache = {at:0, rows:[]}, checksFlight
  function save(change, actor, description) {
    const next = structuredClone(state)
    change(next)
    next.revision++
    next.history.unshift({at:stamp(), by:text(actor?.name || 'Admin',100), text:description})
    next.history = next.history.slice(0,250)
    fs.mkdirSync(dataDir, {recursive:true})
    fs.writeFileSync(file+'.tmp', JSON.stringify(next), {mode:0o600})
    fs.renameSync(file+'.tmp',file)
    state = next
  }
  function eventData(s,id) { return s.events[id] ||= {note:'', ready:{}, required:null, manual:{}} }
  const roles = () => getRoles().filter(r => !r.chatOnly && !['admin','chat-monitor'].includes(r.id) && /licht|ton|audio|kamera|camera|regie|producer|presenter|livestream|technik/i.test(r.name || r.id))
  async function events() {
    if (catalog.at && now()-catalog.at < 60000) return catalog
    catalogFlight ||= (async()=>{
      try {
        const from = new Date(now()-86400000).toISOString().slice(0,10), to = new Date(now()+28*86400000).toISOString().slice(0,10)
        let rows=[]
        for(let page=1;page<=10;page++) {
          const d=await churchTools.api(`/events?from=${from}&to=${to}&limit=100&page=${page}`)
          const batch=d.data || [];rows.push(...batch)
          if(!d.meta?.pagination || page>=d.meta.pagination.lastPage || batch.length<100)break
        }
        catalog = {at:now(), error:'', events:rows.filter(e=>!e.isCanceled).map(e=>({id:String(e.id),name:text(e.name,200),startDate:e.startDate,endDate:e.endDate})).sort((a,b)=>Date.parse(a.startDate)-Date.parse(b.startDate))}
      } catch(e) { catalog={...catalog, at:now(), error:'ChurchTools-Veranstaltungen konnten nicht aktualisiert werden. Der letzte geladene Stand bleibt sichtbar.'} }
      return catalog
    })().finally(()=>{catalogFlight=null})
    return catalogFlight
  }
  function selected() {
    const running=Object.values(state.events).map(e=>e.playback).filter(p=>p?.mode==='manual' && p.event).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0]
    return catalog.events.find(e=>e.id===state.selectedEventId) || (!state.selectedEventId && running?.event) || catalog.events.find(e=>Date.parse(e.endDate || e.startDate)>now()) || null
  }
  async function team(id) {
    if(!id)return {rows:[],error:'',at:0}
    if(teamCache.id===id && now()-teamCache.at<60000)return teamCache
    if(teamFlight) { await teamFlight; return team(id) }
    teamFlight=(async()=>{
      try {
        const [event, services, groups]=await Promise.all([churchTools.api('/events/'+encodeURIComponent(id)),churchTools.api('/services'),churchTools.api('/servicegroups')])
        teamCache={id,at:now(),updatedAt:now(),rows:technicalTeam(event.data,services.data || [],groups.data || []),error:''}
      }catch(e){teamCache={id,at:now(),updatedAt:teamCache.id===id?teamCache.updatedAt:0,rows:teamCache.id===id?teamCache.rows:[],error:'Technikeinteilung derzeit nicht abrufbar. ChurchTools-Verbindung und Leserechte prüfen.'}}
      return teamCache
    })().finally(()=>{teamFlight=null})
    return teamFlight
  }
  async function eventAgenda(event) {
    if(!event)return {items:[],error:'',updatedAt:null}
    const cached=agendaCache.get(event.id)
    if(cached && cached.startDate===event.startDate && now()-cached.at<60000)return cached
    if(agendaFlights.has(event.id))return agendaFlights.get(event.id)
    const flight=(async()=>{
      let result
      try {
        const d=await churchTools.agendaForEvent(event)
        const items=(d.agenda?.items || []).filter(i=>String(i.title || i.song?.title || '').trim() || Number(i.duration)>0 || String(i.note || '').trim() || String(i.responsible || '').trim() || i.columns?.some(c=>String(c.note || '').trim()))
        result={eventId:event.id,startDate:event.startDate,at:now(),updatedAt:new Date(now()).toISOString(),items,name:d.agenda?.name || '',error:d.agendaError || '',stale:false}
      }catch {
        result={eventId:event.id,startDate:event.startDate,at:now(),updatedAt:cached?.updatedAt || null,items:cached?.items || [],error:'Der Ablauf konnte nicht aktualisiert werden. ChurchTools-Verbindung und Leserechte prüfen.',stale:true}
      }
      agendaCache.set(event.id,result)
      while(agendaCache.size>8)agendaCache.delete(agendaCache.keys().next().value)
      return result
    })().finally(()=>agendaFlights.delete(event.id))
    agendaFlights.set(event.id,flight)
    return flight
  }
  async function overview(user) {
    await events()
    const event=selected(), [t,agenda]=await Promise.all([team(event?.id),eventAgenda(event)]), data=event ? state.events[event.id] || {} : {}
    const all=roles()
    return {ok:true, revision:state.revision, admin:!!user.admin, roleId:user.roleId, selectedEventId:state.selectedEventId, events:catalog.events, event,
      agenda:data.playback?.mode==='manual'?{...agenda,items:data.playback.items,updatedAt:data.playback.agendaUpdatedAt,error:'',stale:false}:agenda, playback:data.playback || null, serverNow:new Date(now()).toISOString(), error:catalog.error, team:t.rows, teamError:t.error, teamUpdatedAt:t.updatedAt ? new Date(t.updatedAt).toISOString():null,
      note:data.note || '', roles:all.map(r=>({id:r.id,name:r.name})), ready:data.ready || {},
      churchtoolsUrl:churchTools.snapshot().url || ''}
  }
  function current(id) { const e=selected(); if(!e || String(id)!==e.id)fail('Die ausgewählte Veranstaltung hat sich geändert. Bitte aktualisieren.',409);return e.id }
  async function mutateEvent(user,body) {
    await events(); if(!user.admin)fail('Nur der Admin kann die Veranstaltung ändern.',403)
    if(body.revision!==state.revision)fail('Inzwischen gab es Änderungen. Bitte aktualisieren und erneut speichern.',409)
    if(body.action==='select') {
      const id=text(body.eventId,80)
      if(id && !catalog.events.some(e=>e.id===id))fail('Veranstaltung nicht in der aktuellen Liste.')
      save(s=>{s.selectedEventId=id},user,id?'Veranstaltung ausgewählt':'Automatische Veranstaltungsauswahl aktiviert')
    } else if(body.action==='note') {
      const id=current(body.eventId)
      save(s=>{eventData(s,id).note=text(body.note,2000)},user,'Veranstaltungshinweis geändert')
    }else fail('Unbekannte Aktion')
  }
  async function playback(user,body) {
    if(!user.admin)fail('Nur der Admin darf den Ablauf weiterschalten.',403)
    await events();current(body.eventId)
    const event=selected(), agenda=body.action==='start'?await eventAgenda(event):null
    const id=current(body.eventId),prev=state.events[id]?.playback
    if((body.previous || '')!==(prev?.updatedAt || ''))fail('Der Ablauf wurde inzwischen weitergeschaltet. Bitte aktualisieren.',409)
    const at=new Date(now()).toISOString(),updatedAt=changedAt(prev?.updatedAt)
    let next
    if(body.action==='auto') {
      next={mode:'auto',updatedAt}
    }else if(body.action==='start') {
      if(prev?.mode==='manual')fail('Die manuelle Steuerung läuft bereits.',409)
      if(agenda.error || !agenda.items.length)fail('Zum Starten wird ein aktueller ChurchTools-Ablauf benötigt.')
      const index=Number(body.index)
      if(!Number.isInteger(index) || !agenda.items[index] || agenda.items[index].type==='header')fail('Bitte einen Ablaufpunkt auswählen.')
      next={mode:'manual',event:structuredClone(event),agendaUpdatedAt:agenda.updatedAt,items:structuredClone(agenda.items),steps:[{index,at}],endedAt:null,updatedAt}
    }else {
      if(prev?.mode!=='manual')fail('Bitte zuerst die manuelle Steuerung starten.',409)
      next=structuredClone(prev);next.updatedAt=updatedAt
      if(body.action==='next') {
        if(next.endedAt)fail('Der Ablauf ist bereits beendet.',409)
        const index=next.items.findIndex((item,i)=>i>next.steps.at(-1).index && item.type!=='header')
        if(index<0)next.endedAt=at;else next.steps.push({index,at})
      }else if(body.action==='back') {
        if(next.endedAt)next.endedAt=null
        else if(next.steps.length>1)next.steps.pop()
        else fail('Es gibt noch keinen vorherigen manuellen Schritt.')
      }else fail('Unbekannte Ablaufaktion')
    }
    next.by=text(user.name || 'Admin',100)
    save(s=>{eventData(s,id).playback=next},user,'Ablaufsteuerung: '+({start:'manuell gestartet',next:next.endedAt?'beendet':'weitergeschaltet',back:'letzten Schritt zurückgenommen',auto:'CT-Zeitplan wieder aktiviert'}[body.action]))
  }
  async function ready(user,body) {
    await events();const id=current(body.eventId), role=text(body.roleId,100)
    if(!roles().some(r=>r.id===role))fail('Diese Rolle ist nicht für die Technikbereitschaft vorgesehen.')
    if(!user.admin && role!==user.roleId)fail('Du kannst nur deine eigene Rolle melden.',403)
    if(!STATES.includes(body.status))fail('Ungültiger Bereitschaftsstatus')
    const prev=state.events[id]?.ready?.[role]
    if((body.previous || '')!==(prev?.at || ''))fail('Diese Bereitschaft wurde inzwischen geändert. Bitte aktualisieren.',409)
    save(s=>{eventData(s,id).ready[role]={status:body.status,note:text(body.note,300),by:text(user.name || 'Admin',100),at:changedAt(prev?.at)}},user,`Bereitschaft für ${roles().find(r=>r.id===role)?.name || role} geändert`)
  }
  function infrastructure() {
    try {const d=JSON.parse(fs.readFileSync(path.join(dataDir,'ops-infra.json'),'utf8'));return {...d,stale:now()-Date.parse(d.at)>180000}}
    catch {return {at:null,stale:true,checks:[],backups:[],changes:[],backupTimer:'unknown'}}
  }
  async function checks() {
    if(checksCache.at && now()-checksCache.at<15000)return checksCache.rows
    checksFlight ||= Promise.resolve(getChecks()).then(rows=>{checksCache={at:now(),rows};return rows}).finally(()=>checksFlight=null)
    return checksFlight
  }
  async function diagnostics(user) {
    await events();const event=selected(), infra=infrastructure(), live=await checks()
    const rows=[...live,...(infra.checks || []).map(c=>({...c,status:infra.stale?'unknown':c.status,detail:infra.stale?'Statusdaten sind veraltet. Erfassung auf dem Server prüfen.':c.detail}))]
    const required=event ? state.events[event.id]?.required : null
    for (const id of required || []) if(!rows.some(c=>c.id===id)) rows.push({id,name:state.events[event.id]?.requirementLabels?.[id] || 'Benötigtes System ohne Rückmeldung',status:'unknown',detail:'Dieses benötigte System wird aktuell nicht mehr gemeldet.',steps:'Verbindung bzw. Erfassung prüfen. Nur aus der Auswahl entfernen, wenn das System für diese Veranstaltung tatsächlich nicht benötigt wird.'})
    for (const c of rows) if(c.manual) { const m=state.events[event?.id]?.manual?.[c.id]; if(m)Object.assign(c,{status:m.status,detail:m.status==='ok'?'Vor Ort bestätigt: '+m.by:'Vor Ort als fehlerhaft gemeldet: '+m.by,lastOk:m.status==='ok'?m.at:null,observedAt:m.at}) }
    return {ok:true,admin:!!user.admin,event,revision:state.revision,at:stamp(),checks:rows.map(c=>({...c,required:Array.isArray(required)?required.includes(c.id):c.defaultRequired===true})),
      infraAt:infra.at,infraStale:infra.stale,backups:infra.backups || [],backupTimer:infra.backupTimer,
      changes:infra.changes || [],history:state.history.slice(0,30)}
  }
  async function requirements(user,body) {
    if(!user.admin)fail('Nur der Admin kann den Startcheck konfigurieren.',403)
    await events();const id=current(body.eventId)
    if(body.revision!==state.revision)fail('Inzwischen gab es Änderungen. Bitte aktualisieren.',409)
    const d=await diagnostics(user), valid=new Set(d.checks.map(c=>c.id))
    if(!Array.isArray(body.required) || body.required.length>200 || body.required.some(id=>!valid.has(id)))fail('Ungültige Geräteliste')
    save(s=>{const e=eventData(s,id);e.required=[...new Set(body.required)];e.requirementLabels=Object.fromEntries(d.checks.filter(c=>e.required.includes(c.id)).map(c=>[c.id,c.name || c.id]))},user,'Benötigte Systeme für den Startcheck geändert')
  }
  async function manual(user,body) {
    if(!user.admin)fail('Nur der Admin kann die Geräteprüfung bestätigen.',403)
    await events(); const id=current(body.eventId)
    if(!['ok','error','unknown'].includes(body.status) || !(await checks()).some(c=>c.id===body.checkId && c.manual))fail('Ungültige Geräteprüfung')
    save(s=>{(eventData(s,id).manual ||= {})[body.checkId]={status:body.status,by:text(user.name,100),at:stamp()}},user,'Sichtprüfung eines Geräts aktualisiert')
  }
  function issues(user) { return {ok:true, admin:!!user.admin,issues:state.issues.map(x=>({...x,canEdit:!!user.admin || x.owner===user.roleId})),event:selected()} }
  function photoData(value) {
    if(!value)return null
    const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(value)
    if(!m)fail('Bitte ein JPEG-, PNG- oder WebP-Bild verwenden.')
    const b=Buffer.from(m[2],'base64')
    if(b.length>1500000)fail('Das Foto darf höchstens 1,5 MB groß sein.')
    const valid=m[1]==='jpeg'?b[0]===255&&b[1]===216&&b[2]===255:m[1]==='png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'
    if(!valid)fail('Das Fotoformat konnte nicht erkannt werden.')
    return {bytes:b,ext:m[1]}
  }
  function changeIssue(user,body) {
    const old=body.id?state.issues.find(x=>x.id===body.id):null
    if(body.id && !old)fail('Mangel nicht gefunden.',404)
    if(old && !user.admin && old.owner!==user.roleId)fail('Nur deine Rolle oder der Admin darf diesen Mangel bearbeiten.',403)
    if(old && old.updatedAt!==body.previous)fail('Der Eintrag wurde inzwischen geändert. Bitte aktualisieren.',409)
    if(!old && state.issues.length>=300)fail('Die Mängelliste enthält bereits 300 Einträge. Bitte den Admin informieren.')
    const title=text(body.title,140),device=text(body.device,120),description=text(body.description,2000),assignee=text(body.assignee,120)
    if(!title || !device)fail('Bitte Gerät und Kurzbeschreibung eintragen.')
    if(!ISSUE_STATES.includes(body.status || 'open'))fail('Ungültiger Bearbeitungsstatus')
    if(!['normal','urgent'].includes(body.priority || 'normal'))fail('Ungültige Dringlichkeit')
    const id=old?.id || crypto.randomUUID(), photo=photoData(body.photo), at=changedAt(old?.updatedAt)
    let photoName=old?.photo || ''
    if(photo){fs.mkdirSync(path.join(dataDir,'ops-photos'),{recursive:true});photoName=crypto.randomUUID()+'.'+photo.ext;fs.writeFileSync(path.join(dataDir,'ops-photos',photoName),photo.bytes,{mode:0o600})}
    const item={id,title,device,description,assignee,priority:body.priority || 'normal',status:body.status || 'open',photo:photoName,
      owner:old?.owner || user.roleId,createdBy:old?.createdBy || text(user.name,100),createdAt:old?.createdAt || at,updatedBy:text(user.name,100),updatedAt:at,
      eventId:old?.eventId || selected()?.id || '',eventName:old?.eventName || selected()?.name || ''}
    save(s=>{if(old)s.issues[s.issues.findIndex(x=>x.id===id)]=item;else s.issues.unshift(item)},user,`Mangel ${old?'aktualisiert':'erfasst'}: ${title}`)
    return {ok:true,id}
  }
  const photoFile=name=>/^[a-f0-9-]{36}\.(jpeg|png|webp)$/.test(name)?path.join(dataDir,'ops-photos',name):null
  return {overview,mutateEvent,playback,ready,diagnostics,requirements,manual,issues,changeIssue,photoFile}
}
function eventOpsRouter(ops, requireUser, requireAdmin) {
  const r=express.Router()
  r.use(requireUser, (req,res,next)=>{res.set('Cache-Control','no-store');if(req.user.chatOnly)return res.status(403).json({ok:false,error:'Diese Rolle darf ausschließlich chatten'});next()})
  const run=fn=>(req,res)=>Promise.resolve().then(()=>fn(req,res)).catch(e=>res.status(e.status || 500).json({ok:false,error:e.status?e.message:'Die Daten konnten nicht verarbeitet werden. Bitte erneut versuchen.'}))
  r.get('/overview',run(async(req,res)=>res.json(await ops.overview(req.user))))
  r.post('/event',requireAdmin,run(async(req,res)=>{await ops.mutateEvent(req.user,req.body);res.json({ok:true})}))
  r.post('/playback',requireAdmin,run(async(req,res)=>{await ops.playback(req.user,req.body);res.json({ok:true})}))
  r.post('/ready',run(async(req,res)=>{await ops.ready(req.user,req.body);res.json({ok:true})}))
  r.get('/diagnostics',requireAdmin,run(async(req,res)=>res.json(await ops.diagnostics(req.user))))
  r.post('/requirements',requireAdmin,run(async(req,res)=>{await ops.requirements(req.user,req.body);res.json({ok:true})}))
  r.post('/manual',requireAdmin,run(async(req,res)=>{await ops.manual(req.user,req.body);res.json({ok:true})}))
  r.get('/issues',run((req,res)=>res.json(ops.issues(req.user))))
  r.post('/issues',run((req,res)=>res.json(ops.changeIssue(req.user,req.body))))
  r.get('/photos/:name',run((req,res)=>{const file=ops.photoFile(req.params.name);if(!file || !fs.existsSync(file))return res.status(404).end();res.sendFile(file)}))
  return r
}
module.exports={createEventOps,eventOpsRouter,technicalTeam}
