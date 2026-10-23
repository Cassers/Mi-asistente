import { test } from 'node:test'
import assert from 'node:assert/strict'
import { availableModels, selectModel } from './model-catalog.mjs'

const entry = (id, extra = {}) => ({ id, name: id, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: { input: { text: true, image: true, audio: false }, output: { text: true }, toolcall: true },
  variants: { low: {}, high: {}, hidden: { disabled: true } }, headers: { secret: 'never expose' }, options: { apiKey: 'secret' }, ...extra })
const catalog = { connected: ['opencode'], all: [{ id: 'opencode', models: { a: entry('a-free'), b: entry('b-free', { variants: {} }),
  paid: entry('paid-free', { cost: { input: 1, output: 0 } }), named: entry('not-free-paid'),
  cache: entry('cache-free', { cost: { input: 0, output: 0, cache: { read: .01 } } }) } },
  { id: 'other', models: { a: entry('other-free') } }] }

test('connected providers offer free and paid models, with no provider secrets', () => {
  const models = availableModels(catalog)
  assert.equal(models.length, 5)
  assert.equal(models.find(m => m.id === 'opencode/a-free').free, true)
  assert.equal(models.find(m => m.id === 'opencode/paid-free').free, false)
  assert.equal(models.find(m => m.id === 'opencode/cache-free').free, false)
  assert.deepEqual(models[0].variants, ['low', 'high'])
  assert.doesNotMatch(JSON.stringify(models), /secret|apiKey|headers|options/)
  assert.deepEqual(models.find(m => m.id === 'opencode/b-free').variants, [])
})
test('selection yields exact model and supported variant, including provider default', () => {
  assert.deepEqual(selectModel(catalog, 'opencode/a-free', 'low').model, { providerID: 'opencode', modelID: 'a-free' })
  assert.equal(selectModel(catalog, 'opencode/a-free', 'low').variant, 'low')
  assert.equal(selectModel(catalog, 'opencode/b-free').variant, undefined)
  const connected = { ...catalog, connected: ['opencode', 'other'] }
  assert.deepEqual(selectModel(connected, 'other/other-free').model, { providerID: 'other', modelID: 'other-free' })
  assert.equal(selectModel(catalog, 'opencode/paid-free').cost.input, 1)
})
test('unknown, disconnected, disabled, fabricated and wrong-type choices fail closed', () => {
  for (const id of ['opencode/missing-free', 'other/other-free', {}]) assert.throws(() => selectModel(catalog, id), /no está disponible/)
  for (const variant of ['max', 'hidden', {}, 7]) assert.throws(() => selectModel(catalog, 'opencode/a-free', variant), /pensamiento/)
  assert.throws(() => selectModel(catalog, 'opencode/b-free', 'high'), /pensamiento/)
})
