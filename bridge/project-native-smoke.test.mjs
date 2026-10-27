import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { Projects, NativeConversations } from './projects.mjs'

test('real OpenCode: folder config, skills/MCPs and native chats stay project-scoped without inference', {
  skip: process.env.JARVIS_NATIVE_SMOKE !== '1', timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'assistant-native-projects-'))
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const reserve = net.createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  let child, log = ''
  try {
    for (const name of ['one','two','config','data','state','cache']) await mkdir(join(root, name))
    const a = join(root, 'one'), b = join(root, 'two')
    await writeFile(join(a, 'AGENTS.md'), '# Fixture project\nUse fixture project one instructions.\n')
    await writeFile(join(a, 'RULES.md'), 'Additional fixture rules, not an injected UI prompt.\n')
    await mkdir(join(a, '.opencode/skills/fixture-project'), { recursive: true })
    await writeFile(join(a, '.opencode/skills/fixture-project/SKILL.md'), '---\nname: fixture-project\ndescription: Fixture-only verification skill.\n---\nRead fixture data only.\n')
    const mcp = join(root, 'mcp.mjs')
    const sdk = pathToFileURL(join(repo, 'node_modules/@modelcontextprotocol/sdk/dist/esm/')).href
    await writeFile(mcp, `import {McpServer} from ${JSON.stringify(sdk+'server/mcp.js')}; import {StdioServerTransport} from ${JSON.stringify(sdk+'server/stdio.js')}; const server=new McpServer({name:'fixture',version:'1.0.0'}); server.registerTool('fixture_ping',{description:'Fixture ping'},async()=>({content:[{type:'text',text:'fixture-only'}]})); await server.connect(new StdioServerTransport());`)
    await writeFile(join(a, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
      default_agent: 'fixture-primary', instructions: ['RULES.md'],
      agent: { 'fixture-primary': { mode: 'primary', description: 'Fixture-only native primary', prompt: 'Use fixture configuration.' } },
      mcp: { fixture: { type: 'local', command: [process.execPath, mcp] } },
    }))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key]
    Object.assign(env, { XDG_CONFIG_HOME: join(root,'config'), XDG_DATA_HOME: join(root,'data'),
      XDG_STATE_HOME: join(root,'state'), XDG_CACHE_HOME: join(root,'cache'),
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_SERVER_PASSWORD: 'fixture-password' })
    child = spawn(join(repo,'node_modules/.bin/opencode'), ['serve','--hostname','127.0.0.1','--port',String(port)], { cwd: root, env, detached: true, stdio: ['ignore','pipe','pipe'] })
    child.stdout.on('data', data => { log = (log+data).slice(-6000) }); child.stderr.on('data', data => { log = (log+data).slice(-6000) })
    let ready = false
    for (let i=0; i<200; i++) {
      try { const res = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { authorization: 'Basic '+Buffer.from('opencode:fixture-password').toString('base64') }, signal: AbortSignal.timeout(500) }); if (res.ok) { ready = true; break } } catch { /* booting */ }
      if (child.exitCode !== null) break
      await new Promise(resolve => setTimeout(resolve,100))
    }
    assert.ok(ready, `Fixture OpenCode failed to start: ${log}`)
    const projects = new Projects({ serverURL: `http://127.0.0.1:${port}`, password: 'fixture-password', file: join(root,'projects.json') })
    const pa = await projects.open({ directory: a }), pb = await projects.open({ directory: b })
    const api = projects.api(pa), apiB = projects.api(pb)
    const config = await api('GET','/config')
    assert.equal(config.default_agent, 'fixture-primary')
    assert.ok(config.instructions.some(path => path.endsWith('RULES.md')))
    const agents = await api('GET','/agent')
    assert.ok(agents.some(agent => agent.name === 'fixture-primary' && agent.prompt.includes('fixture configuration')))
    assert.equal((await api('GET','/mcp')).fixture.status, 'connected')
    const skills = await api('GET','/skill')
    assert.ok(skills.some(skill => skill.name === 'fixture-project'), 'native project skill discovery')
    const chatsA = new NativeConversations(api, a), chatsB = new NativeConversations(apiB, b)
    const first = await chatsA.open('new'), second = await chatsB.open('new')
    assert.ok((await chatsA.list()).some(entry => entry.id === first.id))
    assert.ok(!(await chatsA.list()).some(entry => entry.id === second.id))
    await assert.rejects(chatsA.checked(second.id), /otra carpeta/)
    assert.equal((await chatsA.open(first.id)).id, first.id)
    assert.equal((await api('GET',`/session/${first.id}/message`)).length, 0, 'no LLM inference')
    assert.match(await readFile(join(a,'AGENTS.md'),'utf8'), /fixture project one/)
    assert.ok(!(await apiB('GET','/config')).instructions?.includes('RULES.md'))
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      await Promise.race([new Promise(resolve => child.once('exit',resolve)), new Promise(resolve => setTimeout(resolve,1500))])
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
    await rm(root, { recursive: true, force: true })
  }
})
