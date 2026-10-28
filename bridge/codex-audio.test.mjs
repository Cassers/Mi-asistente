import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixture, until } from './codex-test-fixture.mjs'
import { CodexRuntime } from './codex-runtime.mjs'
import { voiceAttachment } from './voice-attachment.mjs'

export function wavClip(value = 1) {
  const bytes = Buffer.alloc(364)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40); bytes.writeInt16LE(value, 44)
  return { mime: 'audio/wav', data: bytes.toString('base64') }
}
const direct = (patch = {}) => ({ id: 'audio', audioMode: 'direct', text: 'BROWSER CAPTION MUST NOT REACH CODEX', model: 'codex-image', audio: wavClip(), ...patch })
const appends = f => f.rpc.calls.filter(c => c.method === 'thread/inject_items')
const starts = f => f.rpc.calls.filter(c => c.method === 'turn/start')

test('direct audio persists original validated PCM data URI before generation; browser text is never forwarded', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  f.runtime.subscribe(state, frame => frames.push(frame))
  const message = direct()
  await f.runtime.ask(state, message)
  const append = appends(f)[0].params
  assert.equal(append.threadId, state.id)
  assert.equal(append.items[0].role, 'user')
  assert.equal(append.items[0].content[1].audio_url, voiceAttachment(message.audio).url)
  assert.doesNotMatch(JSON.stringify(f.rpc.calls), /BROWSER CAPTION/)
  assert.ok(f.rpc.calls.indexOf(appends(f)[0]) < f.rpc.calls.indexOf(starts(f)[0]))
  for (const key of ['sandboxPolicy', 'approvalPolicy', 'baseInstructions', 'developerInstructions']) assert.equal(Object.hasOwn(starts(f)[0].params, key), false)
  assert.ok(frames.some(x => x.type === 'audio' && x.state === 'attached'))
  assert.ok(frames.some(x => x.type === 'submitted'))
  assert.deepEqual(f.runtime.transcript(state).map(x => x.text), ['[Audio adjunto]'])
})

test('preserveOnly appends exactly once without inference; next clip remains in same thread', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  f.runtime.subscribe(state, x => frames.push(x))
  await f.runtime.ask(state, direct({ preserveOnly: true }))
  assert.equal(appends(f).length, 1); assert.equal(starts(f).length, 0); assert.equal(state.op, null)
  assert.equal(frames.some(x => x.type === 'submitted'), false)
  assert.equal(frames.find(x => x.type === 'done').status, 'cancelled')
  await f.runtime.interrupt(state, undefined, 'speech')
  await f.runtime.ask(state, direct({ id: 'tail', audio: wavClip(2) }))
  assert.equal(appends(f).length, 2); assert.equal(starts(f).length, 1)
  assert.deepEqual(appends(f).map(x => x.params.threadId), [state.id, state.id])
  assert.match(starts(f)[0].params.input[0].text, /continúa o corrige/)
})

test('barge-in waits for pending append; prefix stays native and never starts a response', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a')
  let release
  f.rpc.handlers.set('thread/inject_items', () => new Promise(resolve => { release = resolve }))
  const asking = f.runtime.ask(state, direct())
  await until(() => release)
  let stopped = false
  const stopping = f.runtime.interrupt(state, undefined, 'speech').then(() => { stopped = true })
  await new Promise(setImmediate)
  assert.equal(stopped, false); assert.equal(state.op.controller.signal.aborted, false)
  await assert.rejects(f.runtime.ask(state, direct({ id: 'too-early' })), /trabajando/)
  release({}); await asking; await stopping
  assert.equal(starts(f).length, 0); assert.equal(appends(f).length, 1)
  f.rpc.handlers.delete('thread/inject_items')
  await f.runtime.ask(state, direct({ id: 'tail', audio: wavClip(2) }))
  assert.equal(appends(f).length, 2); assert.match(starts(f)[0].params.input[0].text, /continúa o corrige/)
})

test('speech during screen preparation preserves audio and suppresses generation', async t => {
  let release
  const f = await fixture(t, { autoScreen: true, screen: () => new Promise(resolve => { release = resolve }) }), state = await f.runtime.open('thr-a')
  const asking = f.runtime.ask(state, direct())
  await until(() => release)
  const stopping = f.runtime.interrupt(state, undefined, 'speech')
  release({ context: '', parts: [] }); await asking; await stopping
  assert.equal(appends(f).length, 1); assert.equal(starts(f).length, 0)
})

