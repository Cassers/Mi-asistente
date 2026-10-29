import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Whisper, WhisperError, detectWhisper } from './whisper.mjs'
import { runWhisperProcess } from './whisper-process.mjs'

const pcm = (seconds = 0.3) => {
  const bytes = Buffer.alloc(Math.floor(16000 * seconds) * 2)
  for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(6000 * Math.sin(i * 0.13)), i * 2)
  return bytes
}
const rootFor = async t => { const root = await mkdtemp(join(tmpdir(), 'whisper-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root }
const status = n => error => error instanceof WhisperError && error.status === n
async function fixture(t, overrides = {}) {
  const root = await rootFor(t), runtime = { available: true, cli: '/trusted/whisper-cli', ffmpeg: '/trusted/ffmpeg', model: '/private/models/ggml-test.bin' }, calls = []
  const service = new Whisper({ tempRoot: root, detect: async () => runtime, run: async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === runtime.ffmpeg) return pcm()
    const wav = args[args.indexOf('--file') + 1], output = args[args.indexOf('--output-file') + 1]
    const wave = await readFile(wav)
    assert.equal(wave.toString('ascii', 0, 4), 'RIFF'); assert.equal(wave.readUInt32LE(24), 16000)
    assert.equal((await stat(wav)).mode & 0o777, 0o600); assert.equal((await stat(root + '/' + (await readdir(root))[0])).mode & 0o777, 0o700)
    await writeFile(output + '.json', JSON.stringify({ result: { language: 'es' }, transcription: [{ text: ' Hola' }, { text: ' mundo.' }] }))
    return Buffer.alloc(0)
  }, ...overrides })
  t.after(() => service.close())
  return { service, root, runtime, calls }
}
test('availability checks files only, retries and exposes basename without private paths', async t => {
  const root = await rootFor(t), cli = join(root, 'cli'), model = join(root, 'model.bin'), ffmpeg = join(root, 'ffmpeg')
  const env = { PATH: '', HOME: root, JARVIS_WHISPER_CLI: cli, JARVIS_WHISPER_MODEL: model, JARVIS_WHISPER_FFMPEG: ffmpeg }
  assert.match((await detectWhisper(env)).reason, /whisper-cli/)
  await writeFile(cli, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  assert.match((await detectWhisper(env)).reason, /GGML/)
  await writeFile(model, Buffer.alloc(2048))
  assert.match((await detectWhisper(env)).reason, /FFmpeg/)
  await writeFile(ffmpeg, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  assert.equal((await detectWhisper(env)).available, true)
  const service = new Whisper({ detect: () => detectWhisper(env), run: () => { throw Error('Availability must never execute inference') } })
  const result = await service.availability()
  assert.equal(result.model, 'model.bin'); assert.equal(result.engine, 'whisper'); assert.equal(result.maxBytes, 16 * 1024 * 1024); assert.equal(result.maxSeconds, 120)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root)); assert.ok(result.formats.includes('audio/webm'))
  await chmod(cli, 0o600); assert.equal((await service.availability()).available, false)
})
test('successful transcription uses explicit model, protected WAV, restricted decoder, no prompt or shell; deletes temp output', async t => {
  const { service, root, calls, runtime } = await fixture(t)
  assert.deepEqual(await service.transcribe(Buffer.from('synthetic encoded bytes'), { contentType: 'audio/webm;codecs=opus', language: 'es' }),
    { text: 'Hola mundo.', engine: 'whisper', model: 'ggml-test.bin', language: 'es' })
  assert.deepEqual(await readdir(root), [])
  assert.equal(calls[0].args[calls[0].args.indexOf('-protocol_whitelist') + 1], 'file')
  assert.match(calls[0].args[calls[0].args.indexOf('-i') + 1], /mi-asistente-whisper-[^/]+\/upload\.audio$/)
  assert.equal(calls[0].args[calls[0].args.indexOf('-f') + 1], 'matroska')
  assert.equal(calls[0].args.includes('-t'), false, 'overlong input is rejected, never silently trimmed')
  assert.equal(calls[1].args[calls[1].args.indexOf('--model') + 1], runtime.model)
  assert.equal(calls[1].args.includes('--prompt'), false)
})
test('unavailable engine returns retryable 503 and never decodes or reads body', async t => {
  const { service, calls } = await fixture(t, { detect: async () => ({ available: false, reason: 'Falta modelo.' }) })
  const source = { [Symbol.asyncIterator]() { throw Error('must not read') } }
  await assert.rejects(service.transcribe(source, { contentType: 'audio/wav' }), status(503)); assert.equal(calls.length, 0)
})
test('rejects unsupported formats, bad language, paths, URLs, empty and excessive bytes before process spawn', async t => {
  const { service, calls } = await fixture(t, { limits: { maxBytes: 8, maxSeconds: 1 } })
  for (const type of ['text/plain', 'application/json', 'application/octet-stream', 'video/mp4', 'audio/x-mpegurl', undefined]) await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: type }), status(415))
  for (const language of ['../../es', 'es-CO', 'zz', 'auto; rm', 'A'.repeat(100)]) await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: 'audio/wav', language }), status(400))
  for (const source of ['/private/user.wav', 'https://private/audio.wav', { path: '/private/user.wav' }]) await assert.rejects(service.transcribe(source, { contentType: 'audio/wav' }), status(400))
  await assert.rejects(service.transcribe(Buffer.alloc(0), { contentType: 'audio/wav' }), status(400))
  await assert.rejects(service.transcribe(Buffer.alloc(9), { contentType: 'audio/wav' }), status(413))
  await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: 'audio/wav', contentLength: '9' }), status(413))
  assert.equal(calls.length, 0)
})
test('bounds streamed bytes and stalled body independently of inference timeout', async t => {
  const { service } = await fixture(t, { limits: { maxBytes: 8, maxSeconds: 1 }, readTimeout: 30 })
  const source = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(5); yield Buffer.alloc(5) } }
  await assert.rejects(service.transcribe(source, { contentType: 'audio/wav' }), status(413))
  const stalled = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) } } }
  await assert.rejects(service.transcribe(stalled, { contentType: 'audio/wav' }), status(408))
  assert.equal(service.current, null)
})
for (const [name, decoded, expected] of [
  ['silence', Buffer.alloc(9600), 422], ['DC offset', Buffer.alloc(9600, 1), 422],
  ['corrupt odd PCM', Buffer.alloc(7), 422], ['empty PCM', Buffer.alloc(0), 422],
  ['too long', pcm(1.1), 413],
]) test('rejects decoded ' + name + ' before invoking Whisper', async t => {
  let count = 0
  const { service, root } = await fixture(t, { limits: { maxBytes: 100, maxSeconds: 1 }, run: async () => { count++; return decoded } })
  await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: 'audio/wav' }), status(expected))
  assert.equal(count, 1); assert.deepEqual(await readdir(root), [])
})
for (const [name, payload, expected] of [
  ['empty transcription', { transcription: [] }, 422],
  ['punctuation only', { transcription: [{ text: '... !!!' }] }, 422],
  ['silence marker', { transcription: [{ text: '[BLANK_AUDIO]' }] }, 422],
  ['special token', { transcription: [{ text: '<|nospeech|>' }] }, 422],
  ['malformed segments', { transcription: [{ text: 123 }] }, 502],
  ['wrong schema', { text: 'not supported schema' }, 502],
]) test('rejects Whisper ' + name + ' and cleans up', async t => {
  const { service, root, runtime } = await fixture(t)
  service.run = async (command, args) => {
    if (command === runtime.ffmpeg) return pcm()
    await writeFile(args[args.indexOf('--output-file') + 1] + '.json', JSON.stringify(payload)); return Buffer.alloc(0)
  }
  await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: 'audio/wav' }), status(expected)); assert.deepEqual(await readdir(root), [])
})
test('failed or oversized JSON output removes all temporary files', async t => {
  const { service, root, runtime } = await fixture(t)
  for (const output of ['{invalid', 'x'.repeat(256 * 1024 + 1)]) {
    service.run = async (command, args) => {
      if (command === runtime.ffmpeg) return pcm()
      await writeFile(args[args.indexOf('--output-file') + 1] + '.json', output); return Buffer.alloc(0)
    }
    await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: 'audio/wav' }), status(502))
    assert.deepEqual(await readdir(root), [])
  }
})
test('single slot busy, cancellation cleans temp state, explicit retry succeeds', async t => {
  const { service, root, runtime } = await fixture(t), normal = service.run
  let started
  const ready = new Promise(resolve => { started = resolve })
  service.run = async (command, args, options) => {
    if (command === runtime.ffmpeg) return pcm()
    started()
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  const controller = new AbortController()
  const pending = service.transcribe(Buffer.from('x'), { contentType: 'audio/wav', signal: controller.signal })
  await ready
  await assert.rejects(service.transcribe(Buffer.from('y'), { contentType: 'audio/wav' }), status(409))
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.deepEqual(await readdir(root), [])
  service.run = normal
  assert.equal((await service.transcribe(Buffer.from('x'), { contentType: 'audio/wav' })).text, 'Hola mundo.')
})
test('shutdown aborts only active owned operation, waits cleanup, prevents later starts', async t => {
  const { service, root, runtime } = await fixture(t)
  let started; const ready = new Promise(resolve => { started = resolve })
  service.run = async (command, args, options) => {
    if (command === runtime.ffmpeg) return pcm()
    started()
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  }
  const pending = service.transcribe(Buffer.from('x'), { contentType: 'audio/wav' }); pending.catch(() => {})
  await ready; await service.close(); await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(await readdir(root), [])
  await assert.rejects(service.transcribe(Buffer.from('x'), { contentType: 'audio/wav' }), status(503))
})
test('process failures do not expose stderr or recognized private text', async () => {
  await assert.rejects(runWhisperProcess(process.execPath, ['-e', 'console.error("PRIVATE_TRANSCRIPT_OR_PATH");process.exit(7)']), error => {
    assert.equal(error.status, 422); assert.doesNotMatch(error.message, /PRIVATE/); return true
  })
  await assert.rejects(runWhisperProcess('/missing/whisper-test-binary', []), status(503))
})
test('hung child ignoring SIGTERM is killed before timeout rejection settles', { timeout: 5000 }, async t => {
  const root = await rootFor(t), path = join(root, 'pid')
  const promise = runWhisperProcess(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)', path], { timeout: 350 })
  await assert.rejects(promise, status(504))
  const pid = Number(await readFile(path, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
test('oversized child output is stopped and rejects instead of returning truncated audio', async () => {
  await assert.rejects(runWhisperProcess(process.execPath, ['-e', 'require("fs").writeSync(1,Buffer.alloc(10000));setInterval(()=>{},1000)'],
    { maxOutput: 8, outputError: new WhisperError(413, 'too long') }), status(413))
})
test('AbortSignal terminates child and cannot report success', async () => {
  const controller = new AbortController()
  const promise = runWhisperProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
})
