// Bilder rendern: node gen.js specs.json outdir
const { spawn } = require('child_process')
const fs = require('fs')
const WebSocket = require(process.env.WS_MODULE)
const [specFile, outDir] = process.argv.slice(2)
const specs = JSON.parse(fs.readFileSync(specFile, 'utf8'))
const port = 9334
const profile = fs.mkdtempSync('/tmp/wgen-')
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  let url
  for (let i = 0; i < 50 && !url; i++) { try { url = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {} ; await sleep(200) }
  const ws = new WebSocket(url); await new Promise((r) => ws.once('open', r))
  let id = 0; const pending = new Map()
  ws.on('message', (m) => { const msg = JSON.parse(m); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } })
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.navigate', { url: 'file://' + __dirname + '/gen.html' }); await sleep(1000)
  for (const spec of specs) {
    const res = await send('Runtime.evaluate', { expression: `render(${JSON.stringify(spec)})`, returnByValue: true })
    const data = res.result?.result?.value
    if (!data) { console.log('Fehler', spec.name, JSON.stringify(res).slice(0, 300)); continue }
    fs.writeFileSync(`${outDir}/${spec.name}.jpg`, Buffer.from(data.split(',')[1], 'base64'))
    console.log('ok', spec.name)
  }
  ws.close(); chrome.kill()
})().catch((e) => { console.error(e); chrome.kill(); process.exit(1) })
