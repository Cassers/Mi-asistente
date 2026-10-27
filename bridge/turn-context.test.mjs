import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { turnParts, transcript } from './turn-context.mjs'

test('time and visual state are metadata of the new message, not system instructions', () => {
  const image = { type: 'file', mime: 'image/jpeg', url: 'file:///tmp/test.jpg' }
  const visual = { context: 'Hay una captura actual.', parts: [{ type: 'text', text: 'Mi pregunta' }, image] }
  const first = turnParts(visual, { now: 1792231200000, historyRoot: '/tmp/history' })
  const second = turnParts(visual, { now: 1792231201000, historyRoot: '/tmp/history' })
  assert.equal(first[0].synthetic, true)
  assert.match(first[0].text, /Timestamp exacto: .*Z/)
  assert.match(first[0].text, /captura actual/)
  assert.notEqual(first[0].text, second[0].text)
  assert.deepEqual(first.slice(1), visual.parts)
  assert.equal(first.filter((p) => p.type === 'file').length, 1)
})

test('restored transcript excludes metadata, tool output, reasoning and media', () => {
  assert.deepEqual(transcript([
    { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'private timestamp', synthetic: true }, { type: 'text', text: 'Hola' }, { type: 'file', mime: 'image/jpeg' }] },
    { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'reasoning', text: 'hidden' }, { type: 'tool' }, { type: 'text', text: 'Buenos días.' }] },
  ]), [{ id: 'm1', role: 'user', text: 'Hola' }, { id: 'm2', role: 'jarvis', text: 'Buenos días.' }])
})

test('direct audio history shows an audio label without leaking transport markers, encoded audio or synthetic instructions', () => {
  for (const audio of [
    { type: 'file', mime: 'audio/mpeg', url: 'data:audio/mpeg;base64,PRIVATE' },
    { type: 'text', synthetic: true, text: '[mi-asistente-audio:secret]', metadata: { miAsistenteAudio: { data: 'PRIVATE', format: 'mp3' } } },
  ]) {
    assert.deepEqual(transcript([{ info: { id: 'audio-one', role: 'user' }, parts: [
      { type: 'text', synthetic: true, text: 'Private transport instruction' }, audio,
    ] }]), [{ id: 'audio-one', role: 'user', text: '🎤 Audio enviado' }])
  }
})

test('native instruction files exist and the bridge sends no changing system override', async () => {
  const config = JSON.parse(await readFile(new URL('../opencode/xdg/opencode/opencode.json', import.meta.url), 'utf8'))
  await access(new URL('../opencode/workspace/AGENTS.md', import.meta.url))
  for (const file of config.instructions) await access(new URL('../opencode/workspace/' + file, import.meta.url))
  const bridge = await readFile(new URL('./opencode-bridge.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(bridge, /system:|nowContext|PERSONA|jarvis-prompt\.md/)
  assert.match(bridge, /parts: turnParts\(/)
})
