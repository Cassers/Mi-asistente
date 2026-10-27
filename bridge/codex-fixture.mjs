// Fake CLI subprocess: never imports Codex, credentials, model APIs or microphone code.
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
const input = createInterface({ input: process.stdin })
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
input.on('line', line => {
  const request = JSON.parse(line)
  if (!Object.hasOwn(request, 'id')) return
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'codex-fake', platformFamily: 'unix', platformOs: 'linux' } })
  else if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } })
  else if (request.method === 'config/read') send({ id: request.id, result: { config: { model: 'fake-model' } } })
  else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: 'fake-model', displayName: 'Fake', inputModalities: ['text'], supportedReasoningEfforts: [] }], nextCursor: null } })
  else if (request.method === 'echo') send({ id: request.id, result: request.params })
  else if (request.method === 'error') send({ id: request.id, error: { code: -32000, message: 'sk-private-secret TOKEN=never-forward-this' } })
  else if (request.method === 'descendant') {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore','ignore','ignore','ipc'] })
    child.once('message', () => send({ id: request.id, result: { pid: child.pid } }))
  }
  else if (request.method === 'crash') process.exit(1)
  else if (request.method === 'invalid') process.stdout.write('not-json\n')
  else if (request.method === 'large') process.stdout.write('x'.repeat(5000))
  else if (request.method === 'split') {
    const payload = Buffer.from(JSON.stringify({ id: request.id, result: 'español 🙂' }) + '\n')
    const at = payload.indexOf(Buffer.from('🙂')) + 1
    process.stdout.write(payload.subarray(0, at))
    setImmediate(() => { process.stdout.write(payload.subarray(at)); send({ method: 'item/tool/requestUserInput', id: 'native-approval', params: { threadId: 'thr-a' } }) })
  }
})
