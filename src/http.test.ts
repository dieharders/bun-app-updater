/** The two routes: JSON for a check, SSE frames for an install, read back as the event union. */
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { updateHttp } from './http'
import { type InstallEvent, createUpdater } from './updater'

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-http-'))
  fs.writeFileSync(path.join(dir, 'app.exe'), 'old')
  let checks = 0
  const updater = createUpdater({
    appName: 'App',
    version: '1.0.0',
    source: { latest: async () => (checks++, { version: '1.1.0', url: 'https://x', assets: [] }) },
    assetName: (_v, t) => `App-${t}-setup.exe`,
    platform: 'win32',
    arch: 'x64',
    execPath: path.join(dir, 'app.exe').replace(/\\/g, '/'),
    installer: { args: () => [] },
    downloadDir: dir,
    log: () => {},
  })
  return { http: updateHttp(updater), checks: () => checks }
}

const readEvents = async (res: Response): Promise<InstallEvent[]> => {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as InstallEvent)
}

describe('updateHttp', () => {
  test('check answers JSON and honours ?force=1', async () => {
    const { http, checks } = make()
    const res = await http.check(new Request('http://127.0.0.1/api/update'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { current: string; latest: unknown }
    expect(body.current).toBe('1.0.0')
    expect(body.latest).toBeNull() // no download for this target
    await http.check(new Request('http://127.0.0.1/api/update?force=1'))
    expect(checks()).toBe(1) // the force floor
  })
  test('install streams events and ends with done', async () => {
    const { http } = make()
    const res = http.install(new Request('http://127.0.0.1/api/update/install', { method: 'POST' }))
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const events = await readEvents(res)
    expect(events[0]).toEqual({ type: 'checking' })
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false, code: 'no_update' })
  })
})
