import { Whisper, WhisperError } from './whisper.mjs'

/** Invoke only after the project bridge's Host/Origin/CORS checks. */
export function whisperRoutes(whisper = new Whisper()) {
  const handle = async (req, res, url, json) => {
    if (!['/whisper', '/whisper/transcribe'].includes(url.pathname)) return false
    if (req.method === 'GET' && url.pathname === '/whisper') { json(200, await whisper.availability()); return true }
    if (req.method !== 'POST' || url.pathname !== '/whisper/transcribe') { json(405, { error: 'Método no permitido.' }); return true }
    const controller = new AbortController()
    const aborted = () => controller.abort(new DOMException('Solicitud cancelada.', 'AbortError'))
    const closed = () => { if (!res.writableFinished) aborted() }
    req.once('aborted', aborted); res.once('close', closed)
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new WhisperError(415, 'Envía audio sin compresión HTTP adicional.')
      if ([...url.searchParams.keys()].some(key => key !== 'language') || url.searchParams.getAll('language').length > 1) throw new WhisperError(400, 'Solo se admite el parámetro language; no rutas ni URLs.')
      const result = await whisper.transcribe(req, { contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'], language: url.searchParams.get('language') ?? undefined, signal: controller.signal })
      if (!controller.signal.aborted) json(200, result)
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) json(error instanceof WhisperError ? error.status : 500,
        { error: error instanceof WhisperError ? error.message : 'No se pudo completar la transcripción local.' })
    } finally {
      req.off('aborted', aborted); res.off('close', closed)
      // Rejected uploads must not keep buffering a body or a keep-alive connection.
      if (!req.complete && !res.destroyed) { res.shouldKeepAlive = false; res.once('finish', () => req.destroy()) }
    }
    return true
  }
  return { handle, close: () => whisper.close() }
}
