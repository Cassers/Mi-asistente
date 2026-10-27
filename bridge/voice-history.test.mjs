import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recoverVoiceHistory } from './voice-history.mjs'

function fixture({ busy = false, corruptBackup = false, foreign = false } = {}) {
  const session = { id: 'ses_live', directory: '/fixture', title: 'Chat original' }
  const first = 'msg_' + 'a'.repeat(43), second = 'msg_' + 'b'.repeat(43)
  const messages = [
    { info: { id: first, role: 'user' }, parts: [
      { id: 'prt_text', type: 'text', text: 'Texto humano que debe conservarse.' },
      { id: 'prt_wav', type: 'file', filename: 'mi-voz.wav', mime: 'audio/wav', url: 'data:audio/wav;base64,fixture' },
      { id: 'prt_image', type: 'file', filename: 'monitor.jpg', mime: 'image/jpeg', url: 'data:image/jpeg;base64,image' },
    ] },
    { info: { id: 'msg_error_a', role: 'assistant', parentID: first, error: { data: { message: "'file part media type audio/wav' functionality not supported." } } }, parts: [] },
    { info: { id: second, role: 'user' }, parts: [{ id: 'prt_false', type: 'text', text: 'No se ha detectado ningún audio adjunto para transcribir.' }] },
    { info: { id: 'msg_error_b', role: 'assistant', parentID: second, error: { data: { message: "'file part media type audio/wav' functionality not supported." } } }, parts: [] },
  ]
  const original = structuredClone(messages), calls = []
  let backup
  const api = async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'GET' && path === '/session/status') return busy ? { ses_live: { type: 'busy' } } : {}
    if (method === 'GET' && path === '/session/ses_live') return { ...session, ...(foreign ? { directory: '/foreign' } : {}) }
    if (method === 'GET' && path === '/session/ses_live/message') return structuredClone(messages)
    if (method === 'POST' && path === '/session/ses_live/fork') { backup = structuredClone(messages); return { id: 'ses_backup', directory: session.directory } }
    if (method === 'GET' && path === '/session/ses_backup/message') {
      const copy = structuredClone(backup)
      if (corruptBackup) copy[0].parts[0].text = 'Truncated backup'
      return copy
    }
    if (method === 'PATCH' && path === '/session/ses_backup') return true
    const parts = path.split('/'), message = messages.find(message => message.info.id === parts[4])
    const index = message?.parts.findIndex(part => part.id === parts[6])
    if (index >= 0 && method === 'DELETE') { message.parts.splice(index, 1); return true }
    if (index >= 0 && method === 'PATCH') { message.parts[index] = structuredClone(body); return body }
    throw Error(`Unexpected ${method} ${path}`)
  }
  return { session, api, messages, original, calls, backup: () => backup }
}

test('recovery verifies native backup, removes only own failed WAV and hides false status without losing text', async () => {
  const f = fixture()
  const recovered = await recoverVoiceHistory(f.api, f.session)
  assert.deepEqual(recovered, { backupID: 'ses_backup', removed: 1, hidden: 1 })
  assert.deepEqual(f.backup(), f.original, 'full original including audio remains recoverable')
  assert.ok(f.calls.find(call => call.method === 'PATCH' && call.path === '/session/ses_backup').body.time.archived, 'backup must not become the latest active chat')
  assert.equal(f.messages[0].parts.some(part => part.id === 'prt_wav'), false)
  assert.equal(f.messages[0].parts.some(part => part.id === 'prt_image'), true)
  assert.equal(f.messages[2].parts[0].ignored, true)
  assert.equal(f.messages[2].parts[0].text, f.original[2].parts[0].text)
  assert.equal(f.messages[0].parts[0].text, f.original[0].parts[0].text)
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1)
  assert.ok(f.calls.filter(call => call.method === 'DELETE').every(call => call.path.endsWith('/part/prt_wav')))
  assert.equal(await recoverVoiceHistory(f.api, f.session), null, 'idempotent after recovery')
})

test('busy, foreign or incomplete backups never cause original history writes', async () => {
  for (const options of [{ busy: true }, { foreign: true }, { corruptBackup: true }]) {
    const f = fixture(options)
    await assert.rejects(recoverVoiceHistory(f.api, f.session))
    assert.deepEqual(f.messages, f.original)
    assert.ok(!f.calls.some(call => ['PATCH', 'DELETE'].includes(call.method) && call.path.includes('/ses_live/')))
  }
})

test('ordinary uploads and genuine unfailed user text are not repaired or hidden', async () => {
  const f = fixture()
  for (const message of f.messages) delete message.info.error
  assert.equal(await recoverVoiceHistory(f.api, f.session), null)
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0)
  const unowned = fixture()
  unowned.messages[0].parts[1].filename = 'my-recording.wav'
  unowned.messages[2].parts[0].text = 'Hola, esta frase sí la dije yo.'
  assert.equal(await recoverVoiceHistory(unowned.api, unowned.session), null)
})

test('abort after backup verification prevents any original change', async () => {
  const f = fixture(), controller = new AbortController()
  const api = async (...args) => {
    const result = await f.api(...args)
    if (args[1] === '/session/ses_backup/message') controller.abort()
    return result
  }
  await assert.rejects(recoverVoiceHistory(api, f.session, { signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(f.messages, f.original)
})
