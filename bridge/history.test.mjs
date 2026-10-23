import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { historyFiles, pruneHistory, selectWindow, sampleFrames, RETENTION_MS, recordingStatus } from './history-store.mjs'

test('malformed model overrides are rejected before starting a server or recorder', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./opencode-bridge.mjs', import.meta.url))], {
    env: { ...process.env, JARVIS_OC_MODEL: 'invalid-model-without-provider' }, encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Identificador de modelo inválido/)
})

test('window selects chronological overlapping audio and images, bounded to retention', () => {
  const now = 2000000000000
  const files = [
    {at: now - 30000, end: now - 20000, kind: 'audio'},
    {at: now - 22000, end: now - 22000, kind: 'frames'},
    {at: now - 5000, end: now - 5000, kind: 'frames'},
  ]
  const result = selectWindow(files, {now, secondsAgo: 20, duration: 5})
  assert.equal(result.start, now - 25000)
  assert.equal(result.end, now - 20000)
  assert.equal(result.files.length, 2)
  assert.throws(() => selectWindow(files, {startTime:'yesterday'}))
})

test('eight selected images preserve first/last and sequence', () => {
  const picked = sampleFrames(Array.from({length:300}, (_,i) => i))
  assert.equal(picked.length, 8)
  assert.equal(picked[0], 0)
  assert.equal(picked.at(-1), 299)
  assert.deepEqual([...picked].sort((a,b)=>a-b), picked)
})

test('retention deletes only expired owned media, preserving recent files, foreign data and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-history-test-'))
  try {
    const now = Date.now()
    const session = join(root, `session-${now}-deadbeef`)
    const frames = join(session,'frames'), audio=join(session,'audio')
    await mkdir(frames,{recursive:true}); await mkdir(audio)
    const expired = join(frames, `screen-${now-RETENTION_MS-10000}-1.png`)
    const fresh = join(frames, `screen-${now-100}-2.png`)
    const outside = join(root,'keep.png')
    const link = join(frames,`screen-${now-RETENTION_MS-20000}-3.png`)
    await Promise.all([writeFile(expired,'old'),writeFile(fresh,'new'),writeFile(outside,'personal'),writeFile(join(frames,'personal.txt'),'keep')])
    await symlink(outside,link)
    await writeFile(join(audio,`mic-${Math.floor((now-5000)/1000)}.ogg`),'audio')
    assert.equal((await historyFiles(root)).length,3)
    assert.equal(await pruneHistory(root,now),1)
    await assert.rejects(access(expired))
    await access(fresh); await access(link)
    assert.equal(await readFile(outside,'utf8'),'personal')
    assert.equal(await readFile(join(frames,'personal.txt'),'utf8'),'keep')
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('stale active status is disconnected; intentionally paused status remains paused', async () => {
  const root = await mkdtemp(join(tmpdir(),'jarvis-status-test-'))
  try {
    await writeFile(join(root,'status.json'),JSON.stringify({active:true,updatedAt:Date.now()-11000}))
    assert.equal((await recordingStatus(root)).active,false)
    await writeFile(join(root,'status.json'),JSON.stringify({active:false,updatedAt:0,error:''}))
    assert.equal((await recordingStatus(root)).error,'')
  } finally { await rm(root,{recursive:true,force:true}) }
})
