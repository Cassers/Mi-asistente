import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHarness, disableHarness, harnessStatus, SOURCE } from './harness.mjs'
import { initialize, ROOT } from './setup.mjs'

const source = () => new Map([
  ['SYSTEM/ORCHESTRATOR.md', 'See ME/SKILLS/CUSTOM/orquestar-agentes/SKILL.md'],
  ['SYSTEM/PROTOCOL.md', 'Configure, register, delegate and verify.'],
  ['SYSTEM/REGISTRY.md', '# Registry\narchitecto-skills'],
  ['SYSTEM/README.md', '# Upstream system'],
  ['ME/SKILLS/INDEX.md', '# Upstream skills'],
  ['ME/SKILLS/CUSTOM/orquestar-agentes/SKILL.md', '---\nname: orquestar-agentes\ndescription: Delegate\n---'],
  ['Agentes/arquitecto-skills/PROMPT.md', '# Contract'],
  ['Agentes/arquitecto-skills/SKILLS/INDEX.md', '# Skills'],
  ['ME/IDENTITY.md', 'Do not import this identity'],
  ['ME/MEMORIES/BOOTSTRAP.md', 'Do not import this bootstrap'],
])
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'optional-harness-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(join(ROOT, 'templates'), join(root, 'templates'), { recursive: true })
  const p = await initialize(root)
  return { root, ...p }
}

test('optional install preserves profile, memories, providers, model and native permissions', async t => {
  const { root, workspace, configFile } = await fixture(t)
  const profile = join(workspace, 'ME/CONFIG.json'), memory = join(workspace, 'ME/MEMORIES/GENERAL.md')
  const identity = join(workspace, 'ME/IDENTITY.md'), bootstrap = join(workspace, 'ME/MEMORIES/BOOTSTRAP.md')
  await writeFile(profile, '{"configured":true,"name":"Atenea"}')
  await writeFile(memory, 'Mi memoria que no debe sobrescribirse')
  const previousIdentity = await readFile(identity, 'utf8'), previousBootstrap = await readFile(bootstrap, 'utf8')
  const config = JSON.parse(await readFile(configFile, 'utf8'))
  config.model = 'provider/user-choice'; config.provider = { example: { name: 'Existing provider' } }
  config.permission.edit = 'deny'; config.agent = { custom: { description: 'Existing' } }
  await writeFile(configFile, JSON.stringify(config))
  assert.equal((await harnessStatus(root)).installed, false)
  const result = await installHarness({ root, loadSource: async () => source() })
  assert.equal(result.enabled, true); assert.equal(result.revision, SOURCE.revision)
  assert.equal(await readFile(profile, 'utf8'), '{"configured":true,"name":"Atenea"}')
  assert.equal(await readFile(memory, 'utf8'), 'Mi memoria que no debe sobrescribirse')
  assert.equal(await readFile(identity, 'utf8'), previousIdentity)
  assert.equal(await readFile(bootstrap, 'utf8'), previousBootstrap)
  const next = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(next.default_agent, 'build'); assert.equal(next.model, config.model)
  assert.deepEqual(next.provider, config.provider); assert.deepEqual(next.permission, config.permission)
  assert.deepEqual(next.agent.custom, config.agent.custom)
  const agent = next.agent['arquitecto-skills']
  assert.equal(agent.mode, 'subagent'); assert.equal('model' in agent, false)
  assert.equal(agent.permission.task, 'deny')
  assert.match(agent.prompt, /ARQUITECTO-OPENCODE\.md/)
  assert.ok(await readFile(join(workspace, 'ME/SKILLS/HARNESS.md')))
  await writeFile(join(workspace, 'Agentes/arquitecto-skills/PROMPT.md'), 'My revised contract')
  const repeat = await installHarness({ root, loadSource: () => assert.fail('repeat must not download') })
  assert.equal(repeat.changed, false)
  assert.equal(await readFile(join(workspace, 'Agentes/arquitecto-skills/PROMPT.md'), 'utf8'), 'My revised contract')
  // Ordinary setup cannot turn it off or replace user files.
  await initialize(root); assert.equal((await harnessStatus(root)).enabled, true)
})