test('uncertain append fails ask AND stop, acknowledges neither audio nor submission, and blocks automatic replay', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  f.runtime.subscribe(state, x => frames.push(x))
  let release
  f.rpc.handlers.set('thread/inject_items', () => new Promise((_, reject) => { release = reject }))
  const asking = f.runtime.ask(state, direct())
  const rejected = assert.rejects(asking, /no confirmó la conservación/)
  await until(() => release)
  const stopping = assert.rejects(f.runtime.interrupt(state, undefined, 'speech'), /no confirmó la conservación/)
  release(new Error('Lost native append response'))
  await rejected; await stopping
  assert.equal(frames.some(x => x.type === 'submitted' || x.type === 'done' || x.type === 'audio'), false)
  await assert.rejects(f.runtime.ask(state, direct({ id: 'next' })), /audio anterior/)
  assert.equal(appends(f).length, 1); assert.equal(starts(f).length, 0)
})

test('failed generation after audio append never appends that clip again or falls back to dictation', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a')
  f.rpc.handlers.set('turn/start', () => { throw new Error('Turn rejected') })
  await assert.rejects(f.runtime.ask(state, direct()), /Turn rejected/)
  assert.equal(appends(f).length, 1); assert.equal(state.audioUncertain, false)
  assert.deepEqual(f.runtime.transcript(state).map(x => x.text), ['[Audio adjunto]'])
})

test('unsupported models and malformed clips cannot append, infer, or falsely signal sent', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
  f.runtime.subscribe(state, x => frames.push(x))
  for (const message of [direct({ model: 'codex-text' }), direct({ audio: { mime: 'audio/wav', data: 'bad' } }), direct({ audio: null }), direct({ audioMode: 'clip' }), direct({ audioMode: 'transcript', preserveOnly: true })]) {
    await assert.rejects(f.runtime.ask(state, message))
  }
  assert.equal(appends(f).length + starts(f).length, 0)
  assert.equal(frames.some(x => x.type === 'submitted' || x.type === 'audio'), false)
  const models = await f.runtime.models()
  assert.equal(models[0].audio, false); assert.equal(models[1].audio, true)
})

test('audio-only native history renders markers without exposing bytes or losing typed content', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a')
  f.rpc.history.set(state.id, [{ id: 'native-audio', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Typed context' }, { type: 'audio', url: 'data:audio/wav;base64,private' }, { type: 'localAudio', path: '/private' }] }] }])
  const rows = await f.runtime.hydrate(state)
  assert.equal(rows[0].text, 'Typed context\n[Audio adjunto]\n[Audio adjunto]')
  assert.doesNotMatch(JSON.stringify(rows), /base64|private/)
})

test('unknown or older native client version exposes no audio capability even with model metadata', async t => {
  const f = await fixture(t)
  for (const userAgent of ['unknown', 'mi_asistente/0.158.0']) {
    const runtime = new CodexRuntime(f.directory, Object.assign(f.rpc, { start: async () => ({ userAgent }) }), { autoScreen: false })
    await runtime.initialize()
    assert.equal(runtime.directAudioSupported, false)
    assert.equal((await runtime.models())[1].audio, false)
    await assert.rejects(runtime.ask(await runtime.open('thr-a'), direct()), /0.159.0/)
  }
})

test('uncertain append recovers through explicit text after reopen/history verification; no clip is replayed', async t => {
  for (const committed of [false, true]) {
    const f = await fixture(t), state = await f.runtime.open('thr-a'), frames = []
    f.runtime.subscribe(state, frame => frames.push(frame))
    f.rpc.handlers.set('thread/inject_items', () => {
      // Raw injected items do not appear as native user-turn rows in either case.
      if (committed) f.rpc.history.set(state.id, [])
      throw new Error('Confirmation unavailable')
    })
    await assert.rejects(f.runtime.ask(state, direct()), /no confirmó/)
    assert.equal(await f.runtime.open(state.id), state)
    await assert.rejects(f.runtime.ask(state, direct({ id: 'automatic-tail' })), /audio anterior/)
    await f.runtime.ask(state, { id: 'recovery', text: 'Continue using this explicit text.', audioMode: 'transcript' })
    assert.equal(state.audioUncertain, false)
    assert.equal(appends(f).length, 1, 'recovery must never retry the uncertain audio')
    assert.equal(starts(f).length, 1)
    assert.deepEqual(starts(f)[0].params.input, [{ type: 'text', text: 'Continue using this explicit text.', text_elements: [] }])
    assert.ok(frames.some(frame => frame.type === 'status_error' && /sin reenviar/.test(frame.message)))
  }
})

test('failed history verification cannot clear the uncertain-audio latch or submit recovery text', async t => {
  const f = await fixture(t), state = await f.runtime.open('thr-a')
  state.audioUncertain = true
  f.rpc.handlers.set('thread/turns/list', () => { throw new Error('Unreadable native history') })
  await assert.rejects(f.runtime.ask(state, { id: 'text', text: 'explicit', audioMode: 'transcript' }), /Unreadable/)
  assert.equal(state.audioUncertain, true); assert.equal(starts(f).length, 0)
})
