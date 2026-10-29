import { createTimings } from '../shared/timings.mjs'

/** Per-view adapter; runtime owns native turns and requests beyond socket lifetime. */
export async function attachCodexClient(socket, { project, manager, recorder, timingStore, queued = [], buffer, query = new URLSearchParams() }) {
  const application = project.application || 'codex'
  const name = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }[application]
  let gone = socket.readyState !== (socket.OPEN ?? 1), runtime, state, unsubscribe
  const send = frame => { if (!gone && socket.readyState === (socket.OPEN ?? 1)) socket.send(JSON.stringify(frame)) }
  const timing = timingStore?.recorder ? timingStore.recorder(event => send({ type: 'timing', event })) : createTimings({ source: 'bridge', emit: event => send({ type: 'timing', event }) })
  const connecting = timing.start('connection.ready')
  const detach = () => { if (gone) return; gone = true; unsubscribe?.(); socket.off('message', onMessage); if (buffer) socket.off('message', buffer) }
  socket.once('close', detach)
  socket.once('error', detach)
  async function onMessage(raw) {
    if (gone) return
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return
    try {
      if (msg.type === 'ask') {
        if (msg.audio || msg.preserveOnly || msg.audioMode && msg.audioMode !== 'transcript') throw new Error(name + ' usa solo dictado del navegador. El audio directo está deshabilitado; no se envió el clip.')
        await runtime.ask(state, { ...msg, audioMode: 'transcript' }, timing)
      }
      else if (msg.type === 'interrupt') {
        await runtime.interrupt(state, timing, msg.reason)
        send({ type: 'interrupted', requestID: msg.requestID, status: 'ok' })
      } else if (msg.type === 'session_list') send({ type: 'session_list', entries: await runtime.list() })
      else if (msg.type === 'session_delete' && msg.id === state.id) {
        await runtime.archive(state)
        send({ type: 'session_deleted', archived: true, recoverable: true, application: 'codex' }); socket.close()
      } else if (msg.type === 'permission') await state.policy.respond(msg.id, msg.reply)
      else if (msg.type === 'user_input') runtime.answerInput(state, msg.id, msg.answers)
      else if (msg.type === 'permission_mode') {
        const accepted = state.policy.setMode(msg.mode, msg.confirmed)
        send({ type: 'permission_mode', requestID: msg.requestID, policy: { ...state.policy.snapshot(), ...(!accepted ? { error: 'Modo inválido o sin confirmación.' } : {}) } })
      } else if (msg.type === 'recording' && typeof msg.active === 'boolean' && recorder) {
        await recorder.setActive(msg.active, { microphone: msg.microphone !== false }); send({ type: 'recording', requestID: msg.requestID, recording: recorder.snapshot() })
      }
    } catch (error) {
      // Runtime errors contain adapter-owned text; native RPC rejects never expose raw stderr/config.
      send({ type: msg.type === 'session_list' || msg.type === 'session_delete' ? 'session_error' : msg.type === 'ask' ? 'error' : 'status_error', requestID: msg.requestID, ask: msg.id, message: error.message })
      if (msg.type === 'interrupt') send({ type: 'interrupted', requestID: msg.requestID, status: 'error' })
    }
  }
  try {
    runtime = await manager.runtime(project.directory)
    if (gone) return
    const choice = query.get('session') || undefined
    state = await runtime.open(choice)
    if (gone) return
    const staged = []
    let ready = false
    unsubscribe = runtime.subscribe(state, frame => { if (!ready) staged.push(frame); else send(frame) })
    const entries = await runtime.list()
    if (gone) { unsubscribe(); return }
    send({ type: 'ready', servers: [application, project.name], application, native: true,
      conversation: { id: state.id, title: state.title, resumed: !!choice && choice !== 'new', entries, turns: runtime.transcript(state), busy: runtime.snapshot(state).busy },
      capabilities: { screenOptIn: true, recordingControlVersion: 1, archive: true, recoverableArchive: true, directAudio: false, transcriptOnly: true, userInput: true, ...runtime.capabilities } })
    ready = true
    for (const frame of staged) send(frame)
    send(runtime.snapshot(state)); runtime.publishPermissions(state)
    send({ type: 'permission_mode', policy: state.policy.snapshot() })
    if (recorder) send({ type: 'recording', recording: recorder.snapshot() })
    connecting.end()
    if (buffer) socket.off('message', buffer)
    socket.on('message', onMessage)
    // Drain once, in arrival order. Control messages must remain able to stop preparation.
    for (const raw of queued.splice(0)) void onMessage(raw)
    return { runtime, state, detach }
  } catch (error) {
    connecting.end('error'); unsubscribe?.()
    send({ type: 'session_error', message: error.message })
    if (buffer) socket.off('message', buffer)
    socket.close()
  }
}
