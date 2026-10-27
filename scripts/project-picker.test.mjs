import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { timingStub } from './timing-fixture.mjs'

const require = createRequire(import.meta.url)
const bridge = 'http://bridge.test:8787'
const a = { id: 'a', name: 'Uno', directory: '/uno', application: 'opencode', serverURL: 'http://localhost:4096' }
const b = { ...a, id: 'b', name: 'Dos', directory: '/dos' }
const initial = { projects: [a, b], selected: a, loading: false, error: '', available: true, defaultServerURL: a.serverURL }
const ok = data => ({ ok: true, status: 200, json: async () => data })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function load(file, imports, globals = {}) {
  const exports = {}
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } })
  vm.runInNewContext(outputText, { exports, require: id => imports[id] ?? (id === './timings' || id === '../lib/timings' ? timingStub(globals.fetch) : require(id)), AbortSignal, ...globals })
  return exports
}
function store(fetch, saved = '') {
  const writes = []
  const api = load('src/lib/projects.ts', {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    '../config': { BRIDGE_HTTP_URL: bridge },
  }, { fetch, localStorage: { getItem: () => saved, setItem: (key, value) => { saved = value; writes.push([key, value]) } } })
  return { ...api, state: api.useProjects, writes }
}
function picker(state = initial, imports = {}, globals = {}) {
  return load('src/ui/ProjectPicker.tsx', {
    '../config': { BRIDGE_HTTP_URL: bridge },
    '../lib/projects': { useProjects: () => state, ...imports },
  }, globals).ProjectPicker
}
const render = (state, props) => renderToStaticMarkup(React.createElement(picker(state), props))

test('SSR exposes labelled recent, path, server and password controls, Spanish actions', () => {
  const html = render(initial)
  for (const label of ['Aplicación', 'Proyectos recientes', 'Ruta del proyecto', 'Servidor de OpenCode (URL)', 'Contraseña de OpenCode (opcional)']) {
    assert.ok(html.includes(label))
  }
  const labels = [...html.matchAll(/<label for="([^"]+)"/g)]
  assert.equal(labels.length, 5)
  for (const [, id] of labels) assert.ok(html.includes(`id="${id}"`))
  assert.match(html, /<input[^>]*type="text"[^>]*required=""/)
  assert.match(html, /type="url"[^>]*value="http:\/\/localhost:4096"/)
  assert.match(html, /type="password"[^>]*autoComplete="off"/i)
  assert.match(html, /<details><summary>Detalles de conexión/)
  assert.match(html, /Examinar carpeta/)
  assert.match(html, /Abrir proyecto/)
  assert.match(html, /role="status" aria-live="polite"/)
})

