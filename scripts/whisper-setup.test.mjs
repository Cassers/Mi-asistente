import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWhisperSetupProcess } from './whisper-setup.mjs'

test('setup process returns bounded synthetic command output', async () => {
  assert.equal(await runWhisperSetupProcess(process.execPath, ['-e', 'require("fs").writeSync(1,"SETUP_OK")'], { capture: true, timeout: 1000 }), 'SETUP_OK')
})
test('setup distinguishes command failure from timeout without printing command output', async () => {
  await assert.rejects(runWhisperSetupProcess(process.execPath, ['-e', 'process.exit(7)'], { capture: true, timeout: 1000 }), /falló.*código 7/)
})
test('setup timeout kills its own process group including descendants before rejecting', { timeout: 5000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'whisper-setup-process-')), pidfile = join(root, 'pids.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = 'const{spawn}=require("child_process");const fs=require("fs");process.on("SIGTERM",()=>{});const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.once("spawn",()=>fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000)'
  await assert.rejects(runWhisperSetupProcess(process.execPath, ['-e', script, pidfile], { capture: true, timeout: 350 }), /excedió el tiempo máximo \(0.35 s\)/)
  for (const pid of JSON.parse(await readFile(pidfile, 'utf8'))) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
