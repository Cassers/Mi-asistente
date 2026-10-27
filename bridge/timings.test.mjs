import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createTimings, summarizeTimings, validTiming } from '../shared/timings.mjs'
import { TimingStore } from './timings.mjs'
const event = (patch = {}) => ({ traceId: randomUUID(), id: randomUUID(), source: 'browser', name: 'audio.encode',
  phase: 'end', status: 'ok', at: Date.now(), durationMs: 15, ...patch })
async function drained(store) {
  for (let i = 0; store.writing && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(store.writing, false)
}
test('spans use monotonic duration despite wall-clock changes, settle once and fail open', () => {
  let now = 50, wall = Date.now()
  const rows = [], recorder = createTimings({ source: 'bridge', emit: e => rows.push(e), now: () => now, wall: () => wall, uuid: randomUUID })
  const span = recorder.start('bridge.submit'); wall -= 60000; now += 123
  span.end('cancelled'); span.end()
  assert.equal(rows.length, 2)
  assert.equal(rows[1].status, 'cancelled'); assert.equal(rows[1].durationMs, 123)
  assert.equal(rows[1].at, rows[0].at)
  assert.doesNotThrow(() => createTimings({ source: 'browser', emit() { throw Error('collector unavailable') }, uuid: randomUUID }).start('turn.total').end())
  assert.doesNotThrow(() => createTimings({ source: 'browser', uuid() { throw Error('ID generator unavailable') } }).start('turn.total').end())
  const brokenClock = createTimings({ source: 'browser', now() { throw Error('clock unavailable') } })
  assert.doesNotThrow(() => brokenClock.start('turn.total').end())
})
test('allowlist strips content, rejects arbitrary labels, wrong sources and bad times', () => {
  const clean = validTiming(event({ prompt: 'private', path: '/secret', authorization: 'token', audio: 'raw' }))
  assert.deepEqual(Object.keys(clean).sort(), ['at','durationMs','id','name','phase','source','status','traceId'].sort())
  for (const patch of [{ name: 'private-user-message' }, { source: 'provider' }, { id: '../secret' }, { durationMs: NaN }, { durationMs: -2 }, { at: Date.now() + 900000 }, { status: 'secret' }]) assert.equal(validTiming(event(patch)), null)
  assert.equal(validTiming(event({ source: 'bridge' }), 'browser'), null)
})
test('percentiles use completed successful samples, separate clocks and keep non-success counts', () => {
  const rows = [10,20,30,100].map(durationMs => event({ durationMs }))
  rows.push(event({ phase: 'start', durationMs: 0 }), event({ status: 'error', durationMs: 999 }), event({ source: 'bridge', durationMs: 300 }))
  const summary = summarizeTimings(rows)
  const browser = summary.find(s => s.source === 'browser')
  assert.equal(browser.count, 4); assert.equal(browser.other, 1)
  assert.equal(browser.p50, 20); assert.equal(browser.p95, 100)
  assert.equal(summary.find(s => s.source === 'bridge').p50, 300)
})
test('local writer restores sanitized records, rotates logs, bounds memory and uses private file mode', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-timings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new TimingStore(directory, { limit: 3, maxBytes: 400 })
  await store.loaded
  const traceId = randomUUID()
  for (let i = 0; i < 8; i++) { store.add(event({ traceId, durationMs: i, prompt: 'never persist me' })); await drained(store) }
  assert.equal((await store.snapshot()).events.length, 3)
  const content = await readFile(join(directory, 'timings.jsonl'), 'utf8') + await readFile(join(directory, 'timings.previous.jsonl'), 'utf8')
  assert.doesNotMatch(content, /never persist me|prompt/)
  assert.ok((await stat(join(directory, 'timings.jsonl'))).size < 1024)
  assert.equal((await stat(join(directory, 'timings.jsonl'))).mode & 0o777, 0o600)
  const restored = new TimingStore(directory, { limit: 3, maxBytes: 400 })
  assert.equal((await restored.snapshot()).events.length, 3)
  assert.ok((await restored.snapshot()).events.every(e => e.traceId === traceId))
})
test('unwritable logging does not throw into product and reports persistence failure', async () => {
  const store = new TimingStore('/dev/null/no-timings')
  await store.loaded
  assert.doesNotThrow(() => store.add(event()))
  await drained(store)
  assert.equal((await store.snapshot()).persistence, 'error')
})
