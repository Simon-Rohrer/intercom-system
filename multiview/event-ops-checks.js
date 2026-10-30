'use strict'
const net = require('net')
const tcp = (host,port) => new Promise(resolve=>{
  if(!host || !port)return resolve(false)
  const socket=net.createConnection({host,port:Number(port)});let done=false
  const finish=ok=>{if(done)return;done=true;socket.destroy();resolve(ok)}
  socket.setTimeout(1200,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false))
})
function createOpsChecks({getConfig, getAtem, getPp, churchTools, kesherChat}) {
  const lastOk=new Map()
  return async()=>{
    const c=getConfig(),ct=churchTools.snapshot(),chat=kesherChat.snapshot(),atem=getAtem(),pp=getPp()
    const rows=[]
    const add=(id,name,status,detail,steps,more={})=>rows.push({id,name,status,detail,steps,defaultRequired:true,...more})
    add('jms','JMS Control','ok','Web-Anwendung antwortet.','Bei Darstellungsproblemen die Seite neu laden. Keine Browserdaten während der Veranstaltung löschen.')
    add('kesher','Kesher','connected'===chat.state?'ok':'error',chat.state==='connected'?'Chat-Verbindung aufgebaut.':'JMS Control hat keine aktive Chat-Verbindung.','Kesher öffnen. Ist die gewünschte Station angemeldet? Headset und Sprechprobe vor Ort prüfen.',{href:'https://192.168.0.230:8443/'})
    add('churchtools','ChurchTools',ct.state==='connected'?'ok':'error',ct.state==='connected'?'Verbindung zur Ablaufplanung vorhanden.':'Die Verbindung zur Ablaufplanung ist unterbrochen.','Internetverbindung und ChurchTools-Zugang unter Einstellungen prüfen.')
    add('atem','ATEM-Steuerung',atem.connected?'ok':c.atem.ip?'error':'unknown',atem.connected?'ATEM-Steuerprotokoll verbunden.':'Keine ATEM-Steuerverbindung.','Stromversorgung, Netzwerkkabel und konfigurierte ATEM-Adresse prüfen. Eine Steuerverbindung bestätigt kein Kamerabild.',{defaultRequired:!!c.atem.ip})
    const ppPort=await tcp(c.propresenter.host,c.propresenter.port)
    add('pp-port','ProPresenter-Netzwerk',ppPort?'ok':'error',ppPort?'Der konfigurierte ProPresenter-Port antwortet.':'Der konfigurierte ProPresenter-Port antwortet nicht.','Rechner eingeschaltet? ProPresenter gestartet? Netzwerksteuerung und Port in ProPresenter prüfen.',{defaultRequired:!!c.propresenter.host})
    add('propresenter','ProPresenter-Steuerung',pp.connected?'ok':'error',pp.connected?'ProPresenter liefert Anwendungsdaten.':'Keine aktuellen ProPresenter-Anwendungsdaten.','Wenn der Netzwerk-Port erreichbar ist: API-Einstellungen in ProPresenter und JMS Control vergleichen.',{defaultRequired:!!c.propresenter.host})
    try {
      const res=await fetch('http://127.0.0.1:8000/api/connections',{signal:AbortSignal.timeout(1800)})
      if(!res.ok)throw Error('HTTP')
      const connections=await res.json();if(!Array.isArray(connections))throw Error('shape')
      add('companion','Companion','ok','Companion antwortet mit dem Verbindungsstatus.','Companion öffnen und die betroffene Verbindung kontrollieren.',{href:'https://192.168.0.230:8000/'})
      for(const x of connections.filter(x=>x.enabled && !/youtube|monarch/.test(x.moduleId || ''))) {
        const status=x.status?.category==='good'?'ok':x.status?.category==='error'?'error':'unknown'
        add('connection:'+x.id,x.label || x.moduleId,status,status==='ok'?'Companion-Modul meldet betriebsbereit. Gerätefunktion vor Ort prüfen.':'Companion-Modul meldet keine betriebsbereite Verbindung.',
          'In Companion → Connections diese Verbindung öffnen. Zielgerät, Stromversorgung, Netzwerk und Einstellungen prüfen. Der Modulstatus allein bestätigt kein Ausgangssignal.',{defaultRequired:false,via:'companion',module:x.moduleId})
      }
    }catch {add('companion','Companion','error','Companion-Verbindungsstatus nicht abrufbar.','Im Dashboard Companion öffnen. Den Dienststatus im Admin-Bereich prüfen.')}
    try {
      const d=await kesherChat.raspberryPis()
      for(const client of c.raspberry.clients || []) {
        const p=(d.stations || []).find(s=>s.deviceId===client.deviceId)
        add('pi:'+client.id,client.name || client.id,client.standby?'idle':p?.online&&p?.intercomConnected?'ok':p?.online?'warn':'error',client.standby?'Geplanter Ruhemodus.':p?.online?(p.intercomConnected?'Station und Intercom verbunden.':'Station erreichbar, aber nicht im Intercom.'): 'Keine aktuelle Stationsmeldung.',
          'Stromversorgung und Netzwerk am Pi prüfen. Danach in JMS Control → Raspberry Pis die Station und ihre Rolle prüfen.',{defaultRequired:!client.standby})
      }
    }catch {if(c.raspberry.clients?.length)add('pi-status','Raspberry-Stationen','unknown','Stationsstatus derzeit nicht abrufbar.','Kesher-Verbindung und die Stationsübersicht prüfen.')}
    add('manual-decks','Stream Decks – Bedienprobe','unknown','Noch nicht vor Ort bestätigt.','Richtige Seite und Beschriftung kontrollieren. Einen dafür vorgesehenen, unkritischen Testknopf prüfen.',{manual:true,defaultRequired:false})
    add('manual-led','LED-Wand – Bildkontrolle','unknown','Noch nicht vor Ort bestätigt.','Rechner und LED-Steuerung prüfen. Testbild direkt an der Wand kontrollieren.',{manual:true,defaultRequired:false,via:'companion'})
    add('manual-stage','Stage Display – Bildkontrolle','unknown','Noch nicht vor Ort bestätigt.','In ProPresenter die Ausgabezuordnung prüfen und das Bild direkt am Bühnenmonitor kontrollieren.',{manual:true,defaultRequired:false,via:'propresenter'})
    for(const r of rows){if(r.status==='ok')lastOk.set(r.id,new Date().toISOString());r.lastOk=lastOk.get(r.id)||null}
    return rows
  }
}
module.exports={createOpsChecks}
