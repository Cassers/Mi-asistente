import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenPrompt } from './screen-context.mjs'

test('every question gets a fresh principal-monitor attachment and original text', async () => {
  let captures = 0
  const states = []
  const capture = async (monitor) => {
    assert.equal(monitor, 'principal')
    return { data: Buffer.from(`frame-${++captures}`).toString('base64'), mimeType: 'image/jpeg' }
  }
  const first = await screenPrompt('¿Qué significa esto?', { capture, onState: (s) => states.push(s) })
  const second = await screenPrompt('¿Y ahora?', { capture })
  assert.equal(captures, 2)
  assert.deepEqual(states, ['capturing', 'attached'])
  assert.deepEqual(first.parts[0], { type: 'text', text: '¿Qué significa esto?' })
  assert.equal(first.parts[1].type, 'file')
  assert.equal(first.parts[1].mime, 'image/jpeg')
  assert.match(first.parts[1].url, /^data:image\/jpeg;base64,/)
  assert.notEqual(first.parts[1].url, second.parts[1].url)
})

test('a capture failure sends only text and explicitly disclaims current vision', async () => {
  const states = []
  const result = await screenPrompt('¿Qué ves?', {
    capture: async () => { throw new Error('grim unavailable') },
    onState: (s) => states.push(s),
  })
  assert.equal(result.parts.length, 1)
  assert.match(result.context, /No hay imagen actual/)
  assert.deepEqual(states, ['capturing', 'failed'])
})

test('PNG fallback and explicit secondary monitor retain their metadata', async () => {
  const result = await screenPrompt('Lee esto', {
    monitor: 'secundario',
    capture: async (monitor) => {
      assert.equal(monitor, 'secundario')
      return { data: 'cG5n', mimeType: 'image/png' }
    },
  })
  assert.equal(result.parts[1].mime, 'image/png')
  assert.equal(result.parts[1].filename, 'monitor-secundario.png')
})

test('interruption during capture discards the image instead of sending a stale turn', async () => {
  const controller = new AbortController()
  const states = []
  const pending = screenPrompt('Turno cancelado', {
    signal: controller.signal,
    onState: (s) => states.push(s),
    capture: async () => {
      controller.abort()
      return { data: 'c3RhbGU=', mimeType: 'image/jpeg' }
    },
  })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(states, ['capturing'])
})

test('missing image is treated as a capture failure, not an empty attachment', async () => {
  const result = await screenPrompt('Pregunta', { capture: async () => ({ data: '', mimeType: 'image/jpeg' }) })
  assert.equal(result.parts.length, 1)
  assert.match(result.context, /Falló la captura/)
})
