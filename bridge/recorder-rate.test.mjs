import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Recorder, TARGET_FPS, frameDelayMs } from './recorder.mjs'

test('continuous capture targets two fps without changing audio or retention', () => {
  const recorder = new Recorder('/tmp/jarvis-recorder-rate-test-unused')
  try {
    assert.equal(TARGET_FPS, 2)
    assert.equal(recorder.snapshot().targetFps, 2)
    assert.equal(recorder.snapshot().retentionMinutes, 30)
    assert.deepEqual(recorder.snapshot().audio, ['mic', 'system'])
  } finally { clearInterval(recorder.maintenance) }
})

test('each frame is paced to 500ms, accounting for capture time', () => {
  assert.equal(frameDelayMs(0), 500)
  assert.equal(frameDelayMs(75), 425)
  assert.equal(frameDelayMs(250), 250)
  assert.equal(frameDelayMs(500), 0)
  assert.equal(frameDelayMs(700), 0)
})
