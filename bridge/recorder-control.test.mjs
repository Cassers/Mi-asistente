import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recorder } from './recorder.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'recorder-controls-'))
  const reads = [], spawned = [], killed = []
  let fail = false
  const recorder = new Recorder(root, null, {
    outputs: async () => ({ principal: 'fixture-monitor' }),
    runCommand: async (_command, args) => {
      reads.push(args[0]); if (fail) throw new Error('Fixture PulseAudio unavailable')
      return { stdout: args[0] === 'get-default-source' ? 'fixture-microphone' : 'fixture-speakers' }
    },
    spawnProcess: (command, args) => {
      spawned.push({ command, args })
      const child = new EventEmitter(); child.stderr = new EventEmitter()
      child.kill = signal => { killed.push(signal); queueMicrotask(() => child.emit('exit', 0)); return true }
      return child
    },
  })
  // The real start/stop lifecycle runs; capture itself is a cancellable fixture.
  recorder.captureLoop = async (_output, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  t.after(async () => { await recorder.setActive(false); clearInterval(recorder.maintenance); await rm(root, { recursive: true, force: true }) })
  return { recorder, reads, spawned, killed, fail: value => { fail = value } }
}

test('explicit hard-off history opens only the system monitor, never queries or spawns microphone input', async t => {
  const f = await fixture(t)
  await f.recorder.setActive(true, { microphone: false })
  assert.deepEqual(f.reads, ['get-default-sink'])
  assert.equal(f.spawned.length, 1)
  assert.equal(f.spawned[0].args[f.spawned[0].args.indexOf('-i') + 1], 'fixture-speakers.monitor')
  assert.deepEqual(f.recorder.snapshot().audio, ['system']); assert.equal(f.recorder.snapshot().controlVersion, 1)
  const session = JSON.parse(await readFile(join(f.recorder.session, 'session.json'), 'utf8'))
  assert.equal(session.mic, null)
  await f.recorder.setActive(false)
  assert.equal(f.recorder.snapshot().active, false); assert.equal(f.recorder.children.size, 0)
  assert.deepEqual(f.killed, ['SIGINT'])
})
test('queued privacy pause stops both tracks, and manual muted resume cannot reuse an open mic', async t => {
  const f = await fixture(t)
  await f.recorder.setActive(true)
  assert.deepEqual(f.recorder.snapshot().audio, ['mic', 'system'])
  const pause = f.recorder.setActive(false)
  const resume = f.recorder.setActive(true, { microphone: false })
  await Promise.all([pause, resume])
  assert.equal(f.killed.length, 2); assert.equal(f.recorder.children.size, 1)
  assert.deepEqual(f.recorder.snapshot().audio, ['system'])
  assert.equal(f.spawned.at(-1).args.includes('fixture-microphone'), false)
  const count = f.spawned.length
  await f.recorder.setActive(true, { microphone: false }); assert.equal(f.spawned.length, count)
})
test('startup failures leave paused state with visible error and allow a clean retry', async t => {
  const f = await fixture(t); f.fail(true)
  await assert.rejects(f.recorder.setActive(true, { microphone: false }), /unavailable/)
  assert.equal(f.recorder.snapshot().active, false); assert.match(f.recorder.snapshot().error, /unavailable/)
  assert.equal(f.spawned.length, 0)
  f.fail(false); await f.recorder.setActive(true, { microphone: false })
  assert.equal(f.recorder.snapshot().active, true); assert.equal(f.recorder.snapshot().error, '')
})
