import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
import { timingStub } from './timing-fixture.mjs'

const source = ts.transpileModule(readFileSync(new URL('../src/lib/models.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const models = [{ id: 'opencode/free', variants: ['low', 'high'] }, { id: 'paid/model', variants: ['medium'] }, { id: 'opencode/mimo', variants: [] }]
function load(storage = new Map(), catalog = { models, defaultModel: 'opencode/free' }, project = { id: '' }) {
  const exports = {}
  let now = Date.now(), reads = 0
  const fetch = async () => { reads++; return { ok: true, json: async () => catalog } }
  vm.runInNewContext(source, { exports,
    require: id => id === './timings' ? timingStub(fetch)
      : id === 'react' ? { useSyncExternalStore: (_, snapshot) => snapshot() }
      : id === './projects' ? { selectedProject: () => project.id ? project : null, projectURL: path => path, subscribeProjects: () => () => {} }
      : { BRIDGE_HTTP_URL: 'http://localhost:8787' },
    fetch, Date: class extends Date { static now() { return now } }, AbortSignal,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  })
  return { ...exports, reads: () => reads, advance: ms => { now += ms } }
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

test('model and reasoning choices stay scoped to each project, never leaking a paid override', async () => {
  const storage = new Map(), project = { id: 'one' }, app = load(storage, undefined, project)
  await app.refreshModels()
  app.chooseModel('paid/model', 'medium')
  project.id = 'two'; await app.refreshModels()
  assert.equal(app.useModels().model, 'opencode/free')
  assert.equal(app.useModels().variant, '')
  project.id = 'one'; await app.refreshModels()
  assert.equal(app.useModels().model, 'paid/model')
  assert.equal(app.useModels().variant, 'medium')
})

test('native-default selection leaves model and reasoning to the actual OpenCode conversation', async () => {
  const app = load(new Map(), { models: [{ id: 'native/default', variants: [] }, ...models], defaultModel: 'native/default' }, { id: 'native-project' })
  await app.refreshModels()
  assert.equal(Object.keys(await app.currentModelSelection()).length, 0)
})

test('voice dispatch uses an already chosen model without waiting for a stale UI catalogue; project switch still refreshes', async () => {
  const project = { id: 'one' }, app = load(new Map(), undefined, project)
  await app.refreshModels()
  app.chooseModel('paid/model', 'medium')
  app.advance(60000)
  assert.equal((await app.currentModelSelection()).model, 'paid/model')
  assert.equal(app.reads(), 1, 'catalogue refresh must not precede every spoken turn')
  project.id = 'two'
  await app.currentModelSelection()
  assert.equal(app.reads(), 2, 'another project cannot inherit the previous cached selection')
})
