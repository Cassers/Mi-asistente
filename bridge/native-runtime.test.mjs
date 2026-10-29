import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NativeManager } from './native-runtime.mjs'
import { attachCodexClient } from './codex-bridge.mjs'
import { FakeSocket, until, flush } from './codex-test-fixture.mjs'

async function fixture(t, application = 'claude') {
  const root = await mkdtemp(join(tmpdir(), 'native-apps-test-')), calls = [], sessions = new Map()
  const driver = { verify: async () => true, models: async () => application === 'claude' ? [{ id: 'claude-fixture', image: true, variants: ['high'] }] : [],
    list: async dir => [...sessions.values()].filter(s => s.cwd === dir), info: async (_dir,id) => sessions.get(id), history: async () => [],
    run: async options => { calls.push(options); const id = application === 'claude' || options.resume ? options.id : randomUUID(); sessions.set(id,{sessionId:id,cwd:options.directory,lastModified:Date.now(),summary:'Fixture'}); await options.onSession(id); options.onText('Native fixture answer') },
  }
  let captures = 0
  const manager = new NativeManager({ drivers: { [application]: driver }, stateRoot: join(root,'state'), screen: async (text, options) => {
    captures++; options.onState('attached'); return { parts: [{type:'file',url:'data:image/png;base64,c3ludGhldGljLWltYWdl'}], context:'Synthetic current capture' }
  } })
  const runtime = await manager.runtime(root,application)
  t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true})})
  return { root, manager, runtime, driver, calls, sessions, captures:()=>captures }
}

test('Claude native text/image request preserves cwd, exact user question, image bytes and session on resume', async t=>{
  const f=await fixture(t), state=await f.runtime.open('new'), frames=[]
  f.runtime.subscribe(state,frame=>frames.push(frame))
  await f.runtime.ask(state,{id:'one',text:'Original question',model:'claude-fixture',variant:'high',screen:true,audioMode:'transcript'})
  assert.equal(f.calls[0].directory,f.root);assert.equal(f.calls[0].id,state.id);assert.equal(f.calls[0].resume,false)
  assert.ok(f.calls[0].content[0].text.startsWith('Original question'))
  const image=f.calls[0].content[1];assert.equal(image.type,'image');assert.equal(Buffer.from(image.source.data,'base64').toString(),'synthetic-image')
  assert.equal(f.calls[0].model,'claude-fixture');assert.equal(f.calls[0].effort,'high')
  await f.runtime.ask(state,{id:'two',text:'Next',screen:false})
  assert.equal(f.calls[1].resume,true);assert.equal(f.calls[1].id,state.id);assert.equal(f.captures(),1)
  assert.ok(frames.some(f=>f.type==='done'&&f.status==='ok'))
})
test('project membership, forged sessions, unsupported model and all audio bypasses fail without generation',async t=>{
  const f=await fixture(t), state=await f.runtime.open('new'), errors=[]
  f.runtime.subscribe(state,frame=>{if(frame.type==='error')errors.push(frame)})
  await assert.rejects(f.runtime.open(randomUUID()),/pertenece/)
  for(const patch of [{audio:{data:'clip'}},{audioMode:'direct'},{preserveOnly:true}])await assert.rejects(f.runtime.ask(state,{id:'bad',text:'old subtitle',...patch}),/transcripción/)
  await f.runtime.ask(state,{id:'model',text:'text',model:'forged'})
  assert.equal(errors.length,1);assert.equal(f.calls.length,0)
  const imported=randomUUID();f.sessions.set(imported,{sessionId:imported,cwd:f.root+'/other',summary:'foreign'})
  assert.equal((await f.runtime.list()).some(s=>s.id===imported),false)
})
test('detach keeps work and pending permissions; reattach resets mode; questions never auto-approved',async t=>{
  const f=await fixture(t),state=await f.runtime.open('new')
  let answer
  f.driver.run=async options=>{f.calls.push(options);await options.onSession(options.id);answer=await options.permission('Bash',{command:'fixture-only'},{signal:options.signal,toolUseID:'cmd'});options.onText('finished')}
  let detach=f.runtime.subscribe(state,()=>{})
  const running=f.runtime.ask(state,{id:'one',text:'permission'})
  await until(()=>state.policy.pending.size===1)
  const id=[...state.policy.pending.keys()][0];detach()
  assert.equal(state.policy.pending.size,1);assert.ok(state.op)
  detach=f.runtime.subscribe(state,()=>{});await state.policy.respond(id,'reject');await running
  assert.equal(answer.behavior,'deny');assert.equal(state.policy.pending.size,0)
  let result
  state.policy.setMode('total',true)
  f.driver.run=async options=>{result=await options.permission('AskUserQuestion',{questions:[{question:'Choose?',options:[{label:'A'}]}]},{signal:options.signal});options.onText('chosen')}
  const asking=f.runtime.ask(state,{id:'two',text:'Question'})
  await until(()=>state.inputs.size===1)
  assert.equal(state.policy.pending.size,0)
  f.runtime.answerInput(state,[...state.inputs.keys()][0],{});await asking;assert.equal(result.behavior,'deny')
  detach();f.runtime.subscribe(state,()=>{});assert.equal(state.policy.mode,'manual')
})
test('interrupt waits for native abort and does not publish successful completion',async t=>{
  const f=await fixture(t),state=await f.runtime.open('new'),frames=[]
  f.runtime.subscribe(state,frame=>frames.push(frame))
  f.driver.run=async options=>{await options.onSession(options.id);await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}))}
  const running=f.runtime.ask(state,{id:'one',text:'hold'})
  await until(()=>!!state.nativeID);await f.runtime.interrupt(state);await running
  assert.equal(state.op,null);assert.ok(frames.some(f=>f.type==='done'&&f.status==='cancelled'))
  assert.equal(frames.some(f=>f.type==='done'&&f.status==='ok'),false)
})
test('Antigravity is a real text driver, persists its native ID for restart/resume and rejects images before capture',async t=>{
  const f=await fixture(t,'antigravity'),state=await f.runtime.open('new')
  assert.equal(f.runtime.capabilities.screenOptIn,false)
  await assert.rejects(f.runtime.ask(state,{text:'look',screen:true}),/solo texto/)
  assert.equal(f.captures(),0);assert.equal(f.calls.length,0)
  await f.runtime.ask(state,{id:'one',text:'first'})
  const nativeID=state.nativeID
  assert.notEqual(nativeID,state.id)
  const runtimeFile=JSON.parse(await readFile(f.runtime.file,'utf8'));assert.equal(runtimeFile.sessions[0].nativeID,nativeID)
  const fresh=new NativeManager({drivers:{antigravity:f.driver},stateRoot:join(f.root,'state')})
  const resumed=await fresh.runtime(f.root,'antigravity'),restored=await resumed.open(state.id)
  await resumed.ask(restored,{id:'two',text:'second'})
  assert.equal(f.calls.at(-1).id,nativeID);assert.equal(f.calls.at(-1).resume,true)
  assert.equal(restored.turns.length,4);assert.equal(restored.policy.setMode('total',true),false)
  await fresh.close()
})
test('new native socket advertises honest capabilities; recording controls and transcript policy remain enforced',async t=>{
  for(const application of ['claude','antigravity']){
    const f=await fixture(t,application),socket=new FakeSocket(),recording={active:false,controlVersion:1}
    await attachCodexClient(socket,{project:{directory:f.root,name:'Fixture',application},manager:{runtime:()=>f.runtime},recorder:{snapshot:()=>recording,setActive:async()=>{}},query:new URLSearchParams({session:'new'})})
    const ready=socket.frames.find(f=>f.type==='ready');assert.equal(ready.application,application);assert.equal(ready.capabilities.directAudio,false);assert.equal(ready.capabilities.transcriptOnly,true)
    assert.equal(ready.capabilities.screenOptIn,application==='claude');assert.equal(ready.capabilities.archive,false)
    socket.message({type:'ask',id:'blocked',text:'old caption',audioMode:'direct',audio:{data:'old'}});await flush()
    assert.equal(f.calls.length,0);assert.ok(socket.frames.some(f=>f.type==='error'))
    socket.message({type:'recording',active:false,requestID:'privacy'});await flush();assert.ok(socket.frames.some(f=>f.type==='recording'&&f.requestID==='privacy'))
    socket.close()
  }
})

