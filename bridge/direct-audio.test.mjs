import { test } from 'node:test'
import assert from 'node:assert/strict'
import { directAudio } from './direct-audio.mjs'
const selection = { model: { providerID: 'opencode-go', modelID: 'fixture' }, agent: 'plan', variant: 'high' }
function fixture(enabled = true, audio = true) {
  const calls = [], api = async (method, path) => {
    calls.push([method, path])
    if (path === '/config') return { plugin: enabled ? ['file:///fixture/opencode-audio-plugin.mjs'] : [] }
    if (path === '/agent' || path.endsWith('/message')) return []
    return { all: [{ id: 'opencode-go', models: { fixture: { id: 'fixture', capabilities: { input: { audio } }, api: { npm: '@ai-sdk/openai', url: 'https://opencode.ai/inference/go/openai/v1' } } } }] }
  }
  return { calls, options: { api, session: { id: 'ses_fixture' }, selection, clip: {}, encode: async () => Buffer.from('ID3-direct-audio') } }
}
test('direct audio produces native MP3 attachment without transcription, credential reads or provider preflight', async () => {
  const f = fixture(), part = await directAudio(f.options)
  assert.equal(part.mime, 'audio/mpeg'); assert.match(part.filename, /^mi-asistente-voice-/)
  assert.match(part.url, /^data:audio\/mpeg;base64,/)
  assert.ok(f.calls.every(([method]) => method === 'GET'))
  assert.equal(f.options.selection.agent, 'plan'); assert.equal(f.options.selection.variant, 'high')
})
test('unsupported models, missing adapters and cancellation fail explicitly without text fallback', async () => {
  await assert.rejects(directAudio(fixture(false).options), /adaptador/)
  await assert.rejects(directAudio(fixture(true, false).options), /no acepta audio/)
  const f = fixture(), ctl = new AbortController(); ctl.abort(); f.options.signal = ctl.signal
  await assert.rejects(directAudio(f.options), { name: 'AbortError' })
})
