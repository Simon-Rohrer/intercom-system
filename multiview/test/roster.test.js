'use strict'

// Dienstplan („Wer ist heute dran?“): Dienste eines Events aus ChurchTools zu Zeilen
// zusammenführen (Server), Filter der Kachel (Browser) und das Laden über createChurchTools.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { normalizeEventServices, serviceMap, serviceCatalog } = require('../roster')
const { createChurchTools } = require('../churchtools')

// Browser-Module ohne laufenden Timer importieren (agenda.js als data:-URL einbinden,
// weil das Projekt CommonJS ist und ein file://-Import als CJS gelesen würde)
const dataUrl = (file) => `data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, file), 'utf8')).toString('base64')}`
const browser = (async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/roster.js'), 'utf8').replace("from './agenda.js'", `from '${dataUrl('../public/agenda.js')}'`)
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const services = [
  { id: 10, name: 'Ton', serviceGroupId: 1, sortKey: 2 },
  { id: 11, name: 'Licht', serviceGroupId: 1, sortKey: 1 },
  { id: 12, name: 'Kamera', serviceGroupId: 1, sortKey: 3 },
  { id: 20, name: 'Predigt', serviceGroupId: 2, sortKey: 1, hidePersonName: true },
  { id: 21, nameTranslated: 'Moderation', serviceGroupId: 2, sortKey: 2 },
]
const groups = new Map([[1, { name: 'Technik', sort: 2 }], [2, { name: 'Programm', sort: 1 }]])
const eventServices = [
  { id: 1, serviceId: 10, personId: 5, person: { title: 'Max Mustermann' }, agreed: true },
  { id: 2, serviceId: 11, personId: 6, person: { domainAttributes: { firstName: 'Erika', lastName: 'Musterfrau' } }, agreed: false },
  { id: 3, serviceId: 12, personId: 7, person: { title: 'Peter Pan' }, agreed: true },
  { id: 4, serviceId: 12, personId: null, person: null, agreed: false },
  { id: 5, serviceId: 20, personId: 8, person: { title: 'Geheim' }, agreed: true },
  { id: 6, serviceId: 21, personId: null, name: 'Gast (Freitext)', agreed: false, comment: 'kommt später' },
  { id: 7, serviceId: 99, personId: 9, person: { title: 'Unbekannter Dienst' }, agreed: true, isValid: false },
]

test('Dienste werden nach Gruppe und Dienst sortiert, nummeriert und mit Zustand versehen', () => {
  const rows = normalizeEventServices(eventServices, services, groups)
  assert.deepEqual(rows.map((r) => r.label), ['Predigt', 'Moderation', 'Licht', 'Ton', 'Kamera 1', 'Kamera 2'])
  assert.deepEqual(rows.map((r) => r.group), ['Programm', 'Programm', 'Technik', 'Technik', 'Technik', 'Technik'])
  const by = Object.fromEntries(rows.map((r) => [r.label, r]))
  assert.equal(by.Ton.name, 'Max Mustermann')
  assert.equal(by.Ton.accepted, true)
  assert.equal(by.Licht.name, 'Erika Musterfrau')
  assert.equal(by.Licht.assigned, true)
  assert.equal(by.Licht.accepted, false) // angefragt → gelb
  assert.equal(by['Kamera 2'].assigned, false) // nicht besetzt → rot
  assert.equal(by['Kamera 2'].accepted, false)
  assert.equal(by.Predigt.name, 'Name in ChurchTools verborgen')
  assert.equal(by.Moderation.name, 'Gast (Freitext)')
  assert.equal(by.Moderation.comment, 'kommt später')
  // Ungültige Einteilungen (isValid=false) fallen weg
  assert.ok(!rows.some((r) => r.serviceId === 99))
})

test('Unbekannte Dienste und fehlende Gruppen bleiben lesbar', () => {
  const rows = normalizeEventServices([{ id: 1, serviceId: 77, personId: 1, person: { title: 'A' }, agreed: true }], new Map(), new Map())
  assert.equal(rows[0].label, 'Dienst 77')
  assert.equal(rows[0].group, 'Weitere Dienste')
  assert.deepEqual(normalizeEventServices(null, services, groups), [])
})

test('Katalog für die Kachel-Einstellungen: Gruppen mit Diensten in ChurchTools-Reihenfolge', () => {
  const catalog = serviceCatalog(serviceMap(services), groups)
  assert.deepEqual(catalog.map((g) => g.name), ['Programm', 'Technik'])
  assert.deepEqual(catalog[1].services.map((s) => s.name), ['Licht', 'Ton', 'Kamera'])
  assert.deepEqual(Object.keys(catalog[0]), ['id', 'name', 'services'])
})

test('Kachel-Filter: Dienstgruppen, einzelne Dienste und „nur offene“', async () => {
  const { filterRoster, groupRoster, rosterSummary, rosterOptions } = await browser
  const rows = normalizeEventServices(eventServices, services, groups)
  assert.equal(filterRoster(rows, {}).length, 6)
  assert.deepEqual(filterRoster(rows, { groups: [1] }).map((r) => r.label), ['Licht', 'Ton', 'Kamera 1', 'Kamera 2'])
  assert.deepEqual(filterRoster(rows, { services: [20] }).map((r) => r.label), ['Predigt'])
  assert.deepEqual(filterRoster(rows, { groups: ['2'], services: ['12'] }).map((r) => r.label), ['Predigt', 'Moderation', 'Kamera 1', 'Kamera 2'])
  assert.deepEqual(filterRoster(rows, { openOnly: true }).map((r) => r.label), ['Moderation', 'Licht', 'Kamera 2'])
  assert.deepEqual(groupRoster(rows).map((g) => [g.group, g.rows.length]), [['Programm', 2], ['Technik', 4]])
  assert.deepEqual(rosterSummary(rows), { open: 1, pending: 2, total: 6 })
  assert.deepEqual(rosterOptions({ size: 9, groups: [1, 'x'], header: 'nein' }), { size: 3, header: true, groupTitles: true, openOnly: false, comments: false, groups: [1], services: [] })
})

test('createChurchTools lädt Dienste nur, wenn eine Dienstplan-Kachel sie braucht', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-ct-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'churchtools-secret.json'), JSON.stringify({ url: 'https://ct.test', token: 'test-only' }))
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date())
  const event = { id: 42, name: 'Gottesdienst', startDate: `${today}T08:00:00Z`, endDate: `${today}T10:00:00Z`, calendar: { title: 'Gottesdienste' } }
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    seen.push(url)
    const p = url.replace('https://ct.test/api', '')
    const payload = p.startsWith('/events?') ? { data: [event] }
      : p === '/events/42/agenda' ? { data: { name: 'Ablauf', items: [{ id: 1, position: 1, title: 'Begrüßung', duration: 120 }] } }
      : p === '/events/42' ? { data: { ...event, eventServices } }
      : p === '/services' ? { data: services }
      : p === '/servicegroups' ? { data: [{ id: 1, name: 'Technik', sortKey: 2 }, { id: 2, name: 'Programm', sortKey: 1 }] }
      : { data: [] }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
  })
  let wanted = false
  let last = null
  const ct = createChurchTools({ dataDir: dir, getConfig: () => ({ timeZone: 'Europe/Berlin' }), wantServices: () => wanted, onUpdate: (snap) => (last = snap), log: () => {} })
  await ct.refresh()
  ct.stop()
  assert.equal(last.state, 'connected')
  assert.equal(last.days[today][0].services, undefined, 'ohne Kachel keine Dienste')
  assert.ok(!seen.some((u) => u.endsWith('/events/42')), 'kein /events/{id} ohne Kachel')
  // Der Katalog für die Einstellungen ist trotzdem da
  assert.deepEqual(last.serviceCatalog.map((g) => g.name), ['Programm', 'Technik'])

  wanted = true
  ct.datesChanged() // Kachel hinzugekommen → sofort neu laden
  await ct.refresh()
  ct.stop()
  const loaded = last.days[today][0]
  assert.deepEqual(loaded.services.map((r) => r.label), ['Predigt', 'Moderation', 'Licht', 'Ton', 'Kamera 1', 'Kamera 2'])
  assert.equal(loaded.servicesError, '')
  assert.ok(seen.some((u) => u.endsWith('/events/42')))
  assert.deepEqual(ct.loadedEvents().map((e) => e.id), [42])
})
