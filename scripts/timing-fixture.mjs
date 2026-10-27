import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
export function timingStub(fetch = globalThis.fetch) {
  return { newTrace: randomUUID, startTiming: (_name, traceId = randomUUID()) => ({ traceId, id: randomUUID(), end() {} }),
    markTiming() {}, receiveTiming() {}, timedFetch: (_name, ...args) => fetch(...args) }
}
/** Exercise real voice coordinator even in product regression fixtures. */
export function voiceTimingStub() {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/voice-timing.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports, require: () => timingStub() })
  return exports
}
