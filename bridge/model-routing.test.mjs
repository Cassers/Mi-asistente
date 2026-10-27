import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, cp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'

const root = fileURLToPath(new URL('../', import.meta.url))
const wait = ms => new Promise(r => setTimeout(r, ms))

test('real bridge routes selected model/variant, rejects invalid choices and protects catalogue origin', { timeout: 20000 }, async () => {
  const stage = await mkdtemp(join(tmpdir(), 'assistant-model-routing-'))
  const workspace = join(stage, 'opencode/workspace')
  const events = new Set()
  const prompts = []
  const approvals = []
  let holdResponse = false
  const model = (id, image, variants) => ({ id, name: id, cost: { input: 0, output: 0 }, capabilities: { input: { text: true, image }, output: { text: true } }, variants, headers: { key: 'do-not-expose' } })
  const catalog = { connected: ['opencode', 'connected-paid'], all: [
    { id: 'opencode', name: 'OpenCode', models: { a: model('deepseek-v4.1-flash-free', true, { low: {}, high: {} }), b: model('mimo-free', true, {}) } },
    { id: 'connected-paid', name: 'Test provider', models: { a: { ...model('text-model', false, { medium: {} }), cost: { input: 1, output: 2 } } } },
  ] }
  const emit = ev => events.forEach(res => res.write(`data: ${JSON.stringify(ev)}\n\n`))
  const mock = http.createServer(async (req, res) => {
    const body = []; for await (const chunk of req) body.push(chunk)
    const data = body.length ? JSON.parse(Buffer.concat(body)) : null
    if (req.url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n')
      events.add(res); req.on('close', () => events.delete(res)); return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/provider') return res.end(JSON.stringify(catalog))
    if (req.url === '/permission' || req.url.endsWith('/message')) return res.end('[]')
    if (req.url === '/session') return res.end(JSON.stringify({ id: 'ses_synthetic', title: 'Synthetic', directory: workspace }))
    if (req.url.startsWith('/permission/') && req.url.endsWith('/reply')) {
      approvals.push({ id: req.url.split('/')[2], reply: data.reply }); return res.end('true')
    }
    if (req.url.endsWith('/prompt_async')) {
      prompts.push(data); res.writeHead(204); res.end()
      if (!holdResponse) setTimeout(() => {
        emit({ type: 'message.part.updated', properties: { sessionID: 'ses_synthetic', part: { sessionID: 'ses_synthetic', id: 'part1', type: 'text' } } })
        emit({ type: 'message.part.delta', properties: { sessionID: 'ses_synthetic', partID: 'part1', field: 'text', delta: 'Prueba correcta.' } })
        emit({ type: 'session.idle', properties: { sessionID: 'ses_synthetic' } })
      }, 20)
      return
    }
    res.end('true')
  })
  let child, ws
  try {
    await mkdir(join(workspace, 'ME'), { recursive: true })
    await cp(join(root, 'bridge'), join(stage, 'bridge'), { recursive: true })
    await cp(join(root, 'shared'), join(stage, 'shared'), { recursive: true })
    await symlink(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir')
    await writeFile(join(stage, 'package.json'), '{"type":"module"}')
    await writeFile(join(workspace, 'ME/CONFIG.json'), '{"configured":false}')
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
    const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
    const port = reserve.address().port; await new Promise(r => reserve.close(r))
    child = spawn(process.execPath, [join(stage, 'bridge/opencode-bridge.mjs')], { cwd: stage,
      env: { ...process.env, OPENCODE_URL: `http://127.0.0.1:${mock.address().port}`, JARVIS_BRIDGE_PORT: String(port), JARVIS_RECORDING: '0', JARVIS_HISTORY_DIR: join(stage, 'recordings') }, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    let response
    for (let i = 0; i < 80; i++) { try { response = await fetch(base + '/models'); break } catch { await wait(50) } }
    assert.equal(response?.status, 200)
    const publicCatalog = await response.json()
    assert.equal(publicCatalog.models.length, 3)
    assert.doesNotMatch(JSON.stringify(publicCatalog), /do-not-expose|headers/)
    assert.equal((await fetch(base + '/models', { headers: { origin: 'https://not-allowed.example' } })).status, 403)
    assert.equal((await fetch(base + '/models', { method: 'POST' })).status, 404)
    ws = new WebSocket(base.replace('http:', 'ws:') + '/?session=new', { origin: 'http://localhost:5173' })
    const frames = []; ws.on('message', raw => frames.push(JSON.parse(raw)))
    await once(ws, 'open')
    for (let i = 0; i < 80 && !frames.some(f => f.type === 'ready'); i++) await wait(25)
    assert.ok(frames.some(f => f.type === 'ready'))
    const ask = async (id, model, variant = '') => {
      ws.send(JSON.stringify({ type: 'ask', id, text: 'Solo texto ficticio.', model, variant }))
      for (let i = 0; i < 160; i++) { const end = frames.find(f => f.ask === id && ['done', 'error'].includes(f.type)); if (end) return end; await wait(25) }
      assert.fail('bridge did not settle')
    }
    assert.equal((await ask('a', 'opencode/deepseek-v4.1-flash-free', 'low')).type, 'done')
    assert.deepEqual(prompts[0].model, { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free' })
    assert.equal(prompts[0].variant, 'low')
    assert.equal((await ask('b', 'connected-paid/text-model', 'medium')).type, 'done')
    assert.equal(prompts[1].model.providerID, 'connected-paid')
    assert.match(prompts[1].parts[0].text, /no puede ver el monitor/)
    assert.equal(prompts[1].parts.filter(p => p.type === 'file').length, 0)
    assert.equal((await ask('c', 'opencode/mimo-free', 'high')).type, 'error')
    assert.equal((await ask('d', 'unconnected/any')).type, 'error')
    assert.equal(prompts.length, 2, 'no hidden fallback or prompt for invalid choices')
    assert.equal(frames.find(f => f.type === 'permission_mode').policy.mode, 'manual')
    let policySequence = 0
    const changeMode = async (mode, confirmed = false) => {
      const requestID = `test-policy-${++policySequence}`
      const previous = frames.length
      ws.send(JSON.stringify({ type: 'permission_mode', mode, confirmed, requestID }))
      for (let i=0;i<80;i++) { const frame = frames.slice(previous).find(f => f.type === 'permission_mode' && f.requestID === requestID); if(frame) return frame.policy; await wait(10) }
      assert.fail('No policy acknowledgement')
    }
    assert.equal((await changeMode('total')).mode, 'manual', 'total requires explicit confirmation')
    assert.equal((await changeMode('limited')).mode, 'limited')
    holdResponse = true
    const answering = ask('policy', 'opencode/deepseek-v4.1-flash-free')
    for(let i=0;i<80 && prompts.length<3;i++) await wait(10)
    const permission = (id, name, patterns) => emit({ type: 'permission.asked', properties: { id, sessionID: 'ses_synthetic', permission: name, patterns } })
    permission('config','read',['ME/CONFIG.json'])
    permission('old-bash','bash',['printf synthetic'])
    for(let i=0;i<80 && !approvals.some(a => a.id==='config');i++) await wait(10)
    assert.deepEqual(approvals, [{ id: 'config', reply: 'once' }])
    assert.equal((await changeMode('total', true)).mode, 'total')
    permission('new-bash','bash',['printf synthetic'])
    for(let i=0;i<80 && !approvals.some(a => a.id==='new-bash');i++) await wait(10)
    assert.ok(approvals.some(a => a.id==='new-bash' && a.reply==='once'))
    assert.ok(!approvals.some(a => a.id==='old-bash'), 'changing mode never escalates an old pending request')
    assert.equal((await changeMode('manual')).mode, 'manual')
    permission('manual-bash','bash',['printf synthetic'])
    emit({ type: 'session.idle', properties: { sessionID: 'ses_synthetic' } })
    assert.equal((await answering).type, 'done')
    ws.close(); await once(ws, 'close')
    for(let i=0;i<80 && !approvals.some(a=>a.id==='manual-bash');i++)await wait(10)
    assert.ok(approvals.some(a=>a.id==='manual-bash' && a.reply==='reject'))
    assert.ok(approvals.some(a=>a.id==='old-bash' && a.reply==='reject'))
    ws = new WebSocket(base.replace('http:', 'ws:') + '/?session=new', { origin: 'http://localhost:5173' })
    const reset = []; ws.on('message', raw => reset.push(JSON.parse(raw)))
    await once(ws, 'open')
    for(let i=0;i<80 && !reset.some(f=>f.type==='permission_mode');i++)await wait(10)
    assert.equal(reset.find(f=>f.type==='permission_mode')?.policy.mode, 'manual')
    assert.equal(reset.find(f=>f.type==='permission_mode')?.policy.autoApproved, 0)
  } finally {
    ws?.terminate()
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    events.forEach(res => res.end()); mock.closeAllConnections(); await new Promise(r => mock.close(r))
    await rm(stage, { recursive: true, force: true })
  }
})
