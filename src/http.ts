/**
 * The updater over HTTP, for an app whose page talks to a local `Bun.serve`.
 *
 *   GET  <check>           -> JSON UpdateInfo. `?force=1` asks the feed again.
 *   POST <install>         -> text/event-stream of InstallEvent, ending in a `done` event.
 *
 * The app owns the paths, the CORS/origin checks and anything else its server does to every
 * route; this only turns requests into updater calls and answers into responses. The SSE
 * framing is written out here rather than imported, so the folder stays self-contained.
 */
import type { InstallEvent, Updater } from './updater'

const encoder = new TextEncoder()
const frame = (event: InstallEvent): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
const PING = encoder.encode(': ping\n\n')

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const

export interface UpdateHttp {
  check(req: Request): Promise<Response>
  install(req: Request): Response
}

export function updateHttp(updater: Updater, opts: { heartbeatMs?: number } = {}): UpdateHttp {
  const heartbeatMs = opts.heartbeatMs ?? 15_000
  return {
    async check(req) {
      const force = new URL(req.url).searchParams.get('force') === '1'
      try {
        return Response.json(await updater.check({ force, signal: req.signal }))
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 })
      }
    },
    install(req) {
      const abort = new AbortController()
      req.signal.addEventListener('abort', () => abort.abort(), { once: true })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false
          const send = (chunk: Uint8Array) => {
            if (closed) return
            try {
              controller.enqueue(chunk)
            } catch {
              closed = true
            }
          }
          const timer = setInterval(() => send(PING), heartbeatMs)
          ;(timer as unknown as { unref?: () => void }).unref?.()
          const finish = () => {
            clearInterval(timer)
            if (closed) return
            closed = true
            try {
              controller.close()
            } catch {
              // Already closed by the client.
            }
          }
          // Progress arrives in bursts; only the newest of each kind needs to reach the wire.
          // A change of step always does, however close to the previous frame: the first
          // `unpacking` used to be dropped for landing within the window after `verifying`.
          let lastProgress = 0
          let lastType: InstallEvent['type'] | null = null
          const onEvent = (event: InstallEvent) => {
            if ((event.type === 'downloading' || event.type === 'unpacking') && event.type === lastType) {
              const now = Date.now()
              const last = event.type === 'downloading' ? event.received === event.total : event.done === event.total
              if (now - lastProgress < 100 && !last) return
              lastProgress = now
            }
            lastType = event.type
            send(frame(event))
          }
          updater.install({ onEvent, signal: abort.signal }).then(finish, finish)
        },
        cancel() {
          abort.abort()
        },
      })
      return new Response(stream, { headers: SSE_HEADERS })
    },
  }
}
