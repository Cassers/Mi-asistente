import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as core from '../shared/timings.mjs'

function load({ brokenIDs = false } = {}) {
  const jobs = [], requests = [], exports = {}
  let accepted = true
  const fetch = async (url, options) => {
    requests.push({ url, options })
    if (!accepted) throw Error('collector offline')
    return { ok: true, json: async () => ({ events: [], persistence: 'ok', dropped: 0 }) }
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/timings.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: id => id === 'react' ? React : id === '../config' ? { BRIDGE_HTTP_URL: 'http://127.0.0.1:8787' } : core,
    crypto: { randomUUID: brokenIDs ? () => { throw Error('No timing IDs') } : randomUUID }, fetch, AbortSignal, Headers, Date, performance,
    setTimeout: fn => { jobs.push(fn); return jobs.length },
  })
  const drain = async () => {
    for (let i=0; jobs.length && i<100; i++) { jobs.shift()(); for (let k=0;k<5;k++) await Promise.resolve() }
  }
  return { app: exports, requests, drain, offline: () => { accepted = false } }
}
test('browser telemetry sends metadata only, deduplicates bridge echo and remains usable offline', async () => {
  const f = load()
  const span = f.app.startTiming('turn.total', 'trace-fixture-1234'); span.end()
  await f.drain()
  assert.equal(f.app.timingsSnapshot().rows.length, 1)
  const request = f.requests.find(r => r.options?.method === 'POST')
  assert.ok(request)
  const sent = JSON.parse(request.options.body).events[0]
  assert.equal(sent.name, 'turn.total'); assert.equal(sent.phase, 'end')
  f.app.receiveTiming({ ...sent, prompt: 'ignored private words' }); await f.drain()
  assert.equal(f.app.timingsSnapshot().rows.length, 1)
  assert.doesNotMatch(JSON.stringify(f.app.timingsSnapshot()), /private words|prompt/)
  f.offline(); f.app.startTiming('audio.encode').end(); await f.drain()
  assert.equal(f.app.timingsSnapshot().rows.length, 2)
  assert.equal(f.app.timingsSnapshot().persistence, 'unavailable')
  assert.equal(f.app.timingsSnapshot().dropped, 1)
})
test('timed HTTP carries only opaque correlation and frontend ring remains bounded', async () => {
  const f = load()
  await f.app.timedFetch('project.open', 'http://127.0.0.1:8787/projects', { method: 'POST', body: 'private-body' })
  assert.match(f.requests[0].options.headers.get('x-timing-trace'), /^[a-f0-9-]{36}$/)
  for (let i=0;i<2100;i++) f.app.receiveTiming({ traceId: 'trace-fixture-1234', id: randomUUID(), name: 'bridge.submit', source: 'bridge', phase: 'end', status: 'ok', at: Date.now(), durationMs: i })
  await f.drain()
  assert.equal(f.app.timingsSnapshot().rows.length, 2000)
  assert.doesNotMatch(JSON.stringify(f.app.timingsSnapshot()), /private-body/)
})
test('broken timing ID generator cannot prevent product HTTP requests', async () => {
  const f = load({ brokenIDs: true })
  const result = await f.app.timedFetch('project.open', 'http://127.0.0.1:8787/projects')
  assert.equal(result.ok, true)
  assert.equal(f.requests.length, 1)
  await f.drain()
})
test('capture duration is a content-free observation and rejected clips remain outside healthy percentiles', async () => {
  const f = load()
  f.app.recordTimingDuration('audio.capture', 75000, 'trace-overflow-1234', 'fallback')
  await f.drain()
  const row = f.app.timingsSnapshot().rows[0]
  assert.equal(row.durationMs, 75000); assert.equal(row.status, 'fallback')
  const summaries = core.summarizeTimings(f.app.timingsSnapshot().rows)
  assert.equal(summaries[0].count, 0); assert.equal(summaries[0].other, 1)
})
test('performance panel renders accessible closed and expanded timing states with explicit limits', () => {
  const source = ts.transpileModule(readFileSync(new URL('../src/ui/TimingsPanel.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const rows = [{ traceId: 'trace-fixture-1234', id: randomUUID(), source: 'browser', name: 'turn.first_audio', phase: 'end', status: 'ok', at: Date.now(), durationMs: 1234 }]
  for (const expanded of [false, true]) {
    const exports = {}
    vm.runInNewContext(source, { exports, Date, require: id => id === 'react' ? { ...React, useEffect() {}, useMemo: fn => fn(), useState: initial => [typeof initial === 'boolean' ? expanded : initial, () => {}] }
      : id === '../lib/timings' ? { ...core, refreshTimings: async () => {}, useTimings: () => ({ rows, persistence: 'saved', dropped: 0 }) }
      : id === 'react/jsx-runtime' ? jsxRuntime : undefined })
    const html = renderToStaticMarkup(React.createElement(exports.TimingsPanel))
    assert.match(html, /Rendimiento y tiempos/)
    if (expanded) {
      assert.match(html, /<label>Flujo reciente<select/)
      assert.match(html, /Pregunta lista → primer sonido/)
      assert.match(html, /1.23 s/)
      assert.match(html, /Las etapas se solapan/)
      assert.match(html, /Exportar mediciones/)
      assert.match(html, /No se guardan conversaciones/)
    } else assert.doesNotMatch(html, /Exportar mediciones/)
  }
})
