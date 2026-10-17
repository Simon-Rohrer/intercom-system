// Alle Dienste auf dem Technik-Server – für die Seite „Services“ und die Zurück-zum-Dashboard-Links.
// Die Adresse passt sich daran an, wie JMS Control gerade aufgerufen wurde:
//   …local  → Namen im lokalen Netz (technik.local, intercom.local …)
//   …jms.de → die jms.de-Namen, wo es sie gibt
//   IP      → dieselbe IP mit dem Port des Dienstes (z. B. https://192.168.0.21:3000)

export const SERVICE_GROUPS = [
  {
    title: 'Dienste',
    admin: false,
    services: [
      { id: 'dashboard', name: 'Dashboard', desc: 'Startseite mit allen Diensten', host: 'technik.local', jms: 'dashboard.jms.de', port: 3000, color: 'blue', icon: 'home' },
      { id: 'intercom', name: 'Intercom', desc: 'Sprechen, Hören und Chat (Kesher)', host: 'intercom.local', jms: 'intercom.jms.de', port: 8443, color: 'green', icon: 'headset' },
      { id: 'raspberry', name: 'Raspberry fernsteuern', desc: 'Intercom-Stationen aus der Ferne bedienen', host: 'intercom.local', jms: 'intercom.jms.de', port: 8443, path: '/?login=raspberry', color: 'pink', icon: 'chip' },
      { id: 'jmscontrol', name: 'JMS Control', desc: 'Multiviews, Einstellungen, Benutzer & Rechte', host: 'jmscontrol.local', jms: 'multiview.jms.de', port: 8090, color: 'indigo', icon: 'grid' },
      { id: 'chat', name: 'Intercom-Chat', desc: 'Chat am Handy', host: 'jmscontrol.local', jms: 'multiview.jms.de', port: 8090, path: '/remote.html?tab=chat', color: 'teal', icon: 'chat' },
      { id: 'beamer', name: 'Nachricht auf den Beamer', desc: 'Meldung, die der ProPresenter-Bediener freigibt', host: 'jmscontrol.local', jms: 'multiview.jms.de', port: 8090, path: '/remote.html?tab=beamer', color: 'orange', icon: 'screen' },
      { id: 'stage', name: 'Nachricht auf das Stage Display', desc: 'Text für die Bühne', host: 'jmscontrol.local', jms: 'multiview.jms.de', port: 8090, path: '/remote.html?tab=stage', color: 'purple', icon: 'stage' },
      { id: 'prediger', name: 'Prediger', desc: 'Folien steuern am iPad oder iPhone', host: 'jmscontrol.local', jms: 'multiview.jms.de', port: 8090, path: '/prediger.html', color: 'gray', icon: 'slides' },
    ],
  },
  {
    title: 'Verwaltung',
    admin: true,
    services: [
      { id: 'companion', name: 'Companion', desc: 'Stream Deck und Tastenbelegung', host: 'companion.local', port: 8000, color: 'red', icon: 'keys' },
      { id: 'portainer', name: 'Portainer', desc: 'Docker-Container verwalten', host: 'portainer.local', port: 9443, color: 'blue', icon: 'box' },
      { id: 'glances', name: 'Glances', desc: 'Auslastung des Servers', host: 'glances.local', port: 61208, color: 'green', icon: 'chart' },
      { id: 'dns', name: 'Lokaler DNS', desc: 'Namen im Netz (.local) und Werbefilter', host: 'dns.local', color: 'teal', icon: 'globe' },
      { id: 'router', name: 'Router', desc: 'Netzwerk und Internet', host: 'router.local', port: 8250, color: 'gray', icon: 'router' },
    ],
  },
]

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h === 'localhost'

/** Adresse eines Dienstes, passend zu der Art, wie die Seite gerade aufgerufen wurde. */
export function serviceUrl(service, hostname = location.hostname) {
  const path = service.path || '/'
  if (hostname.endsWith('.jms.de') && service.jms) return `https://${service.jms}${path}`
  if (isIp(hostname) && service.port) return `https://${hostname}:${service.port}${path}`
  return `https://${service.host}${path}`
}

export const findService = (id) => SERVICE_GROUPS.flatMap((g) => g.services).find((s) => s.id === id)

