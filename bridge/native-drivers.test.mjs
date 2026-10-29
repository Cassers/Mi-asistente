import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ClaudeDriver } from './claude-driver.mjs'
import { AntigravityDriver } from './antigravity-driver.mjs'

async function fixture(t) { const root=await mkdtemp(join(tmpdir(),'native-driver-wire-'));t.after(()=>rm(root,{recursive:true,force:true}));return root }

test('actual Claude SDK transports native text/image blocks and scoped CLI options through stdio without a model call',async t=>{
  const root=await fixture(t),cli=join(root,'fixture.mjs'),receipt=join(root,'receipt.json')
  await writeFile(cli,`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const args=process.argv.slice(2).flatMap(arg=>arg.startsWith('--')&&arg.includes('=')?[arg.slice(0,arg.indexOf('=')),arg.slice(arg.indexOf('=')+1)]:[arg]);const get=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;const sid=get('--session-id')||get('--resume');const input=createInterface({input:process.stdin});input.on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request'){send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{commands:[],models:[{value:'claude-fixture',displayName:'Fixture',supportedEffortLevels:['high']}],account:{apiProvider:'firstParty'}}}});}if(m.type==='user'){writeFileSync(${JSON.stringify(receipt)},JSON.stringify({message:m,args,cwd:process.cwd()}));send({type:'system',subtype:'init',session_id:sid,cwd:process.cwd(),model:'claude-fixture',tools:[]});send({type:'assistant',session_id:sid,message:{id:'answer',role:'assistant',content:[{type:'text',text:'SDK wire OK'}]}});send({type:'result',subtype:'success',is_error:false,result:'SDK wire OK',session_id:sid});}});`)
  const driver=new ClaudeDriver({command:cli}),id=randomUUID(),text=[],sessions=[]
  const models=await driver.models(root);assert.equal(models[0].id,'claude-fixture');assert.equal(models[0].image,true)
  const content=[{type:'text',text:'Synthetic question: preserve exact words.'},{type:'image',source:{type:'base64',media_type:'image/png',data:'c3ludGhldGlj'}}]
  await driver.run({directory:root,id,resume:false,content,signal:new AbortController().signal,onSession:id=>sessions.push(id),onText:value=>text.push(value),onTool(){},permission:async()=>({behavior:'deny',message:'Fixture'})})
  const received=JSON.parse(await readFile(receipt,'utf8'))
  assert.deepEqual(received.message.message.content,content);assert.equal(received.cwd,root);assert.deepEqual(sessions,[id]);assert.deepEqual(text,['SDK wire OK'])
  assert.ok(received.args.includes('--setting-sources'));assert.equal(received.args[received.args.indexOf('--setting-sources')+1],'user,project,local')
  assert.equal(received.args.includes('--dangerously-skip-permissions'),false)
  assert.equal(received.args.includes('--append-system-prompt'),false)
  assert.equal(received.args.includes('--system-prompt'),false,'claude_code native preset is retained rather than replaced')
  await driver.run({directory:root,id,resume:true,content:[{type:'text',text:'Next'}],signal:new AbortController().signal,onSession(){},onText(){},onTool(){},permission:async()=>({behavior:'deny',message:'Fixture'})})
  assert.ok(JSON.parse(await readFile(receipt,'utf8')).args.includes('--resume'))
})
test('Claude driver preserves native denies, questions and account metadata; never configures bypass or personality',async()=>{
  let options
  const q={close(){},supportedModels:async()=>[],async *[Symbol.asyncIterator](){const user=(await options.prompt[Symbol.asyncIterator]().next()).value;assert.equal(user.message.role,'user');const reply=await options.options.canUseTool('Bash',{command:'fake'},{signal:options.options.abortController.signal});assert.equal(reply.behavior,'deny');yield{type:'result',subtype:'success',is_error:false}}}
  const driver=new ClaudeDriver({api:{query:value=>{options=value;return q}},command:'fixture'})
  await driver.run({directory:'/fixture',id:randomUUID(),resume:false,content:[{type:'text',text:'text'}],signal:new AbortController().signal,onSession(){},onText(){},onTool(){},permission:async()=>({behavior:'deny',message:'Denied'})})
  assert.deepEqual(options.options.systemPrompt,{type:'preset',preset:'claude_code'});assert.equal(options.options.permissionMode,'default');assert.equal(options.options.allowDangerouslySkipPermissions,undefined)
})
test('Antigravity official NDJSON protocol sends text, resumes exact native ID, and carries no bypass flags',async t=>{
  const root=await fixture(t),cli=join(root,'agy-fixture.mjs'),receipt=join(root,'agy-input.json'),id=randomUUID()
  await writeFile(cli,`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const args=process.argv.slice(2);const id=${JSON.stringify(id)};createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);writeFileSync(${JSON.stringify(receipt)},JSON.stringify({m,args,cwd:process.cwd()}));send({event:'init',conversation_id:id,init:{cwd:process.cwd(),permission_mode:'request-review'}});send({event:'step_update',step_update:{step_type:'agent_response',state:'DONE',text_delta:'Native AGY answer'}});send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'Native AGY answer'}});});`)
  const calls=[],driver=new AntigravityDriver({command:'fixture',spawnProcess:(command,args,options)=>{calls.push({command,args,options});return spawn(process.execPath,[cli,...args],options)}})
  const content=[{type:'text',text:'Exact text question'}],sessions=[],text=[]
  for(const resume of [false,true])await driver.run({directory:root,id,resume,content,signal:new AbortController().signal,onSession:id=>sessions.push(id),onText:value=>text.push(value),onTool(){}})
  const got=JSON.parse(await readFile(receipt,'utf8'))
  assert.deepEqual(got.m,{event:'user',message:{content}});assert.equal(got.cwd,root);assert.equal(got.args[got.args.indexOf('--conversation')+1],id)
  assert.deepEqual(text,['Native AGY answer','Native AGY answer']);assert.deepEqual(sessions,[id,id]);assert.equal(calls.some(c=>c.args.includes('--dangerously-skip-permissions')),false)
  await assert.rejects(driver.run({directory:root,content:[{type:'image'}]}),/solo texto/)
})
test('Antigravity rejects wrong folder, malformed protocol and missing completion; process abort waits for owned child',async t=>{
  const root=await fixture(t),cli=join(root,'bad.mjs'),id=randomUUID()
  await writeFile(cli,`console.log(JSON.stringify({event:'init',conversation_id:${JSON.stringify(id)},init:{cwd:'/wrong'}}));`)
  const driver=new AntigravityDriver({command:'fixture',spawnProcess:(_c,args,opts)=>spawn(process.execPath,[cli,...args],opts)})
  const options={directory:root,id,resume:true,content:[{type:'text',text:'x'}],signal:new AbortController().signal,onSession(){},onText(){},onTool(){}}
  await assert.rejects(driver.run(options),/protocolo inválido/)
  await writeFile(cli,`console.log(JSON.stringify({event:'init',conversation_id:${JSON.stringify(id)},init:{cwd:process.cwd()}}));setInterval(()=>{},1000);`)
  const control=new AbortController();let started;const init=new Promise(r=>{started=r});const running=driver.run({...options,signal:control.signal,onSession:started})
  await init;control.abort();await running
})