test('SSR disables form while busy, externally locked, or legacy; errors escaped', () => {
  for (const [state, props] of [[{ ...initial, loading: true }, {}], [initial, { disabled: true }], [{ ...initial, available: false }, {}]]) {
    assert.match(render(state, props), /<fieldset disabled=""/)
  }
  assert.match(render({ ...initial, loading: true }), /aria-busy="true"/)
  const html = render({ ...initial, error: '<script>fallo</script>' })
  assert.match(html, /role="alert"/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(render({ ...initial, available: false }), /modo anterior/)
})

test('refresh restores only saved selection; projectURL preserves query and fragment', async () => {
  const api = store(async (url, options) => {
    assert.equal(url, `${bridge}/projects`)
    assert.equal(options.headers['Content-Type'], 'application/json')
    return ok({ projects: [a, b], defaultServerURL: a.serverURL })
  }, 'b')
  assert.equal(api.projectURL('/models'), '/models')
  await api.refreshProjects()
  assert.equal(api.selectedProject().id, 'b')
  assert.equal(api.projectURL('/models'), '/models?project=b')
  assert.equal(api.projectURL('/models?x=1#part'), '/models?x=1&project=b#part')
  api.selectProject('missing')
  assert.equal(api.selectedProject().id, 'b')
  api.selectProject('a')
  assert.equal(api.writes.length, 1)
  assert.equal(api.writes[0][1], 'a')
})

test('refresh coalesces requests; 404 is legacy, HTTP and malformed responses expose errors', async () => {
  const wait = deferred()
  let calls = 0
  const api = store(() => { calls++; return wait.promise })
  const first = api.refreshProjects()
  assert.equal(first, api.refreshProjects())
  assert.equal(calls, 1)
  wait.resolve({ status: 404 })
  await first
  assert.equal(api.state().available, false)
  assert.equal(api.state().error, '')
  for (const response of [{ ok: false, json: async () => ({ error: 'Sin conexión' }) }, ok({ projects: null })]) {
    const failed = store(async () => response)
    await failed.refreshProjects()
    assert.ok(failed.state().error)
    assert.equal(failed.state().loading, false)
    assert.equal(failed.state().available, true)
  }
})

test('open posts credentials once, strips response extras, persists selected ID only', async () => {
  let request
  const api = store(async (url, options) => { request = { url, ...options }; return ok({ project: { ...a, password: 'top-secret', username: 'owner' } }) })
  await api.openProject({ directory: ' /uno ', serverURL: ' http://localhost:4096 ', username: 'owner', password: 'top-secret' })
  assert.equal(request.url, `${bridge}/projects`)
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(request.body), { directory: '/uno', serverURL: a.serverURL, username: 'owner', password: 'top-secret' })
  assert.equal(JSON.stringify(api.writes), '[["assistant.project.selection","a"]]')
  assert.doesNotMatch(JSON.stringify(api.state()), /top-secret|password|username/)
})

test('failed open preserves selected project, clears loading, redacts echoed password', async () => {
  let response = ok({ projects: [a], defaultServerURL: a.serverURL })
  const api = store(async () => response, 'a')
  await api.refreshProjects()
  response = { ok: false, json: async () => ({ error: 'Clave secret rechazada' }) }
  await assert.rejects(api.openProject({ directory: '/dos', password: 'secret' }), /Clave \[oculta\] rechazada/)
  assert.equal(api.selectedProject().id, 'a')
  assert.equal(api.state().loading, false)
  assert.doesNotMatch(api.state().error, /secret/)
  assert.equal(api.writes.length, 0)
  await assert.rejects(api.openProject({ directory: ' ' }), /Escribe la ruta/)
})

test('stale refresh cannot overwrite newly opened project or loading state', async () => {
  const wait = deferred()
  const api = store((_url, options) => options.method === 'POST' ? Promise.resolve(ok({ project: b })) : wait.promise)
  const refresh = api.refreshProjects()
  await api.openProject({ directory: '/dos' })
  wait.resolve(ok({ projects: [a], defaultServerURL: a.serverURL }))
  await refresh
  assert.equal(api.selectedProject().id, 'b')
  assert.equal(api.state().projects[0].id, 'b')
  assert.equal(api.state().loading, false)
})

test('refresh preserves selection made after request began, even when missing from stale list', async () => {
  let response = Promise.resolve(ok({ projects: [a, b], defaultServerURL: a.serverURL }))
  const api = store(() => response)
  await api.refreshProjects()
  const wait = deferred()
  response = wait.promise
  const refresh = api.refreshProjects()
  api.selectProject('b')
  wait.resolve(ok({ projects: [a], defaultServerURL: a.serverURL }))
  await refresh
  assert.equal(api.selectedProject().id, 'b')
  assert.ok(api.state().projects.some(p => p.id === 'b'))
})

// Lightweight hook harness exercises native chooser and form handlers without a browser.
function interactive(imports, fetch) {
  const values = []
  let cursor = 0
  const Component = load('src/ui/ProjectPicker.tsx', {
    react: { useEffect() {}, useId: () => 'test', useState: value => {
      const index = cursor++
      if (!(index in values)) values[index] = value
      return [values[index], next => { values[index] = next }]
    } },
    '../config': { BRIDGE_HTTP_URL: bridge },
    '../lib/projects': { useProjects: () => initial, ...imports },
  }, { fetch }).ProjectPicker
  const tree = () => { cursor = 0; return Component({}) }
  function find(type, id) {
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === type && (!id || node.props.id === id || node.props.children === id)) return node
      for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child); if (found) return found }
    }
    return walk(tree())
  }
  return { find }
}

