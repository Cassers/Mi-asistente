import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Whisper } from './whisper.mjs'
import { runWhisperProcess } from './whisper-process.mjs'

const ffmpeg = process.env.JARVIS_WHISPER_FFMPEG || 'ffmpeg'
const hasFFmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0
const until = async read => { const end = Date.now() + 7000; while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)) } throw Error('Synthetic Whisper HTTP fixture timed out') }
const pcm = seconds => { const value = Buffer.alloc(seconds * 32000); for (let at = 0; at < value.length; at += 2) value.writeInt16LE(Math.round(5000 * Math.sin(at * 0.08)), at); return value }
const wav = pcm => {
 const out = Buffer.alloc(44 + pcm.length); out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44); return out
}
test('actual project HTTP bridge: local-only Whisper route, CORS/Host, raw bytes, truthful errors, disconnect cleanup and retry', { timeout: 25000, skip: !hasFFmpeg }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'whisper-http-')), cli = join(root, 'whisper-cli'), model = join(root, 'model.bin'), mode = join(root, 'mode'), called = join(root, 'called.json'), ended = join(root, 'ended')
 t.after(() => rm(root, { recursive: true, force: true }))
 await writeFile(model, Buffer.alloc(2048)); await writeFile(mode, 'ok')
 const cliSource = '#!/usr/bin/env node\n' +
 'const fs=require("fs");const args=process.argv.slice(2);const get=k=>args[args.indexOf(k)+1];fs.writeFileSync(' + JSON.stringify(called) + ',JSON.stringify({pid:process.pid,wav:get("--file"),args}));' +
 'const mode=fs.readFileSync(' + JSON.stringify(mode) + ',"utf8");if(mode==="hang"){process.on("SIGTERM",()=>{fs.writeFileSync(' + JSON.stringify(ended) + ',"stopped");process.exit(0)});setInterval(()=>{},1000)}else if(mode==="fail")process.exit(5);else fs.writeFileSync(get("--output-file")+".json",JSON.stringify({result:{language:"es"},transcription:[{text:"Texto del proceso de prueba local."}]}));'
 await writeFile(cli, cliSource, { mode: 0o700 })
 const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
 const origin = 'http://127.0.0.1:5173', base = 'http://127.0.0.1:' + port
 const child = spawn(process.execPath, [fileURLToPath(new URL('./project-bridge.mjs', import.meta.url))], { cwd: root, env: {
  ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
  JARVIS_WHISPER_CLI: cli, JARVIS_WHISPER_MODEL: model, JARVIS_WHISPER_FFMPEG: ffmpeg,
  JARVIS_BRIDGE_PORT: String(port), JARVIS_PROJECT_REGISTRY: join(root, 'projects.json'), JARVIS_HISTORY_DIR: join(root, 'history'),
  JARVIS_RECORDING: '0', JARVIS_AUTO_SCREEN: '0', JARVIS_ALLOWED_ORIGINS: origin, OPENCODE_URL: 'http://127.0.0.1:1',
 }, stdio: ['ignore', 'ignore', 'ignore'] })
 t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit } })
 await until(async () => { try { return (await fetch(base + '/health')).ok } catch { return false } })
 const get = () => fetch(base + '/whisper')
 const send = (body, type = 'audio/wav', query = '') => fetch(base + '/whisper/transcribe' + query, { method: 'POST', headers: { origin, 'content-type': type }, body })
 let response = await get(), available = await response.json(); assert.equal(available.engine, 'whisper'); assert.equal(available.available, true); assert.equal(available.model, 'model.bin')
 assert.equal(available.maxSeconds, 120); assert.doesNotMatch(JSON.stringify(available), new RegExp(root))
 await assert.rejects(readFile(called), { code: 'ENOENT' }, 'availability does not execute Whisper')
 response = await fetch(base + '/whisper', { headers: { origin: 'https://untrusted.example' } }); assert.equal(response.status, 403)
 const hostStatus = await new Promise(resolve => { const req = http.get(base + '/whisper', { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', () => resolve(0)) }); assert.equal(hostStatus, 403)
 response = await fetch(base + '/whisper/transcribe', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav(pcm(1)) }); assert.equal(response.status, 403)
 response = await send(wav(pcm(1)), 'audio/wav', '?language=es'); assert.equal(response.status, 200)
 assert.deepEqual(await response.json(), { text: 'Texto del proceso de prueba local.', engine: 'whisper', model: 'model.bin', language: 'es' })
 const first = JSON.parse(await readFile(called, 'utf8')); await assert.rejects(stat(first.wav), { code: 'ENOENT' })
 assert.equal(response.headers.get('access-control-allow-origin'), origin)
 response = await send(Buffer.from('not JSON'), 'application/json'); assert.equal(response.status, 415)
 response = await send(Buffer.from('https://example.com/private.wav')); assert.equal(response.status, 422)
 response = await send(wav(Buffer.alloc(32000))); assert.equal(response.status, 422)
 response = await send(wav(pcm(1)), 'audio/wav', '?file=/private/audio'); assert.equal(response.status, 400)
 response = await send(wav(pcm(1)), 'audio/wav', '?language=es&language=en'); assert.equal(response.status, 400)
 response = await fetch(base + '/stt', { method: 'POST', headers: { origin }, body: 'no remote fallback' }); assert.equal(response.status, 404)
 await writeFile(mode, 'fail'); response = await send(wav(pcm(1))); assert.equal(response.status, 422); assert.doesNotMatch(JSON.stringify(await response.json()), /Texto del proceso|whisper-http-/)
 await writeFile(mode, 'hang'); await rm(called)
 const controller = new AbortController()
 const hanging = fetch(base + '/whisper/transcribe', { method: 'POST', headers: { origin, 'content-type': 'audio/wav' }, body: wav(pcm(1)), signal: controller.signal }); hanging.catch(() => {})
 const active = await until(async () => { try { return JSON.parse(await readFile(called, 'utf8')) } catch { return null } })
 response = await send(wav(pcm(1))); assert.equal(response.status, 409)
 controller.abort(); await assert.rejects(hanging, { name: 'AbortError' })
 await until(async () => { try { return await readFile(ended, 'utf8') } catch { return null } })
 await until(async () => { try { await stat(active.wav); return false } catch { return true } })
 assert.throws(() => process.kill(active.pid, 0), { code: 'ESRCH' })
 await writeFile(mode, 'ok'); response = await send(wav(pcm(1))); assert.equal(response.status, 200)
 await rm(model); response = await get(); assert.equal((await response.json()).available, false)
 response = await send(wav(pcm(1))); assert.equal(response.status, 503)
 await writeFile(model, Buffer.alloc(2048)); response = await get(); assert.equal((await response.json()).available, true)
 const oversized = await new Promise((resolve, reject) => {
  const req = http.request(base + '/whisper/transcribe', { method: 'POST', headers: { origin, 'content-type': 'audio/wav', 'content-length': String(16 * 1024 * 1024 + 1) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', reject); req.end()
 }); assert.equal(oversized, 413)
})

test('real FFmpeg decodes WAV, WebM and ordinary seek-requiring moov-at-end M4A; no native inference', { timeout: 15000, skip: !hasFFmpeg }, async t => {
 const root = await mkdtemp(join(tmpdir(), 'whisper-formats-')); t.after(() => rm(root, { recursive: true, force: true }))
 const tasks = join(root, 'tasks'); await mkdir(tasks)
 const encoded = join(root, 'synthetic.m4a')
 await runWhisperProcess(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=30',
  '-c:a', 'aac', '-b:a', '48k', '-f', 'ipod', encoded], { timeout: 10000 })
 const m4a = await readFile(encoded); assert.ok(m4a.length > 32768); assert.ok(m4a.indexOf('moov') > m4a.indexOf('mdat'))
 const webm = await runWhisperProcess(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=1', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'])
 let transcriptions = 0
 const service = new Whisper({ tempRoot: tasks, detect: async () => ({ available: true, cli: 'synthetic-whisper', model: '/fixture/model.bin', ffmpeg }),
  run: async (command, args, options) => {
   if (command !== 'synthetic-whisper') return runWhisperProcess(command, args, options)
   transcriptions++
   await writeFile(args[args.indexOf('--output-file') + 1] + '.json', JSON.stringify({ transcription: [{ text: 'Synthetic decoder fixture only.' }] }))
   return Buffer.alloc(0)
  },
 })
 for (const [data, contentType] of [[wav(pcm(1)), 'audio/wav'], [webm, 'audio/webm;codecs=opus'], [m4a, 'audio/mp4'], [m4a, 'audio/x-m4a']]) {
  assert.equal((await service.transcribe(data, { contentType })).engine, 'whisper'); assert.deepEqual(await readdir(tasks), [])
 }
 assert.equal(transcriptions, 4)
 await assert.rejects(service.transcribe(Buffer.from('#EXTM3U\nhttp://127.0.0.1:1/never\n'), { contentType: 'audio/mp4' }), error => error.status === 422)
 assert.deepEqual(await readdir(tasks), [])
})
