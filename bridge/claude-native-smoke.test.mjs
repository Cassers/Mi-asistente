import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { ClaudeDriver } from './claude-driver.mjs'

// Opt in: installed Claude Code, isolated HOME/config, synthetic PNG, loopback
// Anthropic Messages fixture only. No real account/auth, microphone or screen.
test('installed Claude Code preserves native AGENTS, exact text/image and resumes native session using only localhost',{
  skip:process.env.JARVIS_CLAUDE_NATIVE_SMOKE!=='1',timeout:45000,
},async t=>{
  const root=await mkdtemp(join(tmpdir(),'claude-native-smoke-')),home=join(root,'home'),directory=join(root,'project'),config=join(root,'config')
  await Promise.all([mkdir(home),mkdir(directory),mkdir(config)])
  await writeFile(join(directory,'AGENTS.md'),'# Fixture\nCLAUDE_NATIVE_CONTEXT_INCLUDED: preserve this project context.\n')
  const requests=[];let failure
  const server=http.createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}')
      assert.equal(req.headers['x-api-key'],'fixture-only')
      if(req.url.includes('count_tokens')){res.setHeader('content-type','application/json');res.end(JSON.stringify({input_tokens:100}));return}
      assert.ok(req.url.startsWith('/v1/messages'));requests.push(body)
      const send=data=>res.write('event: '+data.type+'\ndata: '+JSON.stringify(data)+'\n\n')
      const text='LOCAL_CLAUDE_NATIVE_OK'
      res.writeHead(200,{'content-type':'text/event-stream'})
      send({type:'message_start',message:{id:'msg_fixture_'+requests.length,type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}})
      send({type:'content_block_start',index:0,content_block:{type:'text',text:''}})
      send({type:'content_block_delta',index:0,delta:{type:'text_delta',text}})
      send({type:'content_block_stop',index:0})
      send({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}})
      send({type:'message_stop'});res.end()
    }catch(error){failure=error;res.writeHead(500);res.end('Local fixture failed')}
  })
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const chunk=(type,data)=>{const content=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of content){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc>>>1^(crc&1?0xedb88320:0)}const len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([len,content,sum])}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))])
  const driver=new ClaudeDriver({command:process.env.JARVIS_CLAUDE_CLI||'claude',env:{PATH:process.env.PATH,HOME:home,CLAUDE_CONFIG_DIR:config,XDG_CONFIG_HOME:config,XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),
    ANTHROPIC_BASE_URL:'http://127.0.0.1:'+server.address().port,ANTHROPIC_API_KEY:'fixture-only',CLAUDE_CODE_OAUTH_TOKEN:'',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_USE_BEDROCK:'0',CLAUDE_CODE_USE_VERTEX:'0',CLAUDE_CODE_USE_FOUNDRY:'0',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'}})
  const id=randomUUID(),controller=new AbortController(),text=[],sessions=[]
  const options={directory,id,signal:controller.signal,model:'claude-sonnet-4-6',onSession:id=>sessions.push(id),onText:delta=>text.push(delta),onTool(){},permission:async()=>({behavior:'deny',message:'Fixture denies all prompted tools.'})}
  const question='Exact native image question, fixture 7294.'
  await driver.run({...options,resume:false,content:[{type:'text',text:question},{type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}}]})
  if(failure)throw failure
  assert.equal(text.join(''),'LOCAL_CLAUDE_NATIVE_OK');assert.deepEqual(sessions,[id])
  const first=requests.find(r=>r.messages?.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image')))
  assert.ok(first,'actual native Messages request must have an image block')
  const content=first.messages.flatMap(m=>Array.isArray(m.content)?m.content:[])
  assert.ok(content.some(p=>p.type==='text'&&p.text.includes(question)))
  assert.deepEqual(Buffer.from(content.find(p=>p.type==='image').source.data,'base64'),png)
  assert.match(JSON.stringify(first),/CLAUDE_NATIVE_CONTEXT_INCLUDED/)
  const before=requests.length
  await driver.run({...options,resume:true,content:[{type:'text',text:'Resume native fixture, code 9372.'}]})
  if(failure)throw failure
  assert.ok(requests.length>before);assert.match(JSON.stringify(requests.at(-1)),/7294/);assert.deepEqual(sessions,[id,id])
})
