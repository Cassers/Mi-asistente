import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Whisper, detectWhisper } from './whisper.mjs'
import { runWhisperProcess } from './whisper-process.mjs'

test('installed Whisper transcribes locally generated synthetic Spanish speech; no mic/provider', {
  skip: process.env.JARVIS_WHISPER_SMOKE !== '1', timeout: 190000,
}, async t => {
  const runtime = await detectWhisper()
  assert.equal(runtime.available, true, runtime.reason)
  const root = await mkdtemp(join(tmpdir(), 'whisper-real-smoke-')), audio = join(root, 'synthetic.wav'), tasks = join(root, 'tasks')
  await mkdir(tasks); t.after(() => rm(root, { recursive: true, force: true }))
  await runWhisperProcess('espeak-ng', ['-v', 'es', '-s', '135', '-w', audio, 'Hola. Esta es una prueba local de transcripción. El número es cuarenta y dos.'], { timeout: 10000 })
  const service = new Whisper({ tempRoot: tasks }); t.after(() => service.close())
  const start = Date.now()
  const result = await service.transcribe(await readFile(audio), { contentType: 'audio/wav', language: 'es' })
  assert.equal(result.engine, 'whisper'); assert.equal(result.language, 'es')
  assert.match(result.text, /prueba/i); assert.match(result.text, /(?:cuarenta.*dos|42)/i)
  assert.deepEqual(await readdir(tasks), [])
  // The receipt contains only bounded synthetic evidence and no recognized speech.
  t.diagnostic(JSON.stringify({ engine: result.engine, model: result.model, language: result.language, elapsedMs: Date.now() - start,
    synthetic: true, microphone: false, provider: false, transcriptionMatched: true, temporaryFilesRemoved: true }))
})
