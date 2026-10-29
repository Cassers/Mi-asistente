import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)]
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : ''
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node).includes(label))

export function composerFixture(available = true) {
  const slots = [], effects = [], jobs = [], sends = [], invalidations = new Set()
  let cursor = 0, sendResult = false, mounted = false
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial } },
    useEffect(fn) { if (!mounted) effects.push(fn) },
  }
  const caps = { engine: 'whisper', available, model: 'synthetic-local', maxBytes: 16777216, maxSeconds: 120, formats: ['audio/wav','audio/mpeg','audio/webm'] }
  const exports = {}
  const code = ts.transpileModule(readFileSync(new URL('../src/ui/MessageComposer.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  vm.runInNewContext(code, { exports, Error, AbortController, require: id => {
    if (id === 'react') return hooks
    if (id === '../lib/whisper') return {
      useWhisperCapabilities: () => ({ state: available ? 'ready' : 'unavailable', capabilities: caps, error: available ? '' : 'Whisper local sin configurar.' }),
      refreshWhisper: async () => caps, whisperAccept: () => 'audio/wav,audio/mpeg,audio/webm',
      subscribeWhisperInvalidation: fn => { invalidations.add(fn); return () => invalidations.delete(fn) },
      transcribeWhisper: (file, options) => { const job = { ...deferred(), file, options }; jobs.push(job); return job.promise },
    }
    assert.equal(id, 'react/jsx-runtime'); return require(id)
  } })
  const cleanup = []
  const props = { onSendMessage: text => { sends.push(text); return sendResult } }
  return { jobs, sends, caps,
    render() { cursor = 0; const tree = exports.MessageComposer(props); if (!mounted) { mounted = true; cleanup.push(...effects.map(fn => fn())) }; return tree },
    select(file) { const tree = this.render(); nodes(tree).find(n => n.type === 'input' && n.props.type === 'file').props.onChange({ target: { files: [file], value: 'fake' } }) },
    draft(value) { nodes(this.render()).find(n => n.props?.id === 'chat-message').props.onChange({ target: { value } }) },
    transcript(value) { nodes(this.render()).find(n => n.type === 'textarea' && n.props['aria-label'] === 'Transcripción de audio (editable)').props.onChange({ target: { value } }) },
    submit() { this.render().props.onSubmit({ preventDefault() {} }) },
    sendResult(value) { sendResult = value }, invalidate() { invalidations.forEach(fn => fn()) },
    unmount() { cleanup.forEach(fn => fn?.()) },
  }
}
const file = name => new File(['synthetic only'], name, { type: 'audio/wav' })

test('audio upload keeps a complete editable transcript and accompanying question until intentional Send', async () => {
  const f = composerFixture(), transcript = 'Texto completo sin recortar. '.repeat(100)
  f.draft('Resume este audio sin perder los detalles.')
  f.select(file('clase.wav')); f.submit(); assert.deepEqual(f.sends, [])
  assert.match(text(f.render()), /Transcribiendo con Whisper local/)
  assert.equal(f.jobs[0].options.filename, 'clase.wav')
  f.jobs[0].resolve(transcript); await flush()
  assert.equal(nodes(f.render()).find(n => n.props?.['aria-label'] === 'Transcripción de audio (editable)').props.value, transcript)
  assert.deepEqual(f.sends, [], 'recognition is not submission')
  f.transcript(transcript + 'Corrección manual.')
  f.submit(); await flush()
  assert.equal(f.sends[0], 'Resume este audio sin perder los detalles.\n\n' + transcript + 'Corrección manual.')
  assert.match(text(f.render()), /Se conservó el borrador/)
  assert.equal(nodes(f.render()).find(n => n.props?.id === 'chat-message').props.value, 'Resume este audio sin perder los detalles.')
  assert.match(text(f.render()), /El audio no se adjunta al chat/)
  f.unmount()
})

