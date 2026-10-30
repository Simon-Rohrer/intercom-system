'use strict'

// Dienstplan aus ChurchTools: Die Dienste eines Events (eventServices) mit den
// Namen aus /services und den Dienstgruppen aus /servicegroups zu lesbaren Zeilen
// zusammenführen – für die Kachel „Dienstplan“ („Wer ist heute dran?“).

/** Name einer eingeteilten Person (DomainObject, Person oder Freitext). */
function personName(es) {
  const p = es?.person
  if (p) {
    const name = p.title || [p.domainAttributes?.firstName, p.domainAttributes?.lastName].filter(Boolean).join(' ')
    if (name) return name
  }
  return String(es?.name || '').trim()
}

/**
 * Dienste eines Events als Zeilen, sortiert nach Dienstgruppe und Dienst.
 * Mehrfach vergebene Dienste werden durchnummeriert („Kamera 1“, „Kamera 2“).
 *
 * @param eventServices  event.eventServices aus ChurchTools
 * @param services       Map serviceId → { name, groupId, sort, hideName } oder Liste aus /services
 * @param groups         Map groupId → { name, sort } (wie loadServiceGroups in churchtools.js)
 */
function normalizeEventServices(eventServices, services, groups = new Map()) {
  const defs = services instanceof Map ? services : serviceMap(services)
  const list = (Array.isArray(eventServices) ? eventServices : []).filter((es) => es && es.isValid !== false && es.serviceId != null)
  const rows = list.map((es, order) => {
    const def = defs.get(es.serviceId) || defs.get(String(es.serviceId)) || null
    const group = def ? groups.get(def.groupId) : null
    const name = def?.hideName ? 'Name in ChurchTools verborgen' : personName(es)
    const assigned = Boolean(es.personId || es.person || String(es.name || '').trim())
    return {
      id: es.id ?? null,
      serviceId: es.serviceId,
      service: def?.name || `Dienst ${es.serviceId}`,
      groupId: def?.groupId ?? null,
      group: group?.name || (def?.groupId != null ? `Gruppe ${def.groupId}` : 'Weitere Dienste'),
      name: assigned ? name : '',
      assigned,
      // Zugesagt nur bei ausdrücklicher Zusage; angefragt = eingeteilt, aber noch offen
      accepted: assigned && (es.agreed === true || es.isAccepted === true),
      comment: String(es.comment || '').trim(),
      _sort: [group?.sort ?? Number.MAX_SAFE_INTEGER, def?.sort ?? Number.MAX_SAFE_INTEGER, order],
    }
  })
  rows.sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2] - b._sort[2])
  // Durchnummerieren, wenn ein Dienst mehrfach vorkommt
  const counts = new Map()
  for (const r of rows) counts.set(r.serviceId, (counts.get(r.serviceId) || 0) + 1)
  const seen = new Map()
  for (const r of rows) {
    if (counts.get(r.serviceId) > 1) {
      const n = (seen.get(r.serviceId) || 0) + 1
      seen.set(r.serviceId, n)
      r.label = `${r.service} ${n}`
    } else r.label = r.service
    delete r._sort
  }
  return rows
}

/** Liste aus GET /services → Map serviceId → { name, groupId, sort, hideName } */
function serviceMap(list) {
  const map = new Map()
  for (const s of Array.isArray(list) ? list : []) {
    if (s?.id == null) continue
    map.set(s.id, {
      id: s.id,
      name: String(s.nameTranslated || s.name || '').trim() || `Dienst ${s.id}`,
      groupId: s.serviceGroupId ?? null,
      sort: Number.isFinite(Number(s.sortKey)) ? Number(s.sortKey) : s.id,
      hideName: s.hidePersonName === true,
    })
  }
  return map
}

/**
 * Katalog für die Kachel-Einstellungen: Dienstgruppen mit ihren Diensten,
 * in ChurchTools-Reihenfolge. Dienste ohne bekannte Gruppe stehen am Ende.
 */
function serviceCatalog(services, groups = new Map()) {
  const defs = services instanceof Map ? services : serviceMap(services)
  const byGroup = new Map()
  for (const def of defs.values()) {
    const key = def.groupId ?? 'none'
    if (!byGroup.has(key)) {
      const g = groups.get(def.groupId)
      byGroup.set(key, {
        id: def.groupId ?? null,
        name: g?.name || (def.groupId != null ? `Gruppe ${def.groupId}` : 'Weitere Dienste'),
        sort: g?.sort ?? Number.MAX_SAFE_INTEGER,
        services: [],
      })
    }
    byGroup.get(key).services.push({ id: def.id, name: def.name, sort: def.sort })
  }
  const result = [...byGroup.values()].sort((a, b) => a.sort - b.sort || String(a.name).localeCompare(String(b.name), 'de'))
  for (const g of result) {
    g.services.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'de'))
    for (const s of g.services) delete s.sort
    delete g.sort
  }
  return result
}

module.exports = { normalizeEventServices, serviceMap, serviceCatalog }
