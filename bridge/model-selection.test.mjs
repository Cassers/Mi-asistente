import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('conversation and small model use the tested free visual model, not a paid auxiliary', async () => {
  const config = JSON.parse(await readFile(new URL('../opencode/xdg/opencode/opencode.json', import.meta.url), 'utf8'))
  assert.equal(config.model, 'opencode/deepseek-v4.1-flash-free')
  assert.equal(config.small_model, config.model)
  assert.equal(config.default_agent, 'build')
  assert.equal(config.permission['*'], 'ask')
})
