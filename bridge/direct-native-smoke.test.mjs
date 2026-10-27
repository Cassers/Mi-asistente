import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { nativeClient } from './projects.mjs'
import { deliverNativeVoice } from './native-voice-delivery.mjs'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('actual OpenCode plugin sends native audio with project context and executes a native tool, no transcription API', {
  skip: process.env.JARVIS_DIRECT_NATIVE_SMOKE !== '1', timeout: 60000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-direct-native-')), requests = []
  const repo = fileURLToPath(new URL('../', import.meta.url)), project = join(root, 'project')
  let child, logs = '', step = 0
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url, body })
    const tools = body.tools || []
    const read = tools.find(tool => tool.name === 'read')
    const toolCall = step++ === 0 && read
    const item = toolCall ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: read.name, arguments: JSON.stringify({ filePath: join(project, 'check.txt') }), status: 'completed' }
      : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'AUDIO_DIRECTO_OK', annotations: [] }] }
    const response = { id: 'resp_fixture_' + step, created_at: 1, model: 'fixture-audio', status: 'in_progress', output: [] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    send({ type: 'response.created', response })
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, ...(toolCall ? { arguments: '' } : { content: [] }) } })
    if (toolCall) send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
    else {
      send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'AUDIO_DIRECTO_OK' })
    }
    send({ type: 'response.output_item.done', output_index: 0, item })
    send({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
    res.end()
  })
  t.after(async () => {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch {} await sleep(250); try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
  for (const dir of ['project', 'config', 'data', 'state', 'cache']) await mkdir(join(root, dir))
  await writeFile(join(project, 'AGENTS.md'), '# Fixture\nNATIVE_PROJECT_AUDIO_FIXTURE: use the native project context.\n')
  await writeFile(join(project, 'check.txt'), 'NATIVE_TOOL_FIXTURE_CONTENT')
  const router = join(root, 'router.mjs')
  await writeFile(router, `export default async()=>({config:async c=>{c.provider['opencode-go'].options.fetch=(url,init)=>{if(!String(url).startsWith('https://opencode.ai/inference/go/openai/v1/'))throw Error('Unexpected mock destination');return fetch('http://127.0.0.1:${mock.address().port}/responses',init)}}})`)
  const config = { $schema: 'https://opencode.ai/config.json', model: 'opencode-go/fixture-audio', default_agent: 'fixture',
    plugin: [pathToFileURL(router).href, pathToFileURL(join(repo, 'bridge/opencode-audio-plugin.mjs')).href],
    agent: { fixture: { mode: 'primary', description: 'Fixture agent', prompt: 'Keep native tools.' }, title: { disable: true } },
    permission: { '*': 'deny', read: 'allow' },
    provider: { 'opencode-go': { npm: '@ai-sdk/openai', options: { apiKey: 'fixture-only', baseURL: 'https://opencode.ai/inference/go/openai/v1' }, models: {
      'fixture-audio': { name: 'Fixture audio', modalities: { input: ['text', 'audio'], output: ['text'] }, limit: { context: 200000, output: 1000 } },
    } } },
  }
  await writeFile(join(project, 'opencode.json'), JSON.stringify(config))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key]
  Object.assign(env, { HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_SERVER_PASSWORD: 'fixture', OPENCODE_DISABLE_CLAUDE_CODE: '1' })
  child = spawn(join(repo, 'node_modules/.bin/opencode'), ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', c => { logs = (logs + c).slice(-6000) }); child.stderr.on('data', c => { logs = (logs + c).slice(-6000) })
  const base = 'http://127.0.0.1:' + port
  for (let i=0;i<150;i++) {
    try { if ((await fetch(base + '/global/health', { headers: { authorization: 'Basic ' + Buffer.from('opencode:fixture').toString('base64') }, signal: AbortSignal.timeout(300) })).ok) break } catch {}
    assert.equal(child.exitCode, null, logs); await sleep(100)
  }
  const api = nativeClient(base, project, { password: 'fixture' })
  const session = await api('POST', '/session', { title: 'Fixture direct audio' })
  const prefixData = Buffer.from('ID3-complete-preserved-prefix-fixture').toString('base64')
  const nextID = () => 'msg_' + Date.now().toString(16) + Math.random().toString(16).slice(2).padEnd(32, '0')
  await deliverNativeVoice(api, session.id, { messageID: nextID(), model: { providerID: 'opencode-go', modelID: 'fixture-audio' }, agent: 'fixture', parts: [
    { type: 'text', synthetic: true, text: 'Este es el primer clip de una intervención que continúa.' },
    { type: 'file', mime: 'audio/mpeg', filename: 'mi-asistente-voice-native-prefix-fixture.mp3', url: 'data:audio/mpeg;base64,' + prefixData },
  ] }, { noReply: true })
  assert.equal(requests.length, 0, 'preserving an interrupted prefix must not call a model')
  const data = Buffer.from('ID3-native-audio-fixture').toString('base64')
  await deliverNativeVoice(api, session.id, { messageID: nextID(), model: { providerID: 'opencode-go', modelID: 'fixture-audio' }, agent: 'fixture', parts: [
    { type: 'text', synthetic: true, text: 'Escucha el audio adjunto y responde.' },
    { type: 'file', mime: 'audio/mpeg', filename: 'mi-asistente-voice-native-fixture.mp3', url: 'data:audio/mpeg;base64,' + data },
  ] })
  let messages = []
  for (let i=0;i<180;i++) {
    messages = await api('GET', `/session/${session.id}/message`)
    if (messages.some(m => m.info.role === 'assistant' && (m.info.error || m.parts.some(p => p.type === 'text' && p.text.includes('AUDIO_DIRECTO_OK'))))) break
    await sleep(150)
  }
  assert.ok(messages.some(m => m.parts.some(p => p.type === 'text' && p.text.includes('AUDIO_DIRECTO_OK'))), JSON.stringify({ errors: messages.map(m => m.info.error).filter(Boolean), logs, requestCount: requests.length }))
  assert.ok(requests.length >= 2, 'native tool step must continue into another model request')
  assert.ok(requests[0].body.input.some(m => m.content?.some?.(p => p.type === 'input_audio' && p.input_audio.data === data)))
  assert.match(JSON.stringify(requests[0].body), /NATIVE_PROJECT_AUDIO_FIXTURE/)
  assert.ok(messages.some(m => m.parts.some(p => p.type === 'tool' && p.tool === 'read' && p.state.status === 'completed')))
  assert.match(JSON.stringify(requests.at(-1).body), /NATIVE_TOOL_FIXTURE_CONTENT/)
  assert.doesNotMatch(JSON.stringify(requests), /Transcribe el habla/)
  assert.ok(requests[0].body.input.some(m => m.content?.some?.(p => p.type === 'input_audio' && p.input_audio.data === prefixData)), 'the answer receives the preserved beginning too')
  const saved = messages.find(m => m.parts.some(p => p.metadata?.miAsistenteAudio?.data === data)).parts
  assert.ok(saved.some(p => p.type === 'text' && p.metadata?.miAsistenteAudio?.data === data))
  // Restart the real server, emptying the plugin's RAM registry. Both the
  // original audio and native tool result must survive reopening this chat.
  const old = child, exited = once(old, 'exit')
  process.kill(-old.pid, 'SIGTERM'); await exited
  child = spawn(join(repo, 'node_modules/.bin/opencode'), ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', c => { logs = (logs + c).slice(-6000) }); child.stderr.on('data', c => { logs = (logs + c).slice(-6000) })
  for (let i=0;i<150;i++) {
    try { if ((await fetch(base + '/global/health', { headers: { authorization: 'Basic ' + Buffer.from('opencode:fixture').toString('base64') }, signal: AbortSignal.timeout(300) })).ok) break } catch {}
    assert.equal(child.exitCode, null, logs); await sleep(100)
  }
  const before = requests.length
  const continuedData = Buffer.from('ID3-next-native-audio-fixture').toString('base64')
  await api('POST', `/session/${session.id}/prompt_async`, { model: { providerID: 'opencode-go', modelID: 'fixture-audio' }, agent: 'fixture', parts: [
    { type: 'text', synthetic: true, text: 'La respuesta anterior fue interrumpida. Este audio continúa la conversación.' },
    { type: 'file', mime: 'audio/mpeg', filename: 'mi-asistente-voice-native-next-fixture.mp3', url: 'data:audio/mpeg;base64,' + continuedData },
  ] })
  for (let i=0;i<180;i++) { if (requests.length > before) break; await sleep(150) }
  assert.ok(requests.length > before, logs)
  const resumedInput = requests[before].body.input
  const resumedAudios = resumedInput.flatMap(m => m.content || []).filter(p => p.type === 'input_audio').map(p => p.input_audio.data)
  assert.deepEqual(resumedAudios, [prefixData, data, continuedData], 'resuming must hydrate original clips from native metadata, in order')
  assert.match(JSON.stringify(resumedInput), /NATIVE_TOOL_FIXTURE_CONTENT/)
  assert.match(JSON.stringify(requests[before].body), /NATIVE_PROJECT_AUDIO_FIXTURE/)
})
