import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexManager } from './codex-runtime.mjs'
import { CodexRpc } from './codex-rpc.mjs'

const clip = value => {
  const bytes = Buffer.alloc(364)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(320, 40); bytes.writeInt16LE(value, 44)
  return { mime: 'audio/wav', data: bytes.toString('base64') }
}
const url = audio => 'data:audio/wav;base64,' + audio.data
const audioURLs = body => body.input.flatMap(item => item.content || []).filter(part => part.type === 'input_audio').map(part => part.audio_url)

// REAL installed app-server and persistence. SIMULATED audio-capable catalog,
// waveform and Responses provider. No auth copy, paid inference or microphone.
// No protocol snapshots/native prompts/audio receipts are written to the repo.
test('installed Codex audio: append-only prefix, restart/resume, ordered audio, native tools, stable Audio/LocalAudio', {
  skip: process.env.JARVIS_CODEX_NATIVE_SMOKE !== '1', timeout: 60000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-audio-native-'))
  const home = join(root, 'home'), directory = join(root, 'project')
  const requests = [], transports = [], methods = []
  let manager, mockError
  const mock = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/responses'); assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, undefined)
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body)
      assert.equal(body.model, 'fixture-audio')
      assert.ok(body.tools.length, 'native tool set is retained')
      let item
      if (requests.length === 1) {
        const tool = body.tools.find(tool => ['exec_command', 'shell_command', 'shell'].includes(tool.name))
        assert.ok(tool)
        const command = 'cat PROBE.txt'
        const args = tool.name === 'exec_command' ? { cmd: command } : tool.name === 'shell' ? { command: ['/bin/sh', '-c', command] } : { command }
        item = { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: tool.name, arguments: JSON.stringify(args), status: 'completed' }
      } else item = { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SIMULATED_AUDIO_RESPONSE', annotations: [] }] }
      const response = { id: `resp_${requests.length}`, created_at: 1, model: body.model, status: 'in_progress', output: [] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'response.created', response })
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } })
      if (item.type === 'function_call') send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
      send({ type: 'response.output_item.done', output_index: 0, item })
      send({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: {
        input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      } } })
      res.end()
    } catch (error) { mockError = error; res.writeHead(500); res.end('Fixture failure') }
  })
  t.after(async () => {
    await manager?.close(); for (const rpc of transports) await rpc.close()
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  await mkdir(home); await mkdir(directory)
  await writeFile(join(directory, 'AGENTS.md'), '# Fixture\nCODEX_AUDIO_NATIVE_CONTEXT: retain this project.\n')
  await writeFile(join(directory, 'PROBE.txt'), 'CODEX_AUDIO_NATIVE_TOOL_RESULT')
  // This synthetic model is NOT evidence that any real account model supports audio.
  await writeFile(join(root, 'models.json'), JSON.stringify({ models: [{
    slug: 'fixture-audio', display_name: 'Simulated audio capability', description: 'Local fixture only', base_instructions: 'Native audio protocol fixture.',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Fixture' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
    input_modalities: ['text', 'image', 'audio'], experimental_supported_tools: [], prefer_websockets: false,
    supports_reasoning_summaries: false, supports_parallel_tool_calls: false, support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
  }] }))
  await writeFile(join(home, 'config.toml'), `
model = "fixture-audio"
model_catalog_json = ${JSON.stringify(join(root, 'models.json'))}
model_provider = "loopback_fixture"
web_search = "disabled"
[model_providers.loopback_fixture]
name = "Local fixture"
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
`)
  const createManager = () => new CodexManager({ autoScreen: false, transportFactory: cwd => {
    const rpc = new CodexRpc({ cwd, command: process.env.JARVIS_CODEX_CLI || 'codex', env: { PATH: process.env.PATH, CODEX_HOME: home }, requestTimeoutMs: 10000 })
    const request = rpc.request.bind(rpc)
    rpc.request = (method, params) => { methods.push(method); return request(method, params) }
    transports.push(rpc); return rpc
  } })
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000
    while (!predicate()) {
      if (mockError) throw mockError
      if (Date.now() > deadline) throw new Error('Native audio fixture timed out: ' + methods.join(', '))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  manager = createManager()
  let runtime = await manager.runtime(directory), state = await runtime.open('new')
  assert.equal((await runtime.models())[0].audio, true)
  const threadId = state.id, prefix = clip(101), tail = clip(202), resumed = clip(303), ordinary = clip(404)
  await runtime.ask(state, { id: 'prefix', text: 'DO NOT FORWARD CAPTION', audioMode: 'direct', preserveOnly: true, audio: prefix })
  assert.equal(requests.length, 0, 'preserveOnly causes no inference')
  assert.equal(methods.includes('turn/start'), false)
  await manager.close()
  manager = createManager(); runtime = await manager.runtime(directory); state = await runtime.open(threadId)
  assert.equal(state.id, threadId); assert.equal(requests.length, 0)
  const frames = []; runtime.subscribe(state, frame => frames.push(frame))
  await runtime.ask(state, { id: 'tail', text: 'DO NOT FORWARD CAPTION', audioMode: 'direct', audio: tail })
  await waitFor(() => frames.some(frame => frame.type === 'done' && frame.ask === 'tail'))
  assert.equal(frames.find(frame => frame.type === 'done').status, 'ok')
  assert.equal(requests.length, 2, 'one user response plus native read-tool continuation')
  for (const request of requests) {
    assert.deepEqual(audioURLs(request), [url(prefix), url(tail)], 'each model step retains both original clips exactly once')
    assert.match(JSON.stringify(request.input), /CODEX_AUDIO_NATIVE_CONTEXT/)
    assert.doesNotMatch(JSON.stringify(request.input), /DO NOT FORWARD CAPTION/)
  }
  assert.match(JSON.stringify(requests[1].input), /CODEX_AUDIO_NATIVE_TOOL_RESULT/)
  await manager.close()
  manager = createManager(); runtime = await manager.runtime(directory); state = await runtime.open(threadId)
  assert.equal(requests.length, 2, 'resume cannot replay inference or audio appends')
  const frames2 = []; runtime.subscribe(state, frame => frames2.push(frame))
  await runtime.ask(state, { id: 'resumed', text: 'caption not sent', audioMode: 'direct', audio: resumed })
  await waitFor(() => frames2.some(frame => frame.type === 'done'))
  assert.deepEqual(audioURLs(requests.at(-1)), [url(prefix), url(tail), url(resumed)])
  // Independently prove the stable ordinary turn/start Audio + LocalAudio union
  // is handled by the actual CLI, not only our append-only lifecycle adapter.
  const path = join(root, 'ordinary.wav'); await writeFile(path, Buffer.from(ordinary.data, 'base64'))
  await runtime.rpc.request('turn/start', { threadId, input: [{ type: 'audio', url: url(ordinary) }, { type: 'localAudio', path }] })
  await waitFor(() => requests.length === 4 && !state.liveTurn && !state.active)
  assert.deepEqual(audioURLs(requests.at(-1)), [url(prefix), url(tail), url(resumed), url(ordinary), url(ordinary)])
  await manager.close()
  // Delete the input pathname BEFORE resuming: native LocalAudio must persist
  // self-contained content, not a stale dependency on the temporary file.
  await rm(path)
  manager = createManager(); runtime = await manager.runtime(directory); state = await runtime.open(threadId)
  assert.ok(runtime.transcript(state).some(row => row.text.includes('[Audio adjunto]')))
  let expected = [url(prefix), url(tail), url(resumed), url(ordinary), url(ordinary)]
  for (const committed of [false, true]) {
    const uncertain = clip(committed ? 606 : 505), frames3 = []
    runtime.subscribe(state, frame => frames3.push(frame))
    const request = runtime.rpc.request.bind(runtime.rpc)
    let loseReceipt = true
    runtime.rpc.request = async (method, params) => {
      if (method === 'thread/inject_items' && loseReceipt) {
        loseReceipt = false
        if (committed) await request(method, params)
        throw new Error('Simulated lost append confirmation')
      }
      return request(method, params)
    }
    const before = requests.length
    await assert.rejects(runtime.ask(state, { id: 'uncertain', text: 'caption', audioMode: 'direct', audio: uncertain }), /no confirmó/)
    assert.equal(requests.length, before)
    state = await runtime.open(threadId)
    await assert.rejects(runtime.ask(state, { id: 'automatic-retry', text: 'caption', audioMode: 'direct', audio: uncertain }), /audio anterior/)
    const id = committed ? 'recover-committed' : 'recover-not-committed'
    await runtime.ask(state, { id, text: 'Explicit text recovery without replay.', audioMode: 'transcript' })
    await waitFor(() => frames3.some(frame => frame.type === 'done' && frame.ask === id))
    if (committed) expected = [...expected, url(uncertain)]
    assert.deepEqual(audioURLs(requests.at(-1)), expected, 'uncertain append is retained if committed and is never replayed')
    assert.equal(state.audioUncertain, false)
  }
  await assert.rejects(access(join(home, 'auth.json')))
  assert.equal(mockError, undefined)
})
