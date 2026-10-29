import { createServer, request as httpRequest, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { handleAudioRequest, type AudioRouteContext } from '../src/audio-route.ts'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let directory = ''
let address = ''
let server: Server
const bytes = Buffer.alloc(2 * 1024 * 1024, 37)

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'audio-http-'))
  await writeFile(join(directory, 'sample.wav'), bytes)
  const context = {
    sessions: { get: () => undefined },
    get: (name: string) => name === 'sessionPersistence' ? { stat: async (id: string) => id === 'saved' ? { header: { cwd: directory } } : undefined } : undefined,
    connection: { requestRejection: (request: { headers: { cookie?: string } }) => request.headers.cookie === 'test=authorized' ? undefined : 'unauthorized' },
  } as AudioRouteContext
  server = createServer((request, response) => { void handleAudioRequest(request, response, context) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const target = server.address()
  if (target === null || typeof target === 'string') throw new Error('Missing HTTP port')
  address = `http://127.0.0.1:${target.port}/audio-preview/`
})

afterAll(async () => {
  server?.closeAllConnections()
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

const request = (path: string, init: RequestInit = {}) => fetch(address + path, { ...init, headers: { cookie: 'test=authorized', ...init.headers } })

it('serves a cold saved session, full streaming body, ranges and HEAD over real HTTP', async () => {
  const query = '?sessionId=saved&path=sample.wav'
  const meta = await request('meta' + query)
  expect(meta.status).toBe(200)
  expect((await meta.json()).value.size).toBe(bytes.length)
  const full = await request('media' + query)
  expect(full.status).toBe(200)
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes)
  const partial = await request('media' + query, { headers: { range: 'bytes=4-9' } })
  expect(partial.status).toBe(206)
  expect(partial.headers.get('content-range')).toBe(`bytes 4-9/${bytes.length}`)
  expect(Buffer.from(await partial.arrayBuffer())).toEqual(bytes.subarray(4, 10))
  const head = await request('media' + query, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe(String(bytes.length))
  expect(await head.text()).toBe('')
  const invalid = await request('media' + query, { headers: { range: `bytes=${bytes.length}-` } })
  expect(invalid.status).toBe(416)
  await invalid.arrayBuffer()
})

it('delegates authentication and rejects unknown saved sessions', async () => {
  const denied = await fetch(address + 'meta?sessionId=saved&path=sample.wav')
  expect(denied.status).toBe(403)
  await denied.arrayBuffer()
  const missing = await request('meta?sessionId=unknown&path=sample.wav')
  expect(missing.status).toBe(404)
  expect((await missing.json()).error.code).toBe('session-not-found')
})

it('does not open a file stream when the client disconnects during the asynchronous file lookup', async () => {
  const lookupEntered = deferred<void>()
  const finishLookup = deferred<void>()
  const responseClosed = deferred<void>()
  const routeFinished = deferred<void>()
  const context = {
    sessions: { get: () => undefined },
    connection: { requestRejection: () => undefined },
    get: (name: string) => name === 'sessionPersistence' ? {
      stat: async () => {
        lookupEntered.resolve()
        await finishLookup.promise
        return { header: { cwd: directory } }
      },
    } : undefined,
  } as AudioRouteContext
  const delayedServer = createServer((incoming, response) => {
    response.once('close', () => responseClosed.resolve())
    void handleAudioRequest(incoming, response, context).finally(() => routeFinished.resolve())
  })
  const streamCallsBefore = vi.mocked(createReadStream).mock.calls.length
  try {
    await new Promise<void>((resolve, reject) => { delayedServer.once('error', reject); delayedServer.listen(0, '127.0.0.1', resolve) })
    const target = delayedServer.address()
    if (target === null || typeof target === 'string') throw new Error('Missing HTTP port')
    const client = httpRequest(`http://127.0.0.1:${target.port}/audio-preview/media?sessionId=saved&path=sample.wav`)
    const clientClosed = new Promise<void>(resolve => { client.once('error', () => resolve()) })
    client.end()
    await lookupEntered.promise
    client.destroy()
    // The server must observe the disconnect before the delayed lookup resolves.
    await Promise.all([clientClosed, responseClosed.promise])
    finishLookup.resolve()
    await routeFinished.promise
    expect(createReadStream).toHaveBeenCalledTimes(streamCallsBefore)
  } finally {
    finishLookup.resolve()
    // Also close any stream created by a regression so the failing test is isolated.
    for (const result of vi.mocked(createReadStream).mock.results.slice(streamCallsBefore)) {
      if (result.type === 'return') result.value.destroy()
    }
    delayedServer.closeAllConnections()
    if (delayedServer.listening) await new Promise<void>(resolve => delayedServer.close(() => resolve()))
  }
})
