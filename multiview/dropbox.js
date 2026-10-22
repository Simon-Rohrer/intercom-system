'use strict'

// Dropbox-Ordner für die Diashow: JMS Control lauscht auf einen Ordner (Longpoll von Dropbox) und
// holt jedes Bild, das dort hineinkommt, sofort als JPEG/PNG (über die Vorschau-Schnittstelle von
// Dropbox – damit gehen auch HEIC-Fotos vom iPhone). Gelöschte Bilder verschwinden wieder.
//
// Anmeldung: eigene Dropbox-App (nur App-Key, kein Geheimnis) mit OAuth-Code und PKCE ohne
// Weiterleitung – Dropbox zeigt einen Code, den man in JMS Control einfügt. Danach bleibt ein
// Refresh-Token in dropbox-secret.json im Datenordner (Rechte 600), nie im Browser.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const API = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const NOTIFY = 'https://notify.dropboxapi.com/2'
const OAUTH = 'https://api.dropboxapi.com/oauth2/token'
const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize'
const TIMEOUT_MS = 20_000
const LONGPOLL_S = 120
const RETRY_MS = 30_000
const RESYNC_MS = 30 * 60 * 1000 // zur Sicherheit ab und zu alles neu abgleichen
const MAX_IMAGES = 200
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|tiff?|bmp)$/i

