'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')

function deviceAssertion(machine, secret, now = Date.now()) {
  if (!machine || !secret || machine.mode !== 'station' || !(machine.services?.includes('kesher') || machine.mirrorRoles?.length)) return ''
  const payload = Buffer.from(JSON.stringify({ aud: 'kesher-device', id: machine.id, version: machine.version,
    roleId: machine.roleId, deviceId: machine.deviceId, capabilities: machine.capabilities,
    exp: Math.min(now + 30_000, machine.expiresAt) })).toString('base64url')
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`
}

function startSatelliteBridge({ access, host = '0.0.0.0', port = 16624, upstreamPort = 16622, caFile, certFile, keyFile }) {
  const connections = new Set()
  const server = tls.createServer({ ca: fs.readFileSync(caFile), cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile),
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, (socket) => {
    const fingerprint = socket.getPeerCertificate().fingerprint256
    const machine = socket.authorized && access.machineByFingerprint(fingerprint)
    if (!machine?.capabilities?.includes('satellite') || machine.mode !== 'station') return socket.destroy()
    const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort })
    const connection = { socket, upstream, id: machine.id, version: machine.version }
    const close = () => { connections.delete(connection); socket.destroy(); upstream.destroy() }
    connections.add(connection)
    socket.on('error', close)
    socket.on('close', close)
    upstream.on('error', close)
    upstream.on('close', close)
    socket.pipe(upstream).pipe(socket)
  })
  server.maxConnections = 32
  server.on('tlsClientError', () => {})
  const timer = setInterval(() => {
    for (const connection of connections) {
      const status = access.machineStatus(connection.id, connection.version)
      if (!status.active || !status.capabilities?.includes('satellite')) {
        connection.socket.destroy()
        connection.upstream.destroy()
        connections.delete(connection)
      }
    }
  }, 1000)
  timer.unref()
  server.on('close', () => clearInterval(timer))
  server.listen(port, host)
  return { server, close: () => {
    clearInterval(timer)
    for (const connection of connections) { connection.socket.destroy(); connection.upstream.destroy() }
    connections.clear()
    server.close()
  } }
}

module.exports = { deviceAssertion, startSatelliteBridge }
