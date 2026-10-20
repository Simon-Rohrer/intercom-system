'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = [path.resolve(__dirname, '../../Caddyfile'), path.resolve(__dirname, '../../Kesher/server-config/Caddyfile.jms')].find((filename) => fs.existsSync(filename))
const config = fs.readFileSync(source, 'utf8')

test('Every internal SSO origin has a protected HTTPS vhost; setup is separate', () => {
  const { DEFAULT_ORIGINS } = require('../auth-http')
  const mappings = { intercom: 'kesher', kesher: 'kesher', jmscontrol: null, multiview: null,
    technik: 'dashboard', dashboard: 'dashboard', companion: 'companion', glances: 'glances',
    portainer: 'portainer', dns: 'dns', router: 'router' }
  const blocks = config.match(/^https:\/\/[^\n]+ \{\n[\s\S]*?^\}/gm)
  for (const [host, service] of Object.entries(mappings)) {
    const origin = `https://${host}.internal`
    assert.ok(DEFAULT_ORIGINS.includes(origin), origin)
    const matches = blocks.filter((block) => block.split('\n')[0].split(/, | \{/).includes(origin))
    assert.equal(matches.length, 1, origin)
    assert.ok(matches[0].includes('import jms_tls'), origin)
    assert.ok(matches[0].includes(service ? `import jms_auth ${service}` : 'import jms_node'), origin)
  }
  assert.ok(!DEFAULT_ORIGINS.includes('https://setup.internal'))
  assert.match(config, /https:\/\/setup\.internal \{\s+import jms_tls\s+root \* \/srv\/homelab-setup\s+file_server/)
})

test('Caddy sanitizes untrusted authentication headers before forward auth copies verified headers', () => {
  assert.match(config, /order request_header before forward_auth/)
  assert.match(config, /request_header -X-JMS-Device-Assertion/)
  assert.match(config, /copy_headers X-JMS-Gateway X-JMS-Session-Id X-JMS-Device-Assertion/)
})

test('Caddy passes an empty fingerprint for non-certificate clients and captures valid fingerprints', () => {
  assert.match(config, /map \{tls_client_fingerprint\} \{jms_device_fingerprint\}/)
  assert.ok(config.includes('~^([a-fA-F0-9]{64})$ ${1}'))
  assert.match(config, /header_up X-JMS-Device-Fingerprint \{jms_device_fingerprint\}/)
})

test('Caddy requests certificates for IP clients without SNI and validates presented certificates', () => {
  assert.match(config, /default_sni 192\.168\.0\.21/)
  assert.match(config, /https:\/\/:8090, https:\/\/:8443[\s\S]*?mode verify_if_given[\s\S]*?trusted_ca_cert_file \/etc\/jms-auth\/device-ca.crt/)
  for (const port of [8090, 8443, 3000, 8000, 61208, 9443, 8250])
    assert.match(config, new RegExp(`servers 192\\.168\\.0\\.21:${port} \\{\\s*strict_sni_host insecure_off`))
})
