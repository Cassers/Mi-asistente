import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

async function fixture(observers = {}, options = {}) {
  let time = 1000, energy = 0, raf = null, guarded = false, inFrame = false, requests = 0
  const boundaries = [], errors = [], contexts = [], observations = []
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/vad.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, require: id => { assert.equal(id, './audio'); return { getMic: async () => { requests++; return {} } } },
    performance: { now: () => time }, DOMException,
    requestAnimationFrame: callback => { raf = callback; return 1 }, cancelAnimationFrame() { raf = null },
    AudioContext: class {
      constructor() { contexts.push(this) }
      resume() { return Promise.resolve() }
      close() { this.closed = true; return Promise.resolve() }
      createMediaStreamSource() { return { connect() {}, disconnect() {} } }
      createAnalyser() { return { getFloatTimeDomainData: buffer => buffer.fill(energy) } }
    },
    // No MediaRecorder exists: PCM mode must not require or instantiate it.
  })
  const vad = await exports.startVad({ onStart: () => boundaries.push('start'),
    onEnd: (blob, ms) => { assert.equal(blob, null); assert.equal(inFrame, true, 'boundary must be synchronous within VAD tick'); boundaries.push({ ms }) },
    onQuiet() { observations.push({ event: 'quiet', at: time }); observers.quiet?.() },
    onResume() { observations.push({ event: 'resume', at: time }); observers.resume?.() },
    onBoundary(reason) { observations.push({ event: reason, at: time }); observers.boundary?.() },
    onLevel() {}, onError: message => errors.push(message),
  }, { pcmOnly: true, guard: () => guarded, ...options })
  return { vad, boundaries, errors, contexts, observations, get requests() { return requests }, setGuard(value) { guarded = value },
    step(value, ms = 50) { energy = value; time += ms; const callback = raf; assert.ok(callback); inFrame = true; callback(); inFrame = false },
    steps(value, count) { for (let i = 0; i < count; i++) this.step(value) } }
}

test('PCM VAD uses shared mic without MediaRecorder and dispatches each pause synchronously before the next onset', async () => {
  const f = await fixture()
  assert.equal(f.requests, 1); assert.equal(f.vad.live(), true); assert.deepEqual(f.errors, [])
  f.steps(0.2, 8); assert.deepEqual(f.boundaries, ['start'])
  f.steps(0, 24); assert.equal(f.boundaries.length, 2); assert.ok(f.boundaries[1].ms >= 650)
  f.steps(0.2, 8); assert.equal(f.boundaries[2], 'start')
  f.steps(0, 24); assert.equal(f.boundaries.length, 4)
  f.vad.stop(); assert.equal(f.vad.live(), false); assert.equal(f.contexts[0].closed, true)
})

test('PCM VAD retains the twenty-second segment ceiling, dynamic guard and cancellation reset', async () => {
  const f = await fixture()
  f.steps(0, 1); const baseline = f.vad.meter().threshold
  f.setGuard(true); f.steps(0, 1); assert.ok(f.vad.meter().threshold > baseline * 2)
  f.setGuard(false); f.steps(0.2, 410)
  assert.ok(f.boundaries.some(item => typeof item === 'object' && item.ms >= 20000))
  f.steps(0.2, 8)
  const before = f.boundaries.filter(item => typeof item === 'object').length
  f.vad.reset(); f.steps(0, 24)
  assert.equal(f.boundaries.filter(item => typeof item === 'object').length, before, 'reset discards the unfinished segment')
  f.vad.stop()
})

test('quiet/resume/boundary observers track the existing silence gate without changing dispatch', async () => {
  const f = await fixture()
  f.steps(0.2, 8); f.steps(0, 7)
  assert.deepEqual(f.observations.map(item => item.event), ['quiet'])
  assert.equal(f.boundaries.length, 1, 'a short quiet wait must not dispatch')
  f.steps(0.2, 4)
  assert.deepEqual(f.observations.map(item => item.event), ['quiet', 'resume'])
  f.steps(0, 24)
  assert.deepEqual(f.observations.map(item => item.event), ['quiet', 'resume', 'quiet', 'silence'])
  const wait = f.observations[3].at - f.observations[2].at
  assert.ok(wait >= 600 && wait <= 650, 'measure from first observed quiet frame, without inventing a timestamp')
  assert.equal(f.boundaries.length, 2)
  f.steps(0.2, 8); f.steps(0, 7); f.vad.reset()
  assert.equal(f.observations.at(-1).event, 'cancelled')
  f.vad.stop()
})

test('observer failures cannot break PCM capture or the pause boundary', async () => {
  const fail = () => { throw Error('diagnostic observer failed') }
  const f = await fixture({ quiet: fail, resume: fail, boundary: fail })
  f.steps(0.2, 8); f.steps(0, 7); f.steps(0.2, 4); f.steps(0, 24)
  assert.equal(f.boundaries.length, 2); assert.equal(f.vad.live(), true)
  f.vad.stop()
})


test('direct six-second ceiling cuts continuous speech without shrinking the quiet window', async () => {
  const f = await fixture({}, { maxSegmentMs: 6000 })
  f.steps(0.2, 130)
  const cut = f.boundaries.find(item => typeof item === 'object')
  assert.ok(cut && cut.ms >= 6000 && cut.ms < 6500)
  assert.ok(f.observations.some(item => item.event === 'limit'))
  assert.ok(!f.observations.some(item => item.event === 'silence'))
  f.vad.stop()
})