/** Ordnerpfad wie Dropbox ihn will: "" (ganz oben) oder "/Ordner/Unterordner" */
function normalizeFolder(input) {
  const text = String(input ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')
  if (!text || text === '/') return ''
  return text.startsWith('/') ? text : `/${text}`
}

const fileName = (entry) => `${crypto.createHash('sha1').update(`${entry.id}:${entry.rev}`).digest('hex').slice(0, 20)}.${/\.png$/i.test(entry.name) ? 'png' : 'jpg'}`

function createDropbox({ dataDir, onUpdate = () => {}, log = () => {}, fetchImpl = fetch, now = Date.now }) {
  const secretFile = path.join(dataDir, 'dropbox-secret.json')
  const stateFile = path.join(dataDir, 'dropbox-state.json')
  const dir = path.join(dataDir, 'dropbox')
  fs.mkdirSync(dir, { recursive: true })

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = (file, value, mode = 0o644) => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode })
    fs.renameSync(tmp, file)
  }

  let secret = readJson(secretFile)
  const saved = readJson(stateFile) || {}
  let cursor = typeof saved.cursor === 'string' && saved.folder === secret?.folder ? saved.cursor : ''
  let files = (Array.isArray(saved.files) && saved.folder === secret?.folder ? saved.files : []).filter((f) => fs.existsSync(path.join(dir, f.file)))
  let state = secret?.refreshToken ? (secret.folder != null ? 'connecting' : 'nofolder') : 'unconfigured'
  let error = ''
  let lastChange = Number(saved.lastChange) || 0
  let pending = null // { appKey, verifier, at } – Anmeldung läuft
  let accessToken = ''
  let accessExpires = 0
  let running = false
  let generation = 0 // neuer Ordner/Abmelden: alte Schleifen beenden sich
  let timer = null
  let syncing = null

  const persist = () => writeJson(stateFile, { folder: secret?.folder ?? null, cursor, files, lastChange })
  const saveSecret = () => {
    fs.mkdirSync(dataDir, { recursive: true })
    writeJson(secretFile, secret, 0o600)
  }

  function snapshot() {
    return {
      state,
      error,
      folder: secret?.folder ?? null,
      lastChange,
      images: files.map((f) => ({ id: f.id, url: `/diashow/dropbox/${f.file}`, name: f.name, modified: f.modified, added: f.added })),
    }
  }
  const changed = () => {
    persist()
    onUpdate(snapshot())
  }

  async function request(url, { body, headers = {}, raw = false, auth = true } = {}) {
    const h = { ...headers }
    if (auth) h.Authorization = `Bearer ${await token()}`
    let res
    try {
      res = await fetchImpl(url, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(url.startsWith(NOTIFY) ? (LONGPOLL_S + 30) * 1000 : TIMEOUT_MS) })
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'Dropbox antwortet nicht' : 'Dropbox nicht erreichbar (Internet?)')
    }
    if (res.status === 401) accessToken = ''
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let summary = ''
      try {
        summary = JSON.parse(text).error_summary || ''
      } catch {
        summary = text.slice(0, 120)
      }
      throw Object.assign(new Error(dropboxError(res.status, summary)), { status: res.status, summary })
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json()
  }

  function dropboxError(status, summary) {
    if (/path\/not_found|path_lookup\/not_found/.test(summary)) return 'Ordner gibt es in der Dropbox nicht (mehr)'
    if (/missing_scope/.test(summary)) return 'Der Dropbox-App fehlen Rechte: files.metadata.read und files.content.read anhaken, dann neu verbinden'
    if (/expired_access_token|invalid_access_token/.test(summary) || status === 401) return 'Dropbox-Anmeldung ungültig – bitte neu verbinden'
    if (status === 429) return 'Dropbox bremst (zu viele Anfragen) – gleich wieder'
    return `Dropbox antwortet mit Fehler ${status}${summary ? `: ${summary}` : ''}`
  }

  const rpc = (endpoint, args) => request(`${API}/${endpoint}`, { body: JSON.stringify(args ?? null), headers: { 'Content-Type': 'application/json' } })

  async function oauth(params) {
    let res
    try {
      res = await fetchImpl(OAUTH, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      throw new Error('Dropbox nicht erreichbar (Internet?)')
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.access_token) {
      const code = body.error || ''
      throw Object.assign(
        new Error(
          code === 'invalid_grant'
            ? 'Der Code ist falsch, abgelaufen oder schon benutzt – bitte noch einmal „Mit Dropbox verbinden“'
            : code === 'invalid_client' || /client_id/i.test(body.error_description || '')
              ? 'App-Key falsch (in der Dropbox-App unter „Settings“)'
              : body.error_description || code || `Dropbox-Anmeldung fehlgeschlagen (${res.status})`,
        ),
        { code },
      )
    }
    return body
  }

  async function token() {
    if (accessToken && now() < accessExpires) return accessToken
    if (!secret?.refreshToken) throw new Error('Nicht mit Dropbox verbunden')
    try {
      const body = await oauth({ grant_type: 'refresh_token', refresh_token: secret.refreshToken, client_id: secret.appKey })
      accessToken = body.access_token
      accessExpires = now() + (Number(body.expires_in) || 14_400) * 1000 - 60_000
      return accessToken
    } catch (err) {
      if (err.code === 'invalid_grant') {
        // In der Dropbox widerrufen: Anmeldung verwerfen, Ordner und Bilder bleiben bis zum Neuverbinden
        secret = { appKey: secret.appKey, folder: secret.folder }
        saveSecret()
        state = 'unconfigured'
        error = 'Dropbox-Anmeldung wurde widerrufen – bitte neu verbinden'
        log(`Dropbox: ${error}`)
        changed()
      }
      throw err
    }
  }

  // --- Anmeldung ------------------------------------------------------------------------------

  /** Adresse zum Bestätigen bei Dropbox (PKCE, ohne Weiterleitung: Dropbox zeigt danach einen Code) */
  function authorizeUrl(appKey) {
    const key = String(appKey ?? '').trim() || secret?.appKey || ''
    if (!/^[a-z0-9]{8,32}$/i.test(key)) throw new Error('App-Key fehlt (aus der Dropbox-App, Reiter „Settings“)')
    const verifier = crypto.randomBytes(48).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    pending = { appKey: key, verifier, at: now() }
    const query = new URLSearchParams({ client_id: key, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' })
    return `${AUTHORIZE}?${query}`
  }

  /** Code von Dropbox einlösen */
  async function connect(code) {
    if (!pending || now() - pending.at > 30 * 60 * 1000) throw new Error('Bitte zuerst „Mit Dropbox verbinden“ klicken')
    const given = String(code ?? '').trim()
    if (!given) throw new Error('Bitte den Code von Dropbox einfügen')
    const body = await oauth({ grant_type: 'authorization_code', code: given, client_id: pending.appKey, code_verifier: pending.verifier })
    if (!body.refresh_token) throw new Error('Dropbox hat kein Dauer-Token geliefert – bitte noch einmal verbinden')
    secret = { appKey: pending.appKey, refreshToken: body.refresh_token, folder: secret?.folder ?? null, account: { name: '', email: '' } }
    accessToken = body.access_token
    accessExpires = now() + (Number(body.expires_in) || 14_400) * 1000 - 60_000
    pending = null
    try {
      const me = await rpc('users/get_current_account')
      secret.account = { name: String(me.name?.display_name || ''), email: String(me.email || '') }
    } catch {
      // Name ist nur zur Anzeige
    }
    saveSecret()
    error = ''
    state = secret.folder != null ? 'connecting' : 'nofolder'
    log(`Dropbox: verbunden${secret.account.name ? ` (${secret.account.name})` : ''}`)
    restart()
    return settings()
  }

  async function disconnect() {
    if (secret?.refreshToken) await rpc('auth/token/revoke').catch(() => null)
    generation++
    clearTimeout(timer)
    wake?.()
    secret = secret?.appKey ? { appKey: secret.appKey } : null
    if (secret) saveSecret()
    else fs.rmSync(secretFile, { force: true })
    accessToken = ''
    clearFiles()
    state = 'unconfigured'
    error = ''
    changed()
    return settings()
  }

  function clearFiles() {
    for (const f of files) fs.rmSync(path.join(dir, f.file), { force: true })
    files = []
    cursor = ''
  }

  // --- Ordner -----------------------------------------------------------------------------------

  /** Unterordner eines Ordners – für die Auswahl in den Einstellungen */
  async function browse(folder) {
    const p = normalizeFolder(folder)
    const out = []
    let page = await rpc('files/list_folder', { path: p, recursive: false, limit: 500 })
    for (;;) {
      for (const e of page.entries || []) if (e['.tag'] === 'folder') out.push({ name: e.name, path: e.path_display })
      if (!page.has_more || out.length > 500) break
      page = await rpc('files/list_folder/continue', { cursor: page.cursor })
    }
    return { path: p, folders: out.sort((a, b) => a.name.localeCompare(b.name, 'de')) }
  }

  async function setFolder(folder) {
    if (!secret?.refreshToken) throw new Error('Nicht mit Dropbox verbunden')
    const p = normalizeFolder(folder)
    if (p) {
      const meta = await rpc('files/get_metadata', { path: p })
      if (meta['.tag'] !== 'folder') throw new Error('Das ist kein Ordner')
    }
    if (p !== secret.folder) clearFiles()
    secret = { ...secret, folder: p }
    saveSecret()
    state = 'connecting'
    error = ''
    changed()
    restart()
    return settings()
  }

  // --- Abgleich und Lauschen ----------------------------------------------------------------------

  /** Bild als JPEG/PNG holen – die Vorschau-Schnittstelle wandelt auch HEIC, TIFF … */
  async function download(entry) {
    const png = /\.png$/i.test(entry.name)
    const gif = /\.gif$/i.test(entry.name)
    try {
      if (gif) throw new Error('GIF im Original') // sonst ginge die Animation verloren
      return await request(`${CONTENT}/files/get_thumbnail_v2`, {
        headers: { 'Dropbox-API-Arg': JSON.stringify({ resource: { '.tag': 'path', path: entry.id }, format: png ? 'png' : 'jpeg', size: 'w2048h1536', mode: 'fitone_bestfit' }) },
        raw: true,
      })
    } catch (err) {
      if (!/\.(jpe?g|png|gif|webp)$/i.test(entry.name) || entry.size > 25 * 1024 * 1024) throw err
      return request(`${CONTENT}/files/download`, { headers: { 'Dropbox-API-Arg': JSON.stringify({ path: entry.id }) }, raw: true })
    }
  }

  /** Einträge übernehmen: neue/geänderte Bilder holen, gelöschte entfernen */
  async function apply(entries, full) {
    const seen = new Set()
    let touched = false
    const t = now()
    for (const e of entries) {
      const lower = String(e.path_lower || '')
      if (e['.tag'] === 'deleted') {
        // Gelöscht (auch ein ganzer Unterordner – Pfade darunter): wieder raus
        const gone = files.filter((f) => f.pathLower === lower || f.pathLower.startsWith(`${lower}/`))
        for (const f of gone) fs.rmSync(path.join(dir, f.file), { force: true })
        if (gone.length) {
          files = files.filter((f) => !gone.includes(f))
          touched = true
        }
        continue
      }
      if (e['.tag'] !== 'file' || !IMAGE_EXT.test(e.name)) continue
      // Nur Bilder direkt im Ordner, nicht in Unterordnern
      if (lower.slice(0, lower.lastIndexOf('/')) !== String(secret.folder || '').toLowerCase()) continue
      seen.add(e.id)
      const known = files.find((f) => f.id === e.id)
      if (known && known.rev === e.rev) {
        if (known.pathLower !== lower || known.name !== e.name) Object.assign(known, { name: e.name, pathLower: lower }), (touched = true)
        continue
      }
      if (!known && files.length >= MAX_IMAGES) continue
      try {
        const buffer = await download(e)
        const file = fileName(e)
        fs.writeFileSync(path.join(dir, file), buffer)
        if (known) {
          if (known.file !== file) fs.rmSync(path.join(dir, known.file), { force: true })
          Object.assign(known, { name: e.name, rev: e.rev, file, pathLower: lower, modified: Date.parse(e.server_modified) || t })
        } else {
          files.push({ id: e.id, name: e.name, rev: e.rev, file, pathLower: lower, modified: Date.parse(e.server_modified) || t, added: t })
          if (!full) log(`Dropbox: neues Bild „${e.name}“`)
        }
        lastChange = t
        touched = true
      } catch (err) {
        log(`Dropbox: „${e.name}“ nicht geladen – ${err.message}`)
      }
    }
    // Vollständiger Abgleich: was es nicht mehr gibt, fliegt raus
    if (full) {
      const gone = files.filter((f) => !seen.has(f.id))
      for (const f of gone) fs.rmSync(path.join(dir, f.file), { force: true })
      if (gone.length) touched = true
      files = files.filter((f) => seen.has(f.id))
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))
    return touched
  }

  async function sync() {
    if (syncing) return syncing
    syncing = (async () => {
      let full = !cursor
      let page
      try {
        page = full
          ? await rpc('files/list_folder', { path: secret.folder, recursive: false, limit: 500 })
          : await rpc('files/list_folder/continue', { cursor })
      } catch (err) {
        if (!full && /reset/.test(err.summary || '')) {
          cursor = ''
          full = true
          page = await rpc('files/list_folder', { path: secret.folder, recursive: false, limit: 500 })
        } else throw err
      }
      const entries = [...(page.entries || [])]
      while (page.has_more) {
        page = await rpc('files/list_folder/continue', { cursor: page.cursor })
        entries.push(...(page.entries || []))
      }
      cursor = page.cursor
      const touched = await apply(entries, full)
      if (state !== 'ok') log(`Dropbox: lausche auf ${secret.folder || '/'} (${files.length} Bilder)`)
      state = 'ok'
      error = ''
      if (touched || full) changed()
      else persist()
    })()
    try {
      await syncing
    } finally {
      syncing = null
    }
  }

  async function loop(gen) {
    let lastFull = now()
    while (running && gen === generation) {
      try {
        if (!secret?.refreshToken || secret.folder == null) return
        if (now() - lastFull > RESYNC_MS) {
          cursor = ''
          lastFull = now()
        }
        await sync()
        if (gen !== generation) return
        // Auf Änderungen warten (Dropbox antwortet sofort, wenn sich im Ordner etwas tut)
        const poll = await request(`${NOTIFY}/files/list_folder/longpoll`, { body: JSON.stringify({ cursor, timeout: LONGPOLL_S }), headers: { 'Content-Type': 'application/json' }, auth: false })
        if (poll.backoff) await wait(Number(poll.backoff) * 1000, gen)
      } catch (err) {
        if (gen !== generation) return
        if (state !== 'error' || error !== err.message) log(`Dropbox: ${err.message}`)
        if (secret?.refreshToken) state = 'error'
        error = err.message
        onUpdate(snapshot())
        await wait(RETRY_MS, gen)
      }
    }
  }

  let wake = null
  const wait = (ms, gen) =>
    new Promise((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, ms)
      if (gen !== generation) resolve()
    })

  function restart() {
    generation++
    clearTimeout(timer)
    wake?.()
    if (running && secret?.refreshToken && secret.folder != null) void loop(generation)
  }

  function settings() {
    return {
      appKey: secret?.appKey || '',
      connected: Boolean(secret?.refreshToken),
      account: secret?.refreshToken ? secret.account || null : null,
      pending: Boolean(pending),
      ...snapshot(),
    }
  }

  function filePath(name) {
    const hit = files.find((f) => f.file === name)
    return hit ? path.join(dir, hit.file) : null
  }

  return {
    start() {
      if (running) return
      running = true
      restart()
    },
    stop() {
      running = false
      generation++
      clearTimeout(timer)
      wake?.()
    },
    snapshot,
    settings,
    authorizeUrl,
    connect,
    disconnect,
    browse,
    setFolder,
    sync,
    filePath,
  }
}

module.exports = { createDropbox, normalizeFolder }
