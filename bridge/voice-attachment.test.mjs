import { test } from 'node:test'
import assert from 'node:assert/strict'
import { voiceAttachment } from './voice-attachment.mjs'

export function wavClip(seconds = 0.25) {
  const wav = Buffer.alloc(44 + Math.floor(seconds * 16000) * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(Math.sin(i / 20) * 2000), i)
  return { mime: 'audio/wav', data: wav.toString('base64') }
}

test('voice attachment accepts bounded PCM WAV data, never an external URL or filename', () => {
  const clip = wavClip()
  assert.deepEqual(voiceAttachment(clip), { type: 'file', mime: 'audio/wav', filename: 'mi-voz.wav', url: `data:audio/wav;base64,${clip.data}` })
  for (const bad of [null, {}, { mime: 'audio/webm', data: clip.data }, { mime: 'audio/wav', data: 'file:///etc/passwd' }, { mime: 'audio/wav', data: Buffer.from('not audio').toString('base64') }, wavClip(61)]) {
    assert.throws(() => voiceAttachment(bad), /clip|WAV/)
  }
  const malformed = Buffer.from(clip.data, 'base64')
  malformed.writeUInt32LE(48000, 24)
  assert.throws(() => voiceAttachment({ mime: 'audio/wav', data: malformed.toString('base64') }), /16 kHz/)
  assert.doesNotThrow(() => voiceAttachment(wavClip(60)))
})
