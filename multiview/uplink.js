'use strict'

// Upload/Download der Internetleitung von der FRITZ!Box (UPnP-IGD, Port 49000, ohne Anmeldung).
// Während eines YouTube-Streams ist der Upload fast ganz der Stream – fällt er ab, hakt der Stream.
// Die FRITZ!Box gibt die Rate selbst schon gemittelt aus (Bytes/s).

const POLL_MS = 2000
const LINK_MS = 60 * 1000 // Leitungsgeschwindigkeit ändert sich kaum
const HISTORY_MS = 15 * 60 * 1000
const TIMEOUT_MS = 2500
const SERVICE = 'urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1'

function normalizeUplink(u) {
  const host = String(u?.host ?? '192.168.178.1').trim()
  return {
    enabled: u?.enabled !== false,
    // Nur Adresse oder Name (ohne http://, Pfad oder Port) – Port 49000 ist fest
    host: /^[a-z0-9.-]{1,253}$/i.test(host) ? host : '192.168.178.1',
  }
}

/** Einen Wert aus der SOAP-Antwort lesen, z. B. <NewByteSendRate>1066096</NewByteSendRate> */
function soapValue(xml, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)
  return m ? Number(m[1]) : NaN
}

function createUplink({ getConfig, onUpdate, log = () => {} }) {
  let history = [] // { t, up, down } in Bit/s
  let state = 'off'
  let error = ''
  let maxUp = 0
  let maxDown = 0
  let linkAt = 0
  let timer = null
  let running = false

  async function soap(host, action) {
    const body =
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:${action} xmlns:u="${SERVICE}"/></s:Body></s:Envelope>`
    const res = await fetch(`http://${host}:49000/igdupnp/control/WANCommonIFC1`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `${SERVICE}#${action}` },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }

  function info() {
    const { host } = normalizeUplink(getConfig())
    return { type: 'uplink', state, error, host, maxUp, maxDown }
  }

  /** Voller Stand für neue Verbindungen (mit Verlauf) */
  function snapshot() {
    return { ...info(), history }
  }

  async function poll() {
    const cfg = normalizeUplink(getConfig())
    if (!cfg.enabled) {
      if (state !== 'off') {
        state = 'off'
        history = []
        onUpdate(snapshot())
      }
      return
    }
    try {
      if (Date.now() - linkAt > LINK_MS) {
        const link = await soap(cfg.host, 'GetCommonLinkProperties')
        maxUp = soapValue(link, 'NewLayer1UpstreamMaxBitRate') || 0
        maxDown = soapValue(link, 'NewLayer1DownstreamMaxBitRate') || 0
        linkAt = Date.now()
      }
      const xml = await soap(cfg.host, 'GetAddonInfos')
      const up = soapValue(xml, 'NewByteSendRate')
      const down = soapValue(xml, 'NewByteReceiveRate')
      if (!Number.isFinite(up)) throw new Error('Keine Werte (UPnP-Statusinformationen in der FRITZ!Box aus?)')
      const sample = { t: Date.now(), up: up * 8, down: Number.isFinite(down) ? down * 8 : 0 }
      history.push(sample)
      while (history.length && history[0].t < sample.t - HISTORY_MS) history.shift()
      const wasOk = state === 'ok'
      state = 'ok'
      error = ''
      if (!wasOk) log(`Upload: FRITZ!Box ${cfg.host} erreichbar`)
      onUpdate({ ...info(), sample })
    } catch (err) {
      const message = err.name === 'TimeoutError' ? 'FRITZ!Box antwortet nicht' : err.message
      if (state !== 'error' || error !== message) {
        log(`Upload: ${message}`)
        state = 'error'
        error = message
        linkAt = 0
        onUpdate(snapshot())
      }
    }
  }

  function loop() {
    if (!running) return
    poll().finally(() => {
      if (running) timer = setTimeout(loop, POLL_MS)
    })
  }

  return {
    start() {
      if (running) return
      running = true
      loop()
    },
    stop() {
      running = false
      clearTimeout(timer)
    },
    /** Adresse geändert: sofort neu abfragen */
    reconfigure() {
      linkAt = 0
      history = []
      state = 'off'
      error = ''
    },
    snapshot,
  }
}

module.exports = { createUplink, normalizeUplink, soapValue }
