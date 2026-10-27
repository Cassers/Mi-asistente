import { useSyncExternalStore } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { createTimings, validTiming, timingLabels, summarizeTimings, newTimingID } from '../../shared/timings.mjs'
import type { TimingEvent, TimingStatus } from '../../shared/timings.mjs'
export { timingLabels, summarizeTimings }
export type { TimingEvent, TimingStatus }
const LIMIT = 2000
let rows: TimingEvent[] = []
let queue: TimingEvent[] = []
let dropped = 0
let serverDropped = 0
let saving = false
let timer: ReturnType<typeof setTimeout> | undefined
let noticeTimer: ReturnType<typeof setTimeout> | undefined
let persistence = 'local'
let revision = 0
let snapshot = { rows, dropped, persistence, revision }
const listeners = new Set<() => void>()
const notify = () => {
  if (noticeTimer) return
  noticeTimer = setTimeout(() => {
    noticeTimer = undefined
    snapshot = { rows, dropped: dropped + serverDropped, persistence, revision: ++revision }
    listeners.forEach(fn => fn())
  }, 150)
}
export const newTrace = (): string => newTimingID()
export function receiveTiming(value: unknown) {
  const event = validTiming(value)
  if (!event) return
  const index = rows.findIndex(e => e.id === event.id && e.source === event.source)
  if (index >= 0) {
    if (rows[index].phase === 'end') return
    rows = rows.map((row, at) => at === index ? event : row)
  } else rows = [...rows, event].slice(-LIMIT)
  notify()
}
async function flush() {
  timer = undefined
  if (saving || !queue.length) return
  saving = true
  const batch = queue.splice(0, 24)
  try {
    const response = await fetch(`${BRIDGE_HTTP_URL}/timings`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(2500) })
    if (!response.ok) throw new Error('unavailable')
    persistence = 'saved'
  } catch { dropped += batch.length; persistence = 'unavailable' }
  finally {
    saving = false; notify()
    if (queue.length && !timer) timer = setTimeout(() => { void flush() }, 1000)
  }
}
const recorder = createTimings({ source: 'browser', emit: event => {
  receiveTiming(event)
  if (event.phase !== 'end') return
  if (queue.length >= 240) { queue.shift(); dropped++ }
  queue.push(event)
  if (!timer && !saving) timer = setTimeout(() => { void flush() }, 1000)
} })
function observedDuration(name: string, start: number, durationMs: number) {
  const event: TimingEvent = { traceId: newTrace(), id: newTrace(), name, source: 'browser', phase: 'end', status: 'ok',
    at: performance.timeOrigin + start, durationMs }
  receiveTiming(event)
  if (queue.length >= 240) { queue.shift(); dropped++ }
  queue.push(event)
  if (!timer && !saving) timer = setTimeout(() => { void flush() }, 1000)
}
export const startTiming = (name: string, traceId?: string) => recorder.start(name, traceId)
export function recordTimingDuration(name: string, durationMs: number, traceId: string, status: TimingStatus = 'ok') {
  try {
    const event = validTiming({ name, durationMs, traceId, id: newTrace(), status, phase: 'end', source: 'browser', at: Date.now() - durationMs }, 'browser')
    if (!event) return
    receiveTiming(event)
    if (queue.length >= 240) { queue.shift(); dropped++ }
    queue.push(event)
    if (!timer && !saving) timer = setTimeout(() => { void flush() }, 1000)
  } catch { /* Diagnostic-only observation must not stop voice dispatch. */ }
}
export function markTiming(name: string, traceId: string) { startTiming(name, traceId).end() }
export function subscribeTimings(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } }
export const timingsSnapshot = () => snapshot
export const useTimings = () => useSyncExternalStore(subscribeTimings, timingsSnapshot, timingsSnapshot)
export async function refreshTimings() {
  try {
    const response = await fetch(`${BRIDGE_HTTP_URL}/timings`, { signal: AbortSignal.timeout(3000), cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    if (Array.isArray(data.events)) for (const event of data.events) receiveTiming(event)
    if (Number.isFinite(data.dropped)) serverDropped = Math.max(0, data.dropped)
    persistence = data.persistence === 'error' ? 'unavailable' : 'saved'; notify()
  } catch { persistence = 'unavailable'; notify() }
}
/** Read-only HTTP observation: URLs and request/response content never enter telemetry. */
export async function timedFetch(name: string, input: RequestInfo | URL, init?: RequestInit) {
  const span = startTiming(name)
  try {
    const headers = new Headers(init?.headers)
    headers.set('x-timing-trace', span.traceId)
    const response = await fetch(input, { ...init, headers }); span.end(response.ok ? 'ok' : 'error'); return response
  }
  catch (error) { span.end(error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'error'); throw error }
}
let observing = false
export function observeApplication() {
  if (observing || typeof window === 'undefined') return () => {}
  observing = true
  let stopped = false
  const started = startTiming('app.ready')
  let readyFrame = requestAnimationFrame(() => { readyFrame = requestAnimationFrame(() => { if (!stopped) started.end() }) })
  const navigation = () => {
    if (stopped) return
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (!nav) return
    if (nav.domContentLoadedEventEnd > 0) observedDuration('app.dom', 0, nav.domContentLoadedEventEnd)
    if (nav.loadEventEnd > 0) observedDuration('app.load', 0, nav.loadEventEnd)
  }
  const onLoad = () => { setTimeout(navigation, 0) }
  if (document.readyState === 'complete') navigation()
  else window.addEventListener('load', onLoad, { once: true })
  let lastFrame = 0, frame = 0
  const onVisibility = () => { lastFrame = 0 }
  document.addEventListener('visibilitychange', onVisibility)
  const onFrame = (time: number) => {
    if (stopped) return
    if (document.visibilityState === 'visible') {
      if (lastFrame && time - lastFrame > 120) observedDuration('app.frame_gap', lastFrame, time - lastFrame)
      lastFrame = time
    } else lastFrame = 0
    frame = requestAnimationFrame(onFrame)
  }
  frame = requestAnimationFrame(onFrame)
  let observer: PerformanceObserver | undefined
  try {
    observer = new PerformanceObserver(list => {
      if (document.visibilityState !== 'visible') return
      for (const entry of list.getEntries()) {
        observedDuration('app.long_task', entry.startTime, entry.duration)
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch { /* Unsupported observers are not fabricated zero-duration samples. */ }
  return () => {
    stopped = true; started.end('detached'); cancelAnimationFrame(frame); cancelAnimationFrame(readyFrame)
    window.removeEventListener('load', onLoad); document.removeEventListener('visibilitychange', onVisibility)
    observer?.disconnect(); observing = false
  }
}