test('conflicting files or agent names fail before activation and do not overwrite content', async t => {
  for (const kind of ['file', 'agent']) {
    const { root, workspace, configFile } = await fixture(t)
    if (kind === 'file') await writeFile(join(workspace, 'SYSTEM/REGISTRY.md'), 'My existing registry')
    else {
      const config = JSON.parse(await readFile(configFile, 'utf8'))
      config.agent = { 'arquitecto-skills': { description: 'My existing agent' } }
      await writeFile(configFile, JSON.stringify(config))
    }
    const before = await readFile(configFile, 'utf8')
    await assert.rejects(installHarness({ root, loadSource: async () => source() }), /Conflicto/)
    assert.equal(await readFile(configFile, 'utf8'), before)
    assert.equal((await harnessStatus(root)).enabled, false)
    await assert.rejects(readFile(join(workspace, 'SYSTEM/OPENCODE-HARNESS.md')), { code: 'ENOENT' })
  }
})

test('disable preserves documents and unrelated edits; re-enable is explicit', async t => {
  const { root, workspace, configFile } = await fixture(t)
  await installHarness({ root, loadSource: async () => source() })
  const config = JSON.parse(await readFile(configFile, 'utf8'))
  config.model = 'new/model'; config.instructions.push('MY-RULES.md')
  await writeFile(configFile, JSON.stringify(config))
  const result = await disableHarness(root)
  assert.equal(result.enabled, false); assert.equal(result.installed, true)
  const disabled = JSON.parse(await readFile(configFile, 'utf8'))
  assert.equal(disabled.model, 'new/model'); assert.ok(disabled.instructions.includes('MY-RULES.md'))
  assert.equal(disabled.agent['arquitecto-skills'], undefined)
  assert.ok(await readFile(join(workspace, 'Agentes/arquitecto-skills/PROMPT.md')))
  await initialize(root); assert.equal((await harnessStatus(root)).enabled, false)
  assert.equal((await installHarness({ root, loadSource: async () => source() })).enabled, true)
})

test('customized native agent is not silently discarded by disable', async t => {
  const { root, configFile } = await fixture(t)
  await installHarness({ root, loadSource: async () => source() })
  const config = JSON.parse(await readFile(configFile, 'utf8')); config.agent['arquitecto-skills'].description = 'Customized'
  await writeFile(configFile, JSON.stringify(config))
  await assert.rejects(disableHarness(root), /personalizado/)
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).agent['arquitecto-skills'].description, 'Customized')
})

test('failed download and malformed or escaping sources leave configuration unchanged', async t => {
  const { root, configFile } = await fixture(t)
  const before = await readFile(configFile, 'utf8')
  for (const loadSource of [async () => { throw new Error('network unavailable') }, async () => new Map(),
    async () => new Map([...source(), ['SYSTEM/../../escape.md', 'no']])]) {
    await assert.rejects(installHarness({ root, loadSource }))
    assert.equal(await readFile(configFile, 'utf8'), before)
  }
})

test('symlinked runtime parents fail closed, without writing outside the workspace', async t => {
  const { root, workspace } = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'harness-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(workspace, 'Agentes'))
  await symlink(outside, join(workspace, 'Agentes/arquitecto-skills'), 'dir')
  await assert.rejects(installHarness({ root, loadSource: async () => source() }), /enlaces simbólicos/)
  await assert.rejects(readFile(join(outside, 'PROMPT.md')), { code: 'ENOENT' })
})

test('installation lock prevents concurrent activation and disable', async t => {
  const { root } = await fixture(t)
  let release, started
  const ready = new Promise(ok => { started = ok })
  const installing = installHarness({ root, loadSource: async () => {
    started(); await new Promise(ok => { release = ok }); return source()
  } })
  await ready
  await assert.rejects(installHarness({ root, loadSource: async () => source() }), /en curso/)
  release(); await installing
  await writeFile(join(root, 'opencode/harness.lock'), 'test-owned lock', { flag: 'wx' })
  await assert.rejects(disableHarness(root), /en curso/)
  assert.equal((await harnessStatus(root)).enabled, true)
})

test('preflight rejects symlinked memories before ordinary setup can copy through them', async t => {
  const { root, workspace } = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'harness-memory-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await rm(join(workspace, 'ME/MEMORIES'), { recursive: true }) // Fixture-owned files only.
  await symlink(outside, join(workspace, 'ME/MEMORIES'), 'dir')
  await assert.rejects(installHarness({ root, loadSource: async () => source() }), /enlaces simbólicos/)
  await assert.rejects(readFile(join(outside, 'GENERAL.md')), { code: 'ENOENT' })
})
