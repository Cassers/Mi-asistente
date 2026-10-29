import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'

const until=async read=>{const deadline=Date.now()+7000;while(Date.now()<deadline){const value=await read();if(value)return value;await new Promise(r=>setTimeout(r,15))}throw Error('Native project fixture timed out')}

test('real project bridge routes selectable Claude/Antigravity clients, native wire, permissions, reconnect and unavailable installs', {timeout:20000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'native-project-bridge-')),project=join(root,'project'),cli=join(root,'claude-fixture.mjs'),agy=join(root,'agy-fixture.mjs')
 await mkdir(project);const receipt=join(root,'claude-input.json'),agyReceipt=join(root,'agy-input.json')
 await writeFile(cli,`#!/usr/bin/env node
import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';if(process.argv.includes('--version')){console.log('2.1.301 (Claude Code)');process.exit(0)}const args=process.argv.slice(2).flatMap(a=>a.startsWith('--')&&a.includes('=')?[a.slice(0,a.indexOf('=')),a.slice(a.indexOf('=')+1)]:[a]);const get=f=>args.includes(f)?args[args.indexOf(f)+1]:undefined;const sid=get('--session-id')||get('--resume');const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const answer=()=>{send({type:'assistant',session_id:sid,message:{id:'answer',role:'assistant',content:[{type:'text',text:'CLAUDE_PROJECT_OK'}]}});send({type:'result',subtype:'success',is_error:false,session_id:sid,result:'CLAUDE_PROJECT_OK'});};createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'claude-fixture',displayName:'Fixture',supportedEffortLevels:[]}],commands:[],account:{}}}});if(m.type==='user'){writeFileSync(${JSON.stringify(receipt)},JSON.stringify(m));send({type:'system',subtype:'init',session_id:sid,cwd:process.cwd(),model:'claude-fixture'});send({type:'control_request',request_id:'fixture-permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'fixture-only-no-execution'},tool_use_id:'tool-fixture'}});}if(m.type==='control_response')answer();});`,{mode:0o700})
 await writeFile(agy,`#!/usr/bin/env node
import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';import{randomUUID}from'node:crypto';if(process.argv.includes('--version')){console.log('1.4.4');process.exit(0)}const args=process.argv.slice(2);const id=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:randomUUID();const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);writeFileSync(${JSON.stringify(agyReceipt)},JSON.stringify({m,args}));send({event:'init',conversation_id:id,init:{cwd:process.cwd()}});send({event:'step_update',step_update:{step_type:'agent_response',state:'DONE',text_delta:'AGY_PROJECT_OK'}});send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'AGY_PROJECT_OK'}});});`,{mode:0o700})
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r))
 const origin='http://127.0.0.1:5173',base='http://127.0.0.1:'+port,sockets=[]
 const child=spawn(process.execPath,[fileURLToPath(new URL('./project-bridge.mjs',import.meta.url))],{cwd:root,env:{...process.env,HOME:root,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),CLAUDE_CONFIG_DIR:join(root,'claude'),JARVIS_BRIDGE_PORT:String(port),JARVIS_PROJECT_REGISTRY:join(root,'projects.json'),JARVIS_CLAUDE_CLI:cli,JARVIS_ANTIGRAVITY_CLI:agy,JARVIS_AUTO_SCREEN:'0',JARVIS_RECORDING:'0',JARVIS_HISTORY_DIR:join(root,'history'),JARVIS_ALLOWED_ORIGINS:origin,OPENCODE_URL:'http://127.0.0.1:1'},stdio:['ignore','ignore','ignore']})
 t.after(async()=>{for(const s of sockets)s.terminate();if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended}await rm(root,{recursive:true,force:true})})
 await until(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}})
 const applications=await(await fetch(base+'/projects')).json();assert.ok(applications.applications.every(app=>app.available));assert.deepEqual(applications.applications.map(a=>a.id).sort(),['antigravity','claude'])
 const open=async application=>{const response=await fetch(base+'/projects',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({directory:project,application,password:'never-forward-this'})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result.project}
 const connect=async(p,session='new')=>{const ws=new WebSocket(base.replace('http:','ws:')+'/?'+new URLSearchParams({project:p.id,session}),{origin});sockets.push(ws);const frames=[];ws.on('message',raw=>frames.push(JSON.parse(raw)));await once(ws,'open');await until(()=>frames.find(f=>f.type==='ready'||f.type==='session_error'));assert.equal(frames.some(f=>f.type==='session_error'),false);return{ws,frames,send:frame=>ws.send(JSON.stringify(frame))}}
 const claude=await open('claude'),ag=await open('antigravity');assert.notEqual(claude.id,ag.id)
 const models=await(await fetch(base+'/models?'+new URLSearchParams({project:claude.id}))).json();assert.ok(models.models.some(m=>m.id==='claude-fixture'))
 const c=await connect(claude);c.send({type:'ask',id:'one',text:'Exact native project question',audioMode:'transcript'})
 await until(()=>c.frames.some(f=>f.type==='permissions'&&f.requests.length));const permission=c.frames.find(f=>f.type==='permissions'&&f.requests.length).requests[0]
 assert.equal(c.frames.some(f=>f.type==='done'),false);c.send({type:'permission',id:permission.id,reply:'reject'});await until(()=>c.frames.some(f=>f.type==='done'))
 assert.equal(c.frames.find(f=>f.type==='done').text,'CLAUDE_PROJECT_OK');assert.equal(JSON.parse(await readFile(receipt,'utf8')).message.content[0].text,'Exact native project question')
 const a=await connect(ag),id=a.frames.find(f=>f.type==='ready').conversation.id;assert.equal(a.frames.find(f=>f.type==='ready').capabilities.screenOptIn,false)
 a.send({type:'ask',id:'no-image',text:'Never send this without an image',screen:true,audioMode:'transcript'});await until(()=>a.frames.some(f=>f.type==='error'&&f.ask==='no-image'));await assert.rejects(readFile(agyReceipt))
 a.send({type:'ask',id:'text',text:'AGY exact question',audioMode:'transcript'});await until(()=>a.frames.some(f=>f.type==='done'&&f.ask==='text'))
 assert.equal(a.frames.find(f=>f.type==='done').text,'AGY_PROJECT_OK');a.ws.close();await once(a.ws,'close')
 const resumed=await connect(ag,id);assert.equal(resumed.frames.find(f=>f.type==='ready').conversation.turns.length,2)
 resumed.send({type:'ask',id:'next',text:'Continue',audioMode:'transcript'});await until(()=>resumed.frames.some(f=>f.type==='done'))
 assert.ok(JSON.parse(await readFile(agyReceipt,'utf8')).args.includes('--conversation'))
 await rm(agy);const fail=await fetch(base+'/projects',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({directory:project,application:'antigravity'})});assert.equal(fail.status,400)
 assert.doesNotMatch(await readFile(join(root,'projects.json'),'utf8'),/never-forward-this/)
})
