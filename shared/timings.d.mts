export type TimingStatus = 'ok' | 'error' | 'cancelled' | 'fallback' | 'timeout' | 'detached'
export type TimingEvent = { traceId: string; id: string; name: string; source: 'browser' | 'bridge'; phase: 'start' | 'end'; status: TimingStatus; at: number; durationMs: number }
export type TimingSpan = { traceId: string; id: string; end(status?: TimingStatus): void }
export const timingLabels: Readonly<Record<string, string>>
export const statuses: string[]
export function newTimingID(): string
export function validTiming(value: unknown, source?: string): TimingEvent | null
export function createTimings(options: { source: string; emit?: (event: TimingEvent) => void; now?: () => number; wall?: () => number; uuid?: () => string }): { start(name: string, traceId?: string): TimingSpan }
export function summarizeTimings(events: TimingEvent[]): { name: string; source: string; count: number; other: number; p50: number | null; p95: number | null; max: number | null }[]
