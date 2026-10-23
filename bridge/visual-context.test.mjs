import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearPreviousMedia } from './visual-context.mjs'

const part = (id, type, extra = {}, messageID = 'msg_user') => ({ id, sessionID: 'ses_ours', messageID, type, ...extra })
function mockApi(parts) {
  const messages = [{ info: { id: 'msg_user', role: 'user' }, parts: structuredClone(parts) }]
  const calls = []
  const api = async (method, path, body) => {
    calls.push({ method, path, body })
    if (method === 'GET') return structuredClone(messages)
    const id = decodeURIComponent(path.split('/').at(-1))
    const index = messages[0].parts.findIndex((p) => p.id === id)
    assert.ok(index >= 0)
    if (method === 'DELETE') { messages[0].parts.splice(index, 1); return true }
    if (method === 'PATCH') { messages[0].parts[index] = structuredClone(body); return body }
    throw new Error('Unexpected request')
  }
  return { api, messages, calls }
}

test('previous screenshots are removed; spoken text and document attachments remain', async () => {
  const text = part('prt_text', 'text', { text: 'Remember the word FARO' })
  const pdf = part('prt_pdf', 'file', { mime: 'application/pdf', url: 'file:///document.pdf' })
  const fixture = mockApi([text, pdf,
    part('prt_img', 'file', { mime: 'image/jpeg', url: 'data:image/jpeg;base64,old' }),
    part('prt_ref', 'text', { synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"/tmp/jarvis-session-screen-ABC/image.jpg"}' }),
  ])
  assert.deepEqual(await clearPreviousMedia(fixture.api, 'ses_ours'), { files: 1, toolAttachments: 0, screenshotReferences: 1 })
  assert.deepEqual(fixture.messages[0].parts, [text, pdf])
  assert.ok(fixture.calls.every((c) => c.path.startsWith('/session/ses_ours/')))
})

test('one fresh image per turn never accumulates across successive questions', async () => {
  const fixture = mockApi([part('prt_text', 'text', { text: 'Keep our conversation' })])
  for (let turn = 0; turn < 12; turn++) {
    await clearPreviousMedia(fixture.api, 'ses_ours')
    fixture.messages[0].parts.push(part(`prt_image${turn}`, 'file', { mime: 'image/png', url: `data:image/png;base64,${turn}` }))
    assert.equal(fixture.messages[0].parts.filter((p) => p.type === 'file').length, 1)
    assert.equal(fixture.messages[0].parts[0].text, 'Keep our conversation')
  }
})

test('past MCP evidence is evicted without losing tool text, input or metadata', async () => {
  const image = part('prt_img', 'file', { mime: 'image/jpeg', url: 'data:image/jpeg;base64,old' })
  const audio = part('prt_audio', 'file', { mime: 'audio/wav', url: 'data:audio/wav;base64,old' })
  const pdf = part('prt_pdf', 'file', { mime: 'application/pdf', url: 'file:///document.pdf' })
  const tool = part('prt_tool', 'tool', { callID: 'call1', tool: 'jarvis_desktop_history_review', state: {
    status: 'completed', input: { seconds_ago: 30 }, output: 'Words from the audio and timestamps',
    title: 'History', metadata: { example: true }, time: { start: 1, end: 2 }, attachments: [image, audio, pdf],
  } })
  const fixture = mockApi([tool])
  assert.equal((await clearPreviousMedia(fixture.api, 'ses_ours')).toolAttachments, 2)
  assert.deepEqual(fixture.messages[0].parts[0], { ...tool, state: { ...tool.state, attachments: [pdf] } })
})

test('no media means no writes or archive reads; ordinary conversation remains identical', async () => {
  const text = part('prt_text', 'text', { text: 'A normal question' })
  const reference = part('prt_ref', 'text', { synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"/project/source.ts"}' })
  const fixture = mockApi([text, reference])
  await clearPreviousMedia(fixture.api, 'ses_ours')
  assert.deepEqual(fixture.messages[0].parts, [text, reference])
  assert.deepEqual(fixture.calls.map((c) => c.method), ['GET'])
})

test('foreign session ownership is rejected, never mutated', async () => {
  const fixture = mockApi([{ ...part('prt_img', 'file', { mime: 'image/png' }), sessionID: 'ses_foreign' }])
  await assert.rejects(clearPreviousMedia(fixture.api, 'ses_ours'), /ownership/)
  assert.deepEqual(fixture.calls.map((c) => c.method), ['GET'])
})

test('failed removal is surfaced; it cannot silently retain old images for the next request', async () => {
  const fixture = mockApi([part('prt_img', 'file', { mime: 'image/png' })])
  await assert.rejects(clearPreviousMedia(async (...args) => args[0] === 'DELETE' ? false : fixture.api(...args), 'ses_ours'), /did not remove/)
})

test('cancelled cleanup stops before any API request', async () => {
  const fixture = mockApi([])
  const controller = new AbortController(); controller.abort()
  await assert.rejects(clearPreviousMedia(fixture.api, 'ses_ours', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(fixture.calls.length, 0)
})

test('interruption during cleanup prevents deleting subsequent parts', async () => {
  const fixture = mockApi([part('prt_img', 'file', { mime: 'image/png' }), part('prt_next', 'file', { mime: 'image/png' })])
  const controller = new AbortController()
  await assert.rejects(clearPreviousMedia(async (...args) => {
    const result = await fixture.api(...args)
    if (args[0] === 'DELETE') controller.abort()
    return result
  }, 'ses_ours', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(fixture.messages[0].parts.length, 1)
})
