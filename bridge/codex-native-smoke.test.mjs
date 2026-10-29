import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CodexManager } from './codex-runtime.mjs'
import { CodexRpc } from './codex-rpc.mjs'
import { screenPrompt } from './screen-context.mjs'
import { deflateSync } from 'node:zlib'

// Opt in with JARVIS_CODEX_NATIVE_SMOKE=1; optionally set JARVIS_CODEX_CLI to
// an installed CLI path. No auth/config is copied and every model request goes
// to the loopback Responses fixture in this test's disposable CODEX_HOME.
test('installed Codex: empty reconnect, first turn, persisted resume, native AGENTS and manual command approval', {
  skip: process.env.JARVIS_CODEX_NATIVE_SMOKE !== '1', timeout: 60000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-codex-native-'))
  const home = join(root, 'codex-home'), directory = join(root, 'project')
  const mcpPids = join(root, 'mcp-pids')
  const requests = [], transports = [], methods = []
  let phase = 'first', manager, mockError
  const mock = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses')
      assert.equal(req.headers.authorization, undefined, 'no real or mock credentials needed')
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      assert.equal(body.model, 'gpt-5.4')
      let item
      if (phase === 'approval') {
        const tool = body.tools.find(tool => ['exec_command', 'shell_command', 'shell'].includes(tool.name))
        assert.ok(tool, 'native command tool is present')
        const command = "printf 'CODEX_NATIVE_TOOL_OK'"
        const args = { ...(tool.name === 'exec_command' ? { cmd: command } : tool.name === 'shell' ? { command: ['/bin/sh', '-c', command] } : { command }),
          sandbox_permissions: 'require_escalated', justification: 'Disposable localhost fixture approval test.' }
        item = { type: 'function_call', id: 'fc_approval', call_id: 'call_approval', name: tool.name, arguments: JSON.stringify(args), status: 'completed' }
        phase = 'second'
      } else {
        item = { type: 'message', id: `msg_${phase}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: phase === 'first' ? 'CODEX_NATIVE_FIRST_OK' : 'CODEX_NATIVE_SECOND_OK', annotations: [] }] }
      }
      const response = { id: `resp_${requests.length}`, created_at: 1, model: body.model, status: 'in_progress', output: [] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'response.created', response })
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } })
      if (item.type === 'function_call') send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
      else {
        send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text })
      }
      send({ type: 'response.output_item.done', output_index: 0, item })
      send({ type: 'response.completed', response: { ...response, status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
      res.end()
    } catch (error) { mockError = error; res.writeHead(500); res.end('Fixture failure') }
  })
  t.after(async () => {
    await manager?.close()
    for (const rpc of transports) await rpc.close()
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  await mkdir(home); await mkdir(directory)
  await writeFile(join(directory, 'AGENTS.md'), '# Native fixture\nCODEX_NATIVE_AGENTS_INCLUDED: retain native folder context.\n')
  // Deterministic simulated text/image catalog, never a real-account capability claim.
  await writeFile(join(root, 'models.json'), JSON.stringify({ models: [{
    slug: 'gpt-5.4', display_name: 'Local text/image fixture', description: 'Local fixture only', base_instructions: 'Native protocol fixture.',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Fixture' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
    input_modalities: ['text', 'image'], experimental_supported_tools: [], prefer_websockets: false,
    supports_reasoning_summaries: false, supports_parallel_tool_calls: false, support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
  }] }))
  await writeFile(join(home, 'config.toml'), `
model = "gpt-5.4"
model_catalog_json = ${JSON.stringify(join(root, 'models.json'))}
model_provider = "localhost_fixture"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.localhost_fixture]
name = "Disposable localhost fixture"
base_url = "http://127.0.0.1:${mock.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 5000
[projects.${JSON.stringify(directory)}]
trust_level = "trusted"
[analytics]
enabled = false
[feedback]
enabled = false
[mcp_servers.lifecycle_fixture]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([fileURLToPath(new URL('./codex-mcp-fixture.mjs', import.meta.url)), mcpPids])}
`)
  // Valid 1x1 RGB PNG, generated locally. No desktop or camera is opened.
  const pngChunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    const header = Buffer.alloc(4), checksum = Buffer.alloc(4)
    header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([header, content, checksum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk('IEND', Buffer.alloc(0))])
  const createManager = () => new CodexManager({ autoScreen: false,
    screen: (text, options) => screenPrompt(text, { ...options, capture: async () => ({ data: png.toString('base64'), mimeType: 'image/png' }) }),
    transportFactory: cwd => {
    const rpc = new CodexRpc({ cwd, command: process.env.JARVIS_CODEX_CLI || 'codex',
      env: { PATH: process.env.PATH, CODEX_HOME: home }, requestTimeoutMs: 10000 })
    const request = rpc.request.bind(rpc)
    rpc.request = (method, params) => { methods.push(method); return request(method, params) }
    transports.push(rpc); return rpc
  } })
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000
    while (!(await predicate())) {
      if (mockError) throw mockError
      if (Date.now() > deadline) throw new Error('Native fixture timed out; methods: ' + methods.join(', '))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  manager = createManager()
  let runtime = await manager.runtime(directory)
  assert.equal((await runtime.verify()).requiresOpenaiAuth, false)
  assert.ok((await runtime.models()).length)
  let state = await runtime.open('new')
  const threadId = state.id
  assert.equal(await runtime.open(threadId), state)
  assert.deepEqual(runtime.transcript(state), [])
  assert.equal(methods.includes('thread/turns/list'), false)
  assert.equal(methods.includes('thread/resume'), false)
  const firstFrames = []
  runtime.subscribe(state, frame => firstFrames.push(frame))
  await runtime.ask(state, { id: 'first', text: 'First fixture turn.', audioMode: 'transcript' })
  await waitFor(() => firstFrames.some(frame => frame.type === 'done'))
  assert.equal(firstFrames.find(frame => frame.type === 'done').status, 'ok')
  assert.equal(firstFrames.find(frame => frame.type === 'done').text, 'CODEX_NATIVE_FIRST_OK')
  assert.match(JSON.stringify(requests[0]), /CODEX_NATIVE_AGENTS_INCLUDED/)
  assert.match(await readFile(mcpPids, 'utf8'), /^\d+\n/)
  await runtime.open(threadId)
  assert.deepEqual(runtime.transcript(state).map(row => row.text), ['First fixture turn.', 'CODEX_NATIVE_FIRST_OK'])
  await manager.close()
  const assertMcpStopped = async () => {
    if (process.platform !== 'linux') return
    for (const pid of (await readFile(mcpPids, 'utf8')).trim().split('\n')) {
      await waitFor(async () => {
        const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
        return !status || status.slice(status.lastIndexOf(')') + 2).startsWith('Z')
      })
    }
  }
  await assertMcpStopped()
  manager = createManager()
  runtime = await manager.runtime(directory)
  state = await runtime.open(threadId)
  assert.equal(state.id, threadId)
  assert.deepEqual(runtime.transcript(state).map(row => row.text), ['First fixture turn.', 'CODEX_NATIVE_FIRST_OK'])
  assert.equal(requests.length, 1, 'resume never resubmits inference')
  assert.equal(methods.filter(method => method === 'thread/start').length, 1)
  assert.equal(methods.filter(method => method === 'thread/resume').length, 1)
  const frames = []
  let detach = runtime.subscribe(state, frame => frames.push(frame))
  phase = 'approval'
  await runtime.ask(state, { id: 'second', text: 'Second fixture turn; request command approval.', audioMode: 'transcript' })
  await waitFor(() => state.policy.pending.size || frames.some(frame => frame.type === 'done'))
  assert.equal(state.policy.pending.size, 1, 'native permission remains pending in manual mode')
  assert.equal(state.policy.snapshot().mode, 'manual')
  const permission = [...state.policy.pending.keys()][0]
  assert.match(permission, new RegExp(`^codex:${runtime.runtimeId}:${threadId}:`))
  detach()
  assert.equal(state.policy.pending.size, 1, 'socket detach cannot authorize the command')
  assert.equal(requests.length, 2)
  assert.equal(await runtime.open(threadId), state)
  detach = runtime.subscribe(state, frame => frames.push(frame))
  await state.policy.respond(permission, 'once')
  await waitFor(() => frames.some(frame => frame.type === 'done'))
  const done = frames.find(frame => frame.type === 'done')
  assert.equal(done.status, 'ok'); assert.equal(done.text, 'CODEX_NATIVE_SECOND_OK')
  assert.equal(state.policy.pending.size, 0)
  assert.equal(runtime.requests.size, 0)
  assert.match(JSON.stringify(requests.at(-1).input), /CODEX_NATIVE_TOOL_OK/)
  assert.match(JSON.stringify(requests[1].input), /First fixture turn/)
  assert.match(JSON.stringify(requests[1]), /CODEX_NATIVE_AGENTS_INCLUDED/)
  await runtime.open(threadId)
  assert.deepEqual(runtime.transcript(state).filter(row => row.role === 'user').map(row => row.text), ['First fixture turn.', 'Second fixture turn; request command approval.'])
  assert.equal(requests.length, 3, 'two user turns and one native tool continuation')
  const imageFrames = [], question = 'Synthetic screen question: preserve these exact words.'
  runtime.subscribe(state, frame => imageFrames.push(frame))
  assert.equal((await runtime.models()).find(model => model.id === 'gpt-5.4')?.image, true)
  await runtime.ask(state, { id: 'screen-share', text: question, model: 'gpt-5.4', screen: true, audioMode: 'transcript' })
  await waitFor(() => imageFrames.some(frame => frame.type === 'done'))
  assert.equal(imageFrames.find(frame => frame.type === 'done').status, 'ok')
  assert.ok(imageFrames.some(frame => frame.type === 'screen' && frame.state === 'attached'))
  const content = requests.at(-1).input.filter(item => item.role === 'user').flatMap(item => item.content || [])
  assert.ok(content.some(part => part.type === 'input_text' && part.text.includes(question)))
  const image = content.find(part => part.type === 'input_image')
  assert.ok(image, 'real native provider request must contain input_image, never just a text filename')
  assert.match(image.image_url, /^data:image\/png;base64,/)
  assert.deepEqual(Buffer.from(image.image_url.split(',')[1], 'base64'), png)
  assert.match(JSON.stringify(requests.at(-1)), /CODEX_NATIVE_AGENTS_INCLUDED/)
  assert.equal(requests.length, 4, 'screen is one additional native turn with no external provider')
  await assert.rejects(access(join(home, 'auth.json')))
  detach()
  assert.equal(mockError, undefined)
  await manager.close()
  await assertMcpStopped()
})
