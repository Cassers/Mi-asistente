import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'

const source = ts.transpileModule(readFileSync(new URL('../src/lib/models.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const models = [{ id: 'opencode/free', variants: ['low', 'high'] }, { id: 'paid/model', variants: ['medium'] }, { id: 'opencode/mimo', variants: [] }]
function load(storage = new Map(), catalog = { models, defaultModel: 'opencode/free' }) {
  const exports = {}
  vm.runInNewContext(source, { exports,
    require: id => id === 'react' ? { useSyncExternalStore: (_, snapshot) => snapshot() } : { BRIDGE_HTTP_URL: 'http://localhost:8787' },
    fetch: async () => ({ ok: true, json: async () => catalog }), Date, AbortSignal,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  })
  return exports
}
test('model and thinking persist locally; changing to MiMo clears unsupported variant', async () => {
  const storage = new Map(), first = load(storage)
  await first.refreshModels()
  first.chooseModel('paid/model', 'medium')
  assert.equal(first.useModels().model, 'paid/model')
  const reload = load(storage); await reload.refreshModels()
  assert.equal(reload.useModels().variant, 'medium')
  reload.chooseModel('opencode/mimo')
  assert.equal(reload.useModels().variant, '')
  reload.chooseModel('opencode/mimo', 'high')
  assert.equal(reload.useModels().variant, '')
})
test('catalogue without configured choice/default cannot automatically select paid model', async () => {
  const app = load(new Map(), { models: [models[1]], defaultModel: 'opencode/missing' })
  await app.refreshModels()
  await assert.rejects(app.currentModelSelection(), /no se cambió a otro modelo/)
  assert.equal(app.useModels().model, '')
  assert.equal(app.useModels().models.length, 1, 'manual recovery remains possible')
  app.chooseModel('paid/model', 'medium')
  assert.equal(app.useModels().error, '')
  assert.equal((await app.currentModelSelection()).model, 'paid/model')
})