/** Gefüllte Symbole (wie die App-Kacheln der Übersicht). */
export const SERVICE_ICONS = {
  home: '<path d="M11.3 2.6a1 1 0 0 1 1.4 0l8.6 8a1 1 0 0 1-.7 1.7H19v7.2a2 2 0 0 1-2 2h-3v-6h-4v6H7a2 2 0 0 1-2-2v-7.2H3.4a1 1 0 0 1-.7-1.7l8.6-8Z"/>',
  headset: '<path d="M12 2.5a8.5 8.5 0 0 0-8.5 8.5v5.5A2.5 2.5 0 0 0 6 19h1.5a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1h-2v-1a6.5 6.5 0 0 1 13 0v1h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1.4a3 3 0 0 1-2.9 2h-2.5a1 1 0 1 0 0 2H15a5 5 0 0 0 4.9-4.1A2.5 2.5 0 0 0 20.5 16.5V11A8.5 8.5 0 0 0 12 2.5Z"/>',
  chip: '<path fill-rule="evenodd" d="M8 2a1 1 0 0 1 1 1v1h2V3a1 1 0 1 1 2 0v1h2V3a1 1 0 1 1 2 0v1a3 3 0 0 1 3 3h1a1 1 0 1 1 0 2h-1v2h1a1 1 0 1 1 0 2h-1v2h1a1 1 0 1 1 0 2h-1a3 3 0 0 1-3 3v1a1 1 0 1 1-2 0v-1h-2v1a1 1 0 1 1-2 0v-1H9v1a1 1 0 1 1-2 0v-1a3 3 0 0 1-3-3H3a1 1 0 1 1 0-2h1v-2H3a1 1 0 1 1 0-2h1V9H3a1 1 0 0 1 0-2h1a3 3 0 0 1 3-3V3a1 1 0 0 1 1-1Zm1.5 7.5v5h5v-5h-5Z"/>',
  grid: '<rect x="2.5" y="2.5" width="8.5" height="8.5" rx="2.2"/><rect x="13" y="2.5" width="8.5" height="8.5" rx="2.2"/><rect x="2.5" y="13" width="8.5" height="8.5" rx="2.2"/><rect x="13" y="13" width="8.5" height="8.5" rx="2.2"/>',
  chat: '<path d="M12 3c5.2 0 9.5 3.6 9.5 8.2S17.2 19.4 12 19.4c-1 0-2-.1-2.9-.4L4.6 21a.8.8 0 0 1-1.1-.9l.9-3.4A7.8 7.8 0 0 1 2.5 11.2C2.5 6.6 6.8 3 12 3Z"/>',
  screen: '<path fill-rule="evenodd" d="M4.5 3h15A2.5 2.5 0 0 1 22 5.5v10a2.5 2.5 0 0 1-2.5 2.5H13v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H4.5A2.5 2.5 0 0 1 2 15.5v-10A2.5 2.5 0 0 1 4.5 3ZM7 8a1 1 0 0 0 0 2h10a1 1 0 1 0 0-2H7Zm0 3.5a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2H7Z"/>',
  stage: '<path fill-rule="evenodd" d="M3 4.5A1.5 1.5 0 0 1 4.5 3h15A1.5 1.5 0 0 1 21 4.5v11a1.5 1.5 0 0 1-1.5 1.5H15l1.6 3.2a1 1 0 1 1-1.8.9L13 17h-2l-1.8 4.1a1 1 0 1 1-1.8-.9L9 17H4.5A1.5 1.5 0 0 1 3 15.5v-11ZM7.5 9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4.5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm4.5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>',
  slides: '<path fill-rule="evenodd" d="M2 5.5A2.5 2.5 0 0 1 4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5v-13Zm8 3.2v6.6c0 .7.8 1.2 1.4.8l5-3.3c.5-.3.5-1.1 0-1.4l-5-3.3c-.6-.4-1.4.1-1.4.6Z"/>',
  keys: '<rect x="2.5" y="2.5" width="8.5" height="8.5" rx="2"/><rect x="13" y="2.5" width="8.5" height="8.5" rx="2"/><rect x="2.5" y="13" width="8.5" height="8.5" rx="2"/><rect x="13" y="13" width="8.5" height="8.5" rx="2" opacity=".55"/>',
  box: '<path d="M12.6 2.2a1.3 1.3 0 0 0-1.2 0L3.7 6.3 12 10.8l8.3-4.5-7.7-4.1ZM21 8 13 12.4v9.4l7.3-4a1.3 1.3 0 0 0 .7-1.1V8ZM11 21.8v-9.4L3 8v8.7c0 .5.3.9.7 1.1l7.3 4Z"/>',
  chart: '<path fill-rule="evenodd" d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm2 11a1 1 0 0 1 2 0v3a1 1 0 1 1-2 0v-3Zm4-4a1 1 0 1 1 2 0v7a1 1 0 1 1-2 0v-7Zm4-3a1 1 0 1 1 2 0v10a1 1 0 1 1-2 0V7Z"/>',
  globe: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.6 2.2C9.3 5.8 8.6 8.2 8.5 11H4.1a8 8 0 0 1 6.3-6.8Zm3.2 0A8 8 0 0 1 19.9 11h-4.4c-.1-2.8-.8-5.2-1.9-6.8ZM10.5 11c.2-3 1-5 1.5-5.9.5.9 1.3 2.9 1.5 5.9h-3Zm-6.4 2h4.4c.1 2.8.8 5.2 1.9 6.8A8 8 0 0 1 4.1 13Zm6.4 0h3c-.2 3-1 5-1.5 5.9-.5-.9-1.3-2.9-1.5-5.9Zm5 0h4.4a8 8 0 0 1-6.3 6.8c1.1-1.6 1.8-4 1.9-6.8Z"/>',
  router: '<path fill-rule="evenodd" d="M7.8 4.4a6 6 0 0 1 8.4 0 1 1 0 1 1-1.4 1.4 4 4 0 0 0-5.6 0 1 1 0 1 1-1.4-1.4ZM5 13.5A2.5 2.5 0 0 1 7.5 11H11V8.5a1 1 0 1 1 2 0V11h3.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17.5v-4Zm3 1.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>',
}
