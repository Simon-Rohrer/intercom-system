'use strict'

/** Anzeige je Multiview. Neue Multiviews starten ohne QR-Code. */
function normalizeDayQr(value, fallback = { show: false, corner: 'br', size: 's' }) {
  return {
    show: typeof value?.show === 'boolean' ? value.show : fallback.show,
    corner: ['tl', 'tr', 'bl', 'br'].includes(value?.corner) ? value.corner : fallback.corner,
    size: ['s', 'm', 'l'].includes(value?.size) ? value.size : fallback.size,
  }
}

/** Bestehende individuelle Werte haben Vorrang vor der einmaligen Alt-Konfiguration. */
function normalizeOutputDayQr(outputs, legacy) {
  const fallback = normalizeDayQr(legacy)
  return outputs.map((output) => ({ ...output, dayQr: normalizeDayQr(output.dayQr, fallback), tallyFrame: normalizeTallyFrame(output.tallyFrame) }))
}

/** Tally-Rahmen um den ganzen Bildschirm einer Ausgabe (z. B. am Pi der Kamera): ATEM-Eingang und Stärke */
function normalizeTallyFrame(value) {
  const input = Number(value?.input)
  const size = ['s', 'm', 'l'].includes(value?.size) ? value.size : 'm'
  return { input: value?.input != null && value?.input !== '' && Number.isInteger(input) && input >= 0 ? input : null, size }
}

module.exports = { normalizeDayQr, normalizeOutputDayQr, normalizeTallyFrame }
