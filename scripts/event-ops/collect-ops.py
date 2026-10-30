#!/usr/bin/env python3
"""Read-only infrastructure observations. No service controls, no credential values in output."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, tempfile
DATA=pathlib.Path('/var/lib/docker/volumes/multiview_multiview-data/_data')
PRIVATE=pathlib.Path('/var/lib/jms-ops')

def at(ts=None):
 return datetime.datetime.fromtimestamp(ts,datetime.timezone.utc).isoformat() if ts else datetime.datetime.now(datetime.timezone.utc).isoformat()
def command(args):
 try:return subprocess.run(args,capture_output=True,text=True,timeout=8).stdout.strip()
 except Exception:return ''
def write(file,data,mode=0o600,uid=None):
 file.parent.mkdir(parents=True,exist_ok=True)
 fd,name=tempfile.mkstemp(dir=file.parent)
 with os.fdopen(fd,'w') as f:json.dump(data,f)
 os.chmod(name,mode)
 if uid is not None:os.chown(name,uid,uid)
 os.replace(name,file)

def main():
 PRIVATE.mkdir(mode=0o700,exist_ok=True)
 try: previous=json.loads((PRIVATE/'state.json').read_text())
 except FileNotFoundError:previous={'hashes':{},'changes':[],'lastOk':{}}
 rows=[]
 def check(id,name,status,detail,steps):
  if status=='ok':previous['lastOk'][id]=at()
  rows.append(dict(id=id,name=name,status=status,detail=detail,steps=steps,lastOk=previous['lastOk'].get(id),defaultRequired=True))
 usage=shutil.disk_usage(DATA);pct=usage.used/usage.total*100
 check('server-disk','Server-Speicher','error' if pct>95 else 'warn' if pct>85 else 'ok',f'{usage.free/1024**3:.1f} GB frei · {pct:.0f} % belegt.','Im Admin-Dashboard Speicherverbrauch prüfen; Aufnahmen und Sicherungen gezielt archivieren.')
 try:
  containers=json.loads(command(['docker','inspect','multiview','kesher','homepage']))
  for c in containers:
   name=c['Name'].strip('/');s=c['State'];h=s.get('Health',{}).get('Status')
   status='ok' if s.get('Running') and h in [None,'healthy'] else 'warn' if h=='starting' else 'error'
   check('container:'+name,{'multiview':'JMS-Container','kesher':'Kesher-Container','homepage':'Dashboard-Container'}[name],status,'Container läuft'+(' · '+h if h else '') if s.get('Running') else 'Container läuft nicht.','In Portainer die Container-Protokolle prüfen. Neustart nur gezielt außerhalb kritischer Abläufe.')
 except Exception:check('containers','Containerstatus','unknown','Docker-Status konnte nicht gelesen werden.','Portainer und die Server-Erfassung prüfen.')
 backups=[]
 full=sorted(pathlib.Path('/home/master/backups').glob('full-*'),reverse=True)
 for key,name,rel in [('jms','JMS Control','volumes/multiview_multiview-data.tgz'),('kesher','Kesher','volumes/compose_intercom_data.tgz'),('companion','Companion','companion.tgz')]:
  found=next((p/rel for p in full if (p/rel).is_file()),None)
  backups.append({'id':key,'name':name,'at':at(found.stat().st_mtime) if found else None,'detail':f'Lokales Archiv: {found.parent.parent.name if key!="companion" else found.parent.name} · {found.stat().st_size/1024**2:.1f} MB' if found else 'Kein vollständiges Archiv am bekannten Sicherungsort gefunden.','restore':'Nicht als getestet nachgewiesen'})
 module_archive=pathlib.Path('/home/master/event-ops-20261030/private-backup/companion-custom-modules.tar.gz')
 backups.append({'id':'modules','name':'Eigene Companion-Module','at':at(module_archive.stat().st_mtime) if module_archive.exists() else None,'detail':'Gemeinsames lokales Archiv: Entwicklungsstände, installierte eigene Module und Update-Schutz.' if module_archive.exists() else 'Vollständiges gemeinsames Archiv noch nicht nachgewiesen.','restore':'Archiv vor Einspielung lesend geprüft; Wiederherstellung nicht getestet'})
 watched={
  'JMS-Einstellungen':DATA/'config.json',
  'JMS-Veranstaltungsoberfläche':pathlib.Path('/home/master/intercom-system/multiview/public/event-ops.js'),
  'JMS-Serveranwendung':pathlib.Path('/home/master/intercom-system/multiview/server.js'),
  'Dashboard-Oberfläche':pathlib.Path('/opt/homelab/config/homepage/custom.js'),
  'Companion-Konfiguration':pathlib.Path('/home/companion/.config/companion-nodejs/v5.0/db.sqlite'),
 }
 for p in pathlib.Path('/opt/companion-module-dev').glob('*/package.json'):watched['Companion-Modul '+p.parent.name]=p
 for p in pathlib.Path('/opt/companion-module-dev').glob('*/main.js'):watched['Companion-Code '+p.parent.name]=p
 for label,p in watched.items():
  if not p.is_file():continue
  digest=hashlib.sha256(p.read_bytes()).hexdigest();old=previous['hashes'].get(label)
  if old and old!=digest:previous['changes'].insert(0,dict(at=at(),text=label+' geändert (Dateistand)',by='Server-Erfassung'))
  previous['hashes'][label]=digest
 previous['changes']=previous['changes'][:80]
 # Read-only timer status; never enable or run backup (the existing job stops production services).
 timer=command(['systemctl','is-active','jms-backup-cloud.timer'])
 report={'at':at(),'checks':rows,'backups':backups,'backupTimer':'active' if timer=='active' else 'inactive' if timer=='inactive' else 'unknown','changes':previous['changes']}
 write(PRIVATE/'state.json',previous)
 write(DATA/'ops-infra.json',report,uid=1000)
if __name__=='__main__':main()
