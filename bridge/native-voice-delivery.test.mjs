import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliverNativeVoice } from './native-voice-delivery.mjs'
const request = { messageID: 'msg_fixture', model: { providerID: 'fixture', modelID: 'audio' }, parts: [
  { type: 'text', synthetic: true, text: 'Audio only.' },
  { type: 'file', mime: 'audio/mpeg', url: 'data:audio/mpeg;base64,fixture-audio' },
] }
const message = data => ({ info: { id: request.messageID }, parts: [{ type: 'text', synthetic: true, metadata: { miAsistenteAudio: { data } } }] })

test('preserved audio uses one synchronous native noReply call and checks the exact bytes', async () => {
  const calls = []
  const result = await deliverNativeVoice(async (...args) => { calls.push(args); return message('fixture-audio') }, 'ses_fixture', request, { noReply: true })
  assert.equal(result.info.id, request.messageID)
  assert.deepEqual(calls.map(([method, path, body]) => [method, path, body.noReply]), [['POST', '/session/ses_fixture/message', true]])
  assert.deepEqual(calls[0][2].parts, request.parts)
  await assert.rejects(deliverNativeVoice(async () => message('wrong-audio'), 'ses_fixture', request, { noReply: true }), /no confirmó/)
})

test('async acceptance and a partial text-only message cannot acknowledge audio persistence', async () => {
  const calls = []; let reads = 0
  await deliverNativeVoice(async (...args) => {
    calls.push(args)
    if (args[0] === 'POST') return null
    reads++
    if (reads === 1) throw new Error('OpenCode respondió HTTP 404.')
    if (reads === 2) return { info: { id: request.messageID }, parts: [{ type: 'text', text: 'not yet stored' }] }
    return message('fixture-audio')
  }, 'ses_fixture', request)
  assert.equal(calls.filter(call => call[0] === 'POST').length, 1, 'receipt polling must never duplicate an audio message')
  assert.equal(reads, 3)
  assert.equal(calls[1][1], '/session/ses_fixture/message/msg_fixture')
})

test('receipt timeout and auth errors remain explicit instead of pretending that the clip was saved', async () => {
  await assert.rejects(deliverNativeVoice(async method => method === 'POST' ? null : message('different'), 'ses_fixture', request, { receiptTimeoutMs: 30 }), error => error.name === 'AbortError' || error.name === 'TimeoutError')
  await assert.rejects(deliverNativeVoice(async method => { if (method === 'POST') return null; throw new Error('OpenCode respondió HTTP 401.') }, 'ses_fixture', request), /401/)
  await assert.rejects(deliverNativeVoice(async () => assert.fail('invalid request must never be submitted'), 'ses_fixture', { ...request, parts: [] }), /Falta el clip/)
})

test('lost POST responses reconcile the original saved message without duplicate audio writes', async () => {
  for (const noReply of [false, true]) {
    const calls = []
    const actual = await deliverNativeVoice(async (...args) => {
      calls.push(args)
      if (args[0] === 'POST') throw new TypeError('fetch failed after native commit')
      return message('fixture-audio')
    }, 'ses_fixture', request, { noReply })
    assert.equal(actual.info.id, request.messageID)
    assert.equal(calls.filter(call => call[0] === 'POST').length, 1)
    assert.equal(calls[1][1], '/session/ses_fixture/message/' + request.messageID)
  }
})
