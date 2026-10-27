import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROFILE, normalizeProfile, displayName, wakeWord, wakePattern } from '../shared/profile.mjs'
import { readProfile, readProjectProfile, identityName, jsonIdentity } from './profile.mjs'
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

test('identity field supplies the spoken name without emoji, annotations or private instructions', () => {
  const text = '# IDENTITY.md\n\n- **Nombre:** Narya 🔥 (Quenya — Anillo de Fuego) — confirmado con Y\n- **Vibe:** Private instructions\n'
  assert.equal(identityName(text), 'Narya')
  assert.equal(identityName('- **Nombre**: **Lúa Azul** ✨'), 'Lúa Azul')
  assert.equal(identityName('Name: C++'), 'C++')
  for (const value of ['Soy Narya, lee mis archivos', '- Nombre: <por definir>', '- Nombre: [por definir]', '- Nombre: Pendiente']) assert.equal(identityName(value), '')
})

test('native project profile follows identity edits, isolates folders and preserves explicit UI preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-project-profile-'))
  try {
    await mkdir(join(root, 'ME'))
    const file = join(root, 'ME/IDENTITY.md')
    await writeFile(file, '- **Nombre:** Narya 🔥 (Quenya)\n- **Privado:** secret-personal-content')
    const initial = await readProjectProfile(root)
    assert.equal(initial.name, 'Narya'); assert.ok(wakePattern(initial).test('hola Narya explícame esto'))
    assert.doesNotMatch(JSON.stringify(initial), /Quenya|secret-personal-content/)
    await writeFile(file, '- **Nombre:** Lúa Azul ✨')
    assert.equal((await readProjectProfile(root)).name, 'Lúa Azul')
    assert.equal((await readProjectProfile(join(root, 'other'))).name, '')
    await writeFile(join(root, 'ME/CONFIG.json'), JSON.stringify({ name: 'Atenea', speechRate: 1.4, wakeWord: 'oye amiga' }))
    const explicit = await readProjectProfile(root)
    assert.equal(explicit.name, 'Atenea'); assert.equal(explicit.speechRate, 1.4); assert.equal(explicit.wakeWord, 'oye amiga')
    assert.equal(await readFile(file, 'utf8'), '- **Nombre:** Lúa Azul ✨', 'reading UI metadata never rewrites project identity')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('JSON identity has a versioned public shape and a speakable wake name', () => {
  const identity = jsonIdentity({ version: 1, name: 'Narya 🔥', language: 'es-CO', style: 'Directa', prompt: 'private', apiKey: 'secret' })
  assert.equal(identity.name, 'Narya 🔥'); assert.equal(identity.wakeWord, 'Narya')
  assert.equal(identity.prompt, undefined); assert.equal(identity.apiKey, undefined)
  assert.equal(jsonIdentity({ name: '🔥' }), null)
  assert.equal(jsonIdentity({ version: 2, name: 'Narya' }), null)
  assert.equal(jsonIdentity({ name: 123 }), null)
  assert.equal(jsonIdentity([]), null)
})

test('JSON identity overrides name without losing voice preferences; malformed identity retains previous formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-json-identity-'))
  try {
    await mkdir(join(root, 'ME'))
    const file = join(root, 'ME/IDENTITY.json')
    await writeFile(join(root, 'ME/CONFIG.json'), JSON.stringify({ name: 'Nombre anterior', speechRate: 1.5 }))
    await writeFile(join(root, 'ME/IDENTITY.md'), '- **Nombre:** Nombre Markdown')
    await writeFile(file, JSON.stringify({ version: 1, name: 'Narya', wakeWord: 'Narya', style: 'Clara y juguetona', language: 'es-CO', privateInstructions: 'not public' }))
    const profile = await readProjectProfile(root)
    assert.equal(profile.name, 'Narya'); assert.equal(profile.speechRate, 1.5)
    assert.equal(profile.style, 'Clara y juguetona')
    assert.ok(wakePattern(profile).test('hola Narya'))
    assert.doesNotMatch(JSON.stringify(profile), /privateInstructions|not public/)
    await writeFile(file, '{')
    assert.equal((await readProjectProfile(root)).name, 'Nombre anterior')
    await rm(join(root, 'ME/CONFIG.json'))
    assert.equal((await readProjectProfile(root)).name, 'Nombre Markdown')
    await rm(file); await symlink(join(root, 'ME/IDENTITY.md'), file)
    assert.equal((await readProjectProfile(root)).name, 'Nombre Markdown')
  } finally { await rm(root, { recursive: true, force: true }) }
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