test('detaching a total-mode view resets policy and leaves later native approval pending without executing it',async t=>{
  const f=await fixture(t),state=await f.runtime.open('new')
  const detach=f.runtime.subscribe(state,()=>{});state.policy.setMode('total',true);detach()
  assert.equal(state.policy.mode,'manual')
  state.op={};const controller=new AbortController();let settled=false
  const reply=f.runtime.permission(state,'Bash',{command:'fixture-only-no-execution'},{signal:controller.signal,toolUseID:'after-detach'}).then(v=>{settled=true;return v})
  await flush();assert.equal(settled,false);assert.equal(state.policy.pending.size,1)
  controller.abort();assert.equal((await reply).behavior,'deny');state.op=null
})

test('concurrent first opens coalesce persisted load and share one busy native session owner',async t=>{
  const f=await fixture(t,'antigravity'),state=await f.runtime.open('new')
  await f.runtime.ask(state,{id:'seed',text:'seed'})
  const fresh=new NativeManager({drivers:{antigravity:f.driver},stateRoot:join(f.root,'state')})
  const runtime=await fresh.runtime(f.root,'antigravity')
  const [a,b]=await Promise.all([runtime.open(state.id),runtime.open(state.id)])
  assert.equal(a,b)
  let started;const init=new Promise(r=>{started=r})
  f.driver.run=async options=>{started();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}))}
  const running=runtime.ask(a,{id:'held',text:'first'});await init
  await assert.rejects(runtime.ask(b,{id:'duplicate',text:'second'}),/trabajando/)
  await runtime.interrupt(a);await running;await fresh.close()
})
