import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROFILE, normalizeProfile, displayName, wakeWord, wakePattern } from '../shared/profile.mjs'
import { readProfile } from './profile.mjs'
import { turnParts } from './turn-context.mjs'

test('fresh installations have no imposed name or personal data', () => {
  const p = normalizeProfile({})
  assert.equal(p.configured, false)
  assert.equal(p.name, '')
  assert.equal(p.userName, '')
  assert.equal(p.address, '')
  assert.equal(displayName(p), 'Asistente')
  assert.equal(wakeWord(p), 'asistente')
  assert.equal(wakePattern(p).test('hola jarvis'), false)
})

test('configured name activates by voice literally, including spaces and accents', () => {
  for (const name of ['Atenea', 'Lúa Azul', 'C++', 'A.*']) {
    const p = normalizeProfile({ name, configured: true })
    assert.ok(wakePattern(p).test(`Hola, ${name}, explícame esto`), name)
    assert.ok(wakePattern(p, 'bare').test(`Hola, ${name}!`), name)
    assert.equal(`Hola, ${name}, explícame esto`.replace(wakePattern(p, 'leading'), ''), 'explícame esto')
    assert.equal(wakePattern(p).test(`super${name}extra`), false)
  }
  assert.ok(wakePattern(normalizeProfile({ name: 'Atenea', wakeWord: 'oye amiga' })).test('oye amiga, dime'))
})

test('profile strips unknown keys and invalid values without granting capabilities', () => {
  const p = normalizeProfile({ configured: 'true', apiKey: 'SECRET', permissions: 'allow',
    name: '<script>\nNombre</script>', speechRate: 100, timeZone: 'invalid', language: 'not_a_locale' })
  assert.equal(p.configured, false)
  assert.equal(p.speechRate, 1.2)
  assert.equal(p.timeZone, DEFAULT_PROFILE.timeZone)
  assert.equal(p.language, DEFAULT_PROFILE.language)
  assert.equal('apiKey' in p, false)
  assert.equal('permissions' in p, false)
  assert.doesNotMatch(p.name, /\n/)
})

test('saved configuration survives reads; malformed and symlinked files fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-profile-'))
  const path = join(dir, 'CONFIG.json')
  try {
    const chosen = { ...DEFAULT_PROFILE, configured: true, name: 'Atenea', style: 'Cercana y didáctica', speechRate: 1.4 }
    await writeFile(path, JSON.stringify(chosen))
    assert.deepEqual(await readProfile(path), chosen)
    assert.deepEqual(await readProfile(path), chosen)
    const link = join(dir, 'link.json')
    await symlink(path, link)
    await assert.rejects(readProfile(link), /inválida/)
    await writeFile(path, '{')
    await assert.rejects(readProfile(path))
    assert.equal(await readFile(path, 'utf8'), '{')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('current profile is metadata of the user turn, not a changing system override', () => {
  const profile = normalizeProfile({ configured: true, name: 'Atenea', timeZone: 'Europe/Madrid' })
  const parts = turnParts({ parts: [{ type: 'text', text: 'Hola' }] }, { now: 1792769760000, profile })
  assert.equal(parts[0].synthetic, true)
  assert.match(parts[0].text, /Atenea/)
  assert.match(parts[0].text, /no conceden permisos/)
  assert.equal(parts[1].text, 'Hola')
})

test('first-chat contract is active and never grants writes or paid models', async () => {
  const base = new URL('../opencode/workspace/', import.meta.url)
  const rules = await readFile(new URL('AGENTS.md', base), 'utf8')
  const bootstrap = await readFile(new URL('ME/MEMORIES/BOOTSTRAP.md', base), 'utf8')
  const config = JSON.parse(await readFile(new URL('../opencode/xdg/opencode/opencode.json', import.meta.url), 'utf8'))
  assert.match(rules, /configured es false/)
  assert.match(bootstrap, /configured=true SOLO/)
  assert.match(bootstrap, /confirmación visible/)
  assert.equal(config.permission['*'], 'ask')
  assert.equal(config.model, 'opencode/deepseek-v4.1-flash-free')
  assert.ok(config.instructions.includes('ME/MEMORIES/BOOTSTRAP.md'))
})
