import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storeAudioParts, restoreAudioParts, audioFetch, AUDIO_META, PURPOSE_HEADER } from './native-audio-wire.mjs'
import Plugin from './opencode-audio-plugin.mjs'
const data = Buffer.from('ID3-fixture-audio').toString('base64')
const file = () => ({ id: 'prt_fixture', sessionID: 'ses_fixture', messageID: 'msg_fixture', type: 'file', mime: 'audio/mpeg', filename: 'mi-asistente-voice-fixture.mp3', url: 'data:audio/mpeg;base64,' + data })

test('native audio metadata survives restart and avoids both tokenized base64 and transcription', () => {
  const registry = new Map(), parts = [file()]
  storeAudioParts(parts, registry)
  assert.equal(parts[0].type, 'text'); assert.equal(parts[0].synthetic, true)
  assert.equal(parts[0].metadata[AUDIO_META].data, data)
  assert.ok(!parts[0].text.includes(data))
  const resumed = new Map()
  restoreAudioParts([{ info: { role: 'user' }, parts: structuredClone(parts) }], resumed)
  assert.deepEqual([...resumed], [...registry])
  const altered = structuredClone(parts); altered[0].text += 'changed'
  assert.throws(() => restoreAudioParts([{ info: { role: 'user' }, parts: altered }], resumed), /marcador/)
})

test('Go Responses preserves native context, tools, signal and stream while delivering real audio', async () => {
  const registry = new Map(), parts = [file()]; storeAudioParts(parts, registry)
  const signal = new AbortController().signal, calls = [], response = new Response('fixture')
  const wrapped = audioFetch(async (...args) => { calls.push(args); return response }, registry)
  const body = { model: 'chosen', stream: true, instructions: 'native project prompt', tools: [{ type: 'function', name: 'read' }],
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Listen.' }, { type: 'input_text', text: parts[0].text }] }] }
  assert.equal(await wrapped('https://opencode.ai/inference/go/openai/v1/responses', { headers: { authorization: 'fixture', [PURPOSE_HEADER]: 'conversation' }, body: JSON.stringify(body), signal }), response)
  const actual = JSON.parse(calls[0][1].body)
  assert.equal(actual.instructions, body.instructions); assert.deepEqual(actual.tools, body.tools)
  assert.equal(actual.stream, true); assert.equal(calls[0][1].signal, signal)
  assert.equal(actual.input[0].content[1].type, 'input_audio'); assert.equal(actual.input[0].content[1].input_audio.data, data)
  assert.equal(calls[0][1].headers.get(PURPOSE_HEADER), null)
  assert.equal(calls[0][1].headers.get('authorization'), 'fixture')
  assert.doesNotMatch(calls[0][1].body, /mi-asistente-audio|Transcribe/)
})

test('auxiliary title/compaction requests strip embedded markers without transmitting clips', async () => {
  const registry = new Map(), parts = [file()]; storeAudioParts(parts, registry)
  const wrapped = audioFetch(async (_url, init) => JSON.parse(init.body), registry)
  const actual = await wrapped('https://opencode.ai/inference/go/openai/v1/responses', { headers: { [PURPOSE_HEADER]: 'auxiliary' },
    body: JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: '[User]: ' + parts[0].text + '\n[Assistant]: Previous actual response.' }] }] }) })
  assert.match(JSON.stringify(actual), /Previous actual response/)
  assert.doesNotMatch(JSON.stringify(actual), /input_audio|mi-asistente-audio|SUQz/)
})

test('unsupported destinations cannot receive registered audio and missing audio cannot become fake text input', async () => {
  const registry = new Map(), parts = [file()]; storeAudioParts(parts, registry)
  let calls = 0
  const wrapped = audioFetch(async () => { calls++ }, registry)
  const init = { body: JSON.stringify({ input: [{ role: 'user', content: [{ type: 'input_text', text: parts[0].text }] }] }) }
  await assert.rejects(wrapped('https://evil.example/responses', init), /no admite/)
  const empty = audioFetch(async () => { calls++ }, new Map())
  await assert.rejects(empty('https://opencode.ai/inference/go/openai/v1/responses', init), /audio original/)
  assert.equal(calls, 0)
})

test('plugin composes existing provider fetch and handles only owned audio attachments', async () => {
  let called = 0
  const config = { provider: { 'opencode-go': { options: { apiKey: 'fixture', fetch: async () => { called++; return new Response('ok') } } } } }
  const hooks = await Plugin(); await hooks.config(config)
  assert.equal(config.provider['opencode-go'].options.apiKey, 'fixture')
  await config.provider['opencode-go'].options.fetch('https://opencode.ai/inference/go/openai/v1/responses', { body: '{}' })
  assert.equal(called, 1)
  const output = { parts: [file(), { ...file(), filename: 'another-app.mp3' }] }
  await hooks['chat.message']({}, output)
  assert.equal(output.parts[0].type, 'text'); assert.equal(output.parts[1].type, 'file')
})

test('long persisted audio history can continue and compact without losing current clips to a cache ceiling', async () => {
  const parts = Array.from({ length: 600 }, (_, i) => ({ ...file(), url: 'data:audio/mpeg;base64,' + Buffer.from('ID3-fixture-' + i).toString('base64') }))
  const registry = new Map()
  storeAudioParts(parts, registry)
  restoreAudioParts([{ info: { role: 'user' }, parts }], registry)
  assert.equal(registry.size, 600, 'current history must never be truncated by unrelated cache limits')
  const wrapped = audioFetch(async (_url, init) => JSON.parse(init.body), registry)
  const input = [{ role: 'user', content: parts.map(part => ({ type: 'input_text', text: part.text })) }]
  const body = await wrapped('https://opencode.ai/inference/go/openai/v1/responses', { body: JSON.stringify({ input }) })
  assert.equal(body.input[0].content.filter(part => part.type === 'input_audio').length, 600)
  const summary = await wrapped('https://opencode.ai/inference/go/openai/v1/responses', { headers: { [PURPOSE_HEADER]: 'auxiliary' }, body: JSON.stringify({ input }) })
  assert.doesNotMatch(JSON.stringify(summary), /input_audio|mi-asistente-audio/)
  const other = [{ ...file(), url: 'data:audio/mpeg;base64,' + Buffer.from('ID3-concurrent-B').toString('base64') }]
  storeAudioParts(other, registry)
  restoreAudioParts([{ info: { role: 'user' }, parts: other }], registry)
  const concurrent = await wrapped('https://opencode.ai/inference/go/openai/v1/responses', { body: JSON.stringify({ input }) })
  assert.equal(concurrent.input[0].content.filter(part => part.type === 'input_audio').length, 600, 'another session transform cannot evict an in-flight history')
})