test('cancel/retry/hard failure never submits a stale or empty transcript and preserves the typed draft', async () => {
  const f = composerFixture(); f.draft('Pregunta escrita')
  f.select(file('a.wav'))
  button(f.render(), 'Cancelar transcripción').props.onClick()
  assert.equal(f.jobs[0].options.signal.aborted, true)
  f.jobs[0].resolve('Nunca mostrar el resultado cancelado'); await flush()
  assert.doesNotMatch(text(f.render()), /Nunca mostrar/)
  f.submit(); assert.deepEqual(f.sends, [])
  button(f.render(), 'Reintentar transcripción').props.onClick()
  f.jobs[1].reject(new Error('Synthetic decoder failure')); await flush()
  assert.match(text(f.render()), /Synthetic decoder failure.*No se usará otro motor/)
  f.submit(); assert.deepEqual(f.sends, [])
  button(f.render(), 'Quitar audio').props.onClick(); f.submit(); await flush()
  assert.deepEqual(f.sends, ['Pregunta escrita'])
  f.unmount()
})

test('a replacement file, mode/destination invalidation or unmount rejects delayed audio results', async () => {
  const f = composerFixture(); f.draft('Se conserva la pregunta')
  f.select(file('old.wav')); f.select(file('new.wav'))
  assert.equal(f.jobs[0].options.signal.aborted, true)
  f.jobs[0].resolve('Texto viejo'); await flush(); assert.doesNotMatch(text(f.render()), /Texto viejo/)
  f.invalidate(); assert.equal(f.jobs[1].options.signal.aborted, true)
  f.jobs[1].resolve('Texto de otro destino'); await flush()
  assert.equal(nodes(f.render()).some(n => n.props?.['aria-label'] === 'Transcripción de audio (editable)'), false)
  assert.equal(nodes(f.render()).find(n => n.props?.id === 'chat-message').props.value, 'Se conserva la pregunta')
  f.select(file('unmounted.wav')); f.unmount(); assert.equal(f.jobs[2].options.signal.aborted, true)
  f.jobs[2].resolve('Late unmounted'); await flush()
  assert.deepEqual(f.sends, [])
})

test('pending dispatch blocks duplicates and preserves edits made while acceptance is in flight', async () => {
  const f = composerFixture(), acceptance = deferred()
  f.sendResult(acceptance.promise); f.draft('Primera pregunta'); f.select(file('draft.wav'))
  f.jobs[0].resolve('Transcripción completa.'); await flush()
  f.submit(); f.submit(); assert.equal(f.sends.length, 1)
  f.draft('Nuevo borrador'); f.transcript('Nueva corrección durante el envío.')
  acceptance.resolve(true); await flush()
  assert.equal(nodes(f.render()).find(n => n.props?.id === 'chat-message').props.value, 'Nuevo borrador')
  assert.equal(nodes(f.render()).find(n => n.props?.['aria-label'] === 'Transcripción de audio (editable)').props.value, 'Nueva corrección durante el envío.')
  f.unmount()
})

test('unavailable local service disables only upload, leaving intentional typed input available without capture dependencies', async () => {
  const f = composerFixture(false), tree = f.render()
  assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'file').props.disabled, true)
  assert.match(text(tree), /Whisper local sin configurar/)
  f.draft('Texto con micrófono apagado'); f.sendResult(true); f.submit(); await flush()
  assert.deepEqual(f.sends, ['Texto con micrófono apagado'])
  assert.equal(f.jobs.length, 0)
  assert.equal(nodes(f.render()).find(n => n.props?.id === 'chat-message').props.value, '')
  f.unmount()
})

test('upload markup has a bounded file picker, editable transcript label and explicit local scope', () => {
  const f = composerFixture(); const html = renderToStaticMarkup(f.render())
  assert.match(html, /type="file"/); assert.match(html, /accept="audio\/wav,audio\/mpeg,audio\/webm"/)
  assert.match(html, /Whisper local/); assert.match(html, /120 s/)
  assert.match(html, /El audio no se adjunta al chat/)
  f.unmount()
})
