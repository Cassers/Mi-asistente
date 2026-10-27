/**
 * A single shared microphone stream plus an analyser, so the reactor can pulse
 * with the user's voice. Opening the mic more than once causes Chrome to drop
 * the earlier stream, so everything that needs audio goes through here.
 */

let stream: MediaStream | null = null
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null
let blocked = false
let generation = 0
let opening: Promise<MediaStream> | null = null

/** Release this application's capture, without muting other apps or the OS. */
export function setMicBlocked(value: boolean): void {
  blocked = value
  if (!value) return
  generation++
  opening = null
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  analyser?.disconnect()
  analyser = null
  buf = null
  if (ctx) void ctx.close().catch(() => {})
  ctx = null
}

export async function getMic(): Promise<MediaStream> {
  if (blocked) throw new Error('Micrófono apagado')
  if (stream) return stream
  if (opening) return opening
  const mine = generation
  const request = navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  }).then(value => {
    if (blocked || mine !== generation) {
      value.getTracks().forEach(track => track.stop())
      throw new Error('Micrófono apagado')
    }
    stream = value
    return value
  })
  opening = request
  try { return await request }
  finally { if (opening === request) opening = null }
}

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  const s = await getMic()
  if (blocked || s !== stream) return
  ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(s)
  analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  analyser.smoothingTimeConstant = 0.75
  src.connect(analyser)
  buf = new Uint8Array(analyser.frequencyBinCount)
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while JARVIS talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
