import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, access, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Permissions } from './permissions.mjs'
import { sessionMedia } from './session-media.mjs'
import { screenPrompt } from './screen-context.mjs'
import { reviewHistoryAudio } from './history-audio.mjs'

test('permissions are scoped, never auto-granted, and only once/reject are accepted', async () => {
  const replies = [], published = []
  const queue = new Permissions({ session: () => 'ses_ours', reply: async (...args) => replies.push(args), publish: (p) => published.push(p) })
  queue.receive({ id: 'per_other', sessionID: 'ses_other', permission: 'bash' })
  queue.receive({ id: 'per_ours', sessionID: 'ses_ours', permission: 'bash', patterns: ['printf test'] })
  assert.equal(queue.pending.size, 1)
  assert.equal(replies.length, 0)
  assert.equal(await queue.respond('per_other', 'once'), false)
  assert.equal(await queue.respond('per_ours', 'always'), false)
  assert.equal(await queue.respond('per_ours', 'once'), true)
  assert.equal(await queue.respond('per_ours', 'once'), false)
  assert.deepEqual(replies, [['per_ours', 'once']])
  assert.deepEqual(published.at(-1), [])
  queue.receive({ id: 'per_next', sessionID: 'ses_ours' })
  await queue.rejectAll()
  assert.deepEqual(replies.at(-1), ['per_next', 'reject'])
})

test('failed permission reply stays visible and can be rejected', async () => {
  const queue = new Permissions({ session: () => 's', reply: async () => { throw new Error('offline') }, publish: () => {} })
  queue.receive({ id: 'p', sessionID: 's' })
  await assert.rejects(queue.respond('p', 'once'), /offline/)
  assert.equal(queue.pending.size, 1)
  await queue.rejectAll()
  assert.equal(queue.pending.size, 0)
})

test('failed in-flight approval cannot resurrect a permission after cancellation', async () => {
  let fail
  const queue = new Permissions({ session: () => 's', reply: () => new Promise((_, reject) => { fail = reject }), publish: () => {} })
  queue.receive({ id: 'p', sessionID: 's' })
  const response = queue.respond('p', 'once')
  await queue.rejectAll()
  fail(new Error('cancelled'))
  await assert.rejects(response, /cancelled/)
  assert.equal(queue.pending.size, 0)
})

test('automatic screenshot uses a private local file and removes it on session close', async () => {
  const media = await sessionMedia()
  try {
    const visual = await screenPrompt('Pregunta', { capture: async () => ({ data: 'cGl4ZWxz', mimeType: 'image/png' }), attach: media.attach })
    const path = fileURLToPath(visual.parts[1].url)
    assert.equal(await readFile(path, 'utf8'), 'pixels')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    await media.close()
    await assert.rejects(access(path))
    await assert.rejects(media.attach({ data: 'cA==', mimeType: 'image/png' }), /closed/)
  } finally { await media.close() }
})

test('cancelled screenshot is not attached or sent', async () => {
  const media = await sessionMedia()
  const controller = new AbortController()
  try {
    await assert.rejects(screenPrompt('Pregunta', { signal: controller.signal,
      capture: async () => ({ data: 'cA==', mimeType: 'image/png' }),
      attach: async (image, options) => { controller.abort(); return media.attach(image, options) },
    }), { name: 'AbortError' })
  } finally { await media.close() }
})

test('native audio sends exactly one WAV per standard free session and deletes sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-audio-test-'))
  const wav = Buffer.alloc(44 + 32000)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(32000, 40)
  for (let i = 0; i < 16000; i++) wav.writeInt16LE(Math.round(Math.sin(i * 0.2) * 4000), 44 + i * 2)
  await writeFile(join(dir, 'audio.wav'), wav)
  const messages = [], deleted = []
  const request = async (url, options) => {
    const path = new URL(url).pathname
    let result = true
    if (path === '/provider') result = { all: [{ id: 'opencode', models: { 'mimo-v2.6-flash-free': { cost: { input: 0, output: 0 } } } }] }
    if (path === '/session') {
      assert.deepEqual(JSON.parse(options.body).permission, [
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'question', pattern: '*', action: 'deny' },
        { permission: 'jarvis_desktop_*', pattern: '*', action: 'deny' },
      ])
      result = { id: `ses_${messages.length}` }
    }
    if (path.endsWith('/message')) {
      messages.push(JSON.parse(options.body))
      result = { info: { cost: 0 }, parts: [{ type: 'text', text: 'Audio de prueba.' }] }
    }
    if (path === '/permission') result = []
    if (options.method === 'DELETE') deleted.push(path)
    return new Response(JSON.stringify(result))
  }
  const clips = ['mic', 'system'].map((source) => ({ source, bytes: wav.length, at: Date.now() - 10000, end: Date.now(), path: join(dir, 'audio.wav') }))
  let result
  try { result = await reviewHistoryAudio(clips, { request }) }
  finally { await rm(dir, { recursive: true, force: true }) }
  assert.equal(messages.length, 2)
  assert.equal(deleted.length, 2)
  for (const body of messages) {
    assert.equal(body.agent, 'build')
    assert.equal(body.model.modelID, 'mimo-v2.6-flash-free')
    assert.equal(body.tools, undefined)
    assert.equal(body.parts.filter((p) => p.type === 'file').length, 1)
    assert.match(body.parts[1].url, /^data:audio\/wav;base64,/)
  }
  assert.equal(result.tracks.every((t) => t.nativeAudio), true)
})

test('audio does not send media if the free model is missing or no longer zero cost', async () => {
  let calls = 0
  await assert.rejects(reviewHistoryAudio([{ source: 'mic' }], { request: async () => {
    calls++
    return new Response(JSON.stringify({ all: [] }))
  } }), /coste cero/)
  assert.equal(calls, 1)
})
