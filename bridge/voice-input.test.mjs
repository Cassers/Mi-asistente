import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretVoice, encodeMP3, recognizedSpeech } from './voice-input.mjs'
import { audioEndpoint } from './audio-route.mjs'

function wavClip() {
  const bytes = Buffer.alloc(44 + 16000)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  for (let at = 44; at < bytes.length; at += 2) bytes.writeInt16LE(Math.round(Math.sin(at / 20) * 2000), at)
  return { mime: 'audio/wav', data: bytes.toString('base64') }
}

function fixture({ providerID = 'opencode-go', sdk = '@ai-sdk/openai', url = 'https://opencode.ai/inference/go/openai/v1', response, status = 200 } = {}) {
  const calls = [], notices = [], credentials = []
  const model = { id: 'chosen', api: { id: 'actual-model', npm: sdk, url }, capabilities: { input: { audio: true } } }
  const api = async (_method, path) => path === '/config' ? {} : path === '/agent' ? [] : path === '/provider' ? { all: [{ id: providerID, models: { chosen: model } }] } : []
  const args = { api, session: { id: 'ses_fixture' }, selection: { model: { providerID, modelID: 'chosen' }, agent: 'plan', variant: 'high' }, clip: wavClip(), text: 'Dictado de respaldo',
    encode: async () => Buffer.from('MP3-fixture'), credential: async provider => { credentials.push(provider); return 'fixture-key' },
    notify: notice => notices.push(notice), request: async (url, options) => { calls.push({ url, ...options }); return { ok: status === 200, json: async () => response ?? { output: [{ content: [{ type: 'output_text', text: JSON.stringify({ heard: true, transcript: 'Texto reconocido del MP3' }) }] }] } } },
  }
  return { args, calls, notices, credentials, model }
}

test('actual FFmpeg encoder creates MP3 bytes from bounded WAV; cancellation and invalid input reject', async () => {
  const mp3 = await encodeMP3(wavClip())
  assert.ok(mp3.length > 100)
  assert.notEqual(mp3.toString('ascii', 0, 4), 'RIFF')
  assert.ok(mp3.toString('ascii', 0, 3) === 'ID3' || mp3[0] === 0xff)
  await assert.rejects(encodeMP3({ mime: 'audio/wav', data: 'bad' }))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(encodeMP3(wavClip(), { signal: controller.signal }), { name: 'AbortError' })
})

test('missing-audio replies never become user text, including the exact production failure', async () => {
  const missing = 'No se ha detectado ningún audio adjunto para transcribir.'
  for (const value of [missing, JSON.stringify({ heard: false, transcript: missing }), JSON.stringify({ heard: true, transcript: missing }), JSON.stringify({ heard: true, transcript: 'No hay ningún audio disponible.' }), JSON.stringify({ heard: true, transcript: 'No tengo la capacidad de procesar audio.' }), JSON.stringify({ heard: 'true', transcript: 'fake' }), JSON.stringify({ heard: true, transcript: '' })]) {
    assert.throws(() => recognizedSpeech(value))
    const f = fixture({ response: { output: [{ content: [{ type: 'output_text', text: value }] }] } })
    assert.equal(await interpretVoice(f.args), 'Dictado de respaldo')
    assert.equal(f.notices.at(-1).state, 'fallback')
  }
  assert.equal(recognizedSpeech(JSON.stringify({ heard: true, transcript: 'Quiero cambiar el nombre del asistente.' })), 'Quiero cambiar el nombre del asistente.')
})

test('Go Responses receives only MP3 and the chosen model; native agent and reasoning selection are untouched', async () => {
  const f = fixture()
  assert.equal(await interpretVoice(f.args), 'Texto reconocido del MP3')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://opencode.ai/inference/go/openai/v1/responses')
  assert.equal(f.calls[0].headers['x-opencode-session'], 'ses_fixture:voice')
  const body = JSON.parse(f.calls[0].body)
  assert.equal(body.model, 'actual-model')
  assert.equal(body.reasoning.effort, 'minimal', 'minimal applies only to transcription preflight')
  assert.equal(body.input[0].content[1].input_audio.format, 'mp3')
  assert.equal(Buffer.from(body.input[0].content[1].input_audio.data, 'base64').toString(), 'MP3-fixture')
  assert.doesNotMatch(f.calls[0].body, /Dictado de respaldo|"agent"|"system"|"tools"/)
  assert.equal(body.store, false)
  assert.equal(f.args.selection.variant, 'high')
  assert.equal(f.args.selection.agent, 'plan')
  assert.deepEqual(f.notices.map(n => n.state), ['processing', 'interpreted'])
})

test('provider failures, silence, refusals, truncated output and conversion errors fall back without a second request', async () => {
  for (const options of [{ status: 400 }, { status: 429 }, { response: {} }, { response: { status: 'incomplete' } },
    { response: { output: [{ content: [{ type: 'output_text', text: 'No puedo interpretar el audio adjunto.' }] }] } }]) {
    const f = fixture(options)
    assert.equal(await interpretVoice(f.args), 'Dictado de respaldo')
    assert.equal(f.calls.length, 1)
    assert.equal(f.notices.at(-1).state, 'fallback')
  }
  const f = fixture()
  f.args.encode = async () => { throw Error('Missing encoder') }
  assert.equal(await interpretVoice(f.args), 'Dictado de respaldo')
  assert.equal(f.calls.length, 0)
})

test('unknown or project-overridden endpoints cannot receive existing credentials', async () => {
  for (const url of ['https://evil.example/v1', 'https://opencode.ai.evil.example/inference/go/openai/v1', 'http://opencode.ai/inference/go/openai/v1']) {
    const f = fixture({ url })
    assert.equal(await interpretVoice(f.args), 'Dictado de respaldo')
    assert.equal(f.calls.length, 0)
    assert.equal(f.credentials.length, 0)
  }
  const f = fixture({ providerID: 'unknown' })
  assert.equal(await interpretVoice(f.args), 'Dictado de respaldo')
  assert.equal(f.credentials.length, 0)
  assert.throws(() => audioEndpoint({ providerID: 'google', modelID: 'x', model: { api: { npm: '@ai-sdk/google', url: 'https://evil.example' } } }))
})

test('Go Chat and Google serialize MP3 correctly and parse only transcript text', async () => {
  for (const kind of ['chat', 'google']) {
    const google = kind === 'google'
    const f = fixture({ sdk: google ? '@ai-sdk/google' : '@ai-sdk/openai-compatible', url: 'https://opencode.ai/inference/go/' + (google ? 'google/v1beta' : 'openai/v1'),
      response: google ? { candidates: [{ content: { parts: [{ text: JSON.stringify({ heard: true, transcript: 'Google escuchó el clip' }) }] } }] } : { choices: [{ message: { content: JSON.stringify({ heard: true, transcript: 'Chat escuchó el clip' }) } }] } })
    assert.match(await interpretVoice(f.args), /escuchó el clip/)
    const body = JSON.parse(f.calls[0].body)
    if (google) assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'audio/mpeg')
    else assert.equal(body.messages[0].content[1].input_audio.format, 'mp3')
  }
})

test('interrupt during provider request never starts transcript fallback', async () => {
  const f = fixture(), controller = new AbortController()
  f.args.signal = controller.signal
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  f.args.request = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); entered()
  })
  const running = interpretVoice(f.args)
  await ready; controller.abort()
  await assert.rejects(running, { name: 'AbortError' })
  assert.deepEqual(f.notices.map(n => n.state), ['processing'])
})
