import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectOutputs } from './monitor-outputs.mjs'

test('monitor resolution ignores stale/disconnected connectors and follows model after rename', () => {
  const main = { model: 'LG ULTRAGEAR', logical: { width: 1920 }, current_mode: 0 }
  const secondary = { model: 'LG HD PLUS', logical: { width: 1600 }, current_mode: 0 }
  assert.deepEqual(selectOutputs({ 'DP-1': { ...main, logical: null, current_mode: null }, 'DP-3': main, 'DP-2': secondary }), { principal: 'DP-3', secundario: 'DP-2' })
  assert.deepEqual(selectOutputs({ 'HDMI-A-1': secondary, 'DP-2': main }), { principal: 'DP-2', secundario: 'HDMI-A-1' })
  assert.deepEqual(selectOutputs({ 'DP-1': { ...main, current_mode: null } }), { principal: undefined, secundario: undefined })
})