test('native browse sends empty JSON; cancellation leaves typed path; successful pick fills path', async () => {
  let directory = null
  const ui = interactive({}, async (url, options) => {
    assert.equal(url, `${bridge}/projects/browse`)
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.body, '{}')
    return ok({ directory })
  })
  ui.find('input', 'test-path').props.onChange({ target: { value: '/typed' } })
  ui.find('button', 'Examinar carpeta').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ui.find('input', 'test-path').props.value, '/typed')
  directory = '/picked'
  ui.find('button', 'Examinar carpeta').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ui.find('input', 'test-path').props.value, '/picked')
})

test('submit clears password immediately, including failed open; chooser failure exposes alert', async () => {
  let submitted
  const wait = deferred()
  const ui = interactive({ openProject: input => { submitted = input; return wait.promise } }, async () => ({ ok: false, json: async () => ({ error: 'Selector no disponible' }) }))
  ui.find('input', 'test-path').props.onChange({ target: { value: '/typed' } })
  ui.find('input', 'test-password').props.onChange({ target: { value: 'secret' } })
  const submit = ui.find('form').props.onSubmit({ preventDefault() {} })
  assert.equal(submitted.password, 'secret')
  assert.equal(ui.find('input', 'test-password').props.value, '')
  wait.resolve(Promise.reject(new Error('fail')))
  await submit
  ui.find('button', 'Examinar carpeta').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  const privacyID = ui.find('input', 'test-password').props['aria-describedby']
  assert.ok(privacyID)
  assert.equal(ui.find('p', privacyID).props.children, 'La contraseña se usa al abrir y no se guarda en este navegador.')
  assert.ok(ui.find('section').props.children.flat(Infinity).some(node => node?.props?.role === 'alert' && node.props.children === 'Selector no disponible'))
})

test('Codex project controls use native login, hide OpenCode credentials and submit only the chosen application', async () => {
  const codex = { ...a, id: 'codex-folder', application: 'codex', serverURL: '' }
  const html = render({ ...initial, projects: [a, codex], selected: codex })
  assert.match(html, /Codex instalado en este equipo/)
  assert.match(html, /Codex · Uno/)
  assert.doesNotMatch(html, /type="password"|Servidor de OpenCode/)
  let request
  const api = store(async (_url, options) => { request = JSON.parse(options.body); return ok({ project: codex }) })
  await api.openProject({ directory: '/uno', application: 'codex', password: 'never-forward', serverURL: 'http://localhost:4096' })
  assert.deepEqual(request, { directory: '/uno', application: 'codex' })
  assert.equal(api.selectedProject().application, 'codex')
  assert.doesNotMatch(JSON.stringify(api.writes), /never-forward/)
})

test('application switching restores the existing OpenCode endpoint and native project instead of opening the default server', async () => {
  const openCode = { ...a, id: 'original-oc', serverURL: 'http://localhost:4999' }
  const codex = { ...a, id: 'native-codex', application: 'codex', serverURL: '' }
  let reads = 0
  const api = store(async (_url, options) => {
    assert.notEqual(options.method, 'POST', 'registered application must never reopen against another endpoint')
    reads++; return ok({ projects: [openCode, codex], defaultServerURL: 'http://localhost:4097' })
  }, codex.id)
  await api.refreshProjects()
  const switched = await api.switchApplication('opencode')
  assert.equal(switched.id, openCode.id); assert.equal(switched.serverURL, 'http://localhost:4999')
  assert.equal(api.selectedProject().id, openCode.id); assert.equal(reads, 1)
  await api.switchApplication('codex')
  assert.equal(api.selectedProject().id, codex.id)
})
