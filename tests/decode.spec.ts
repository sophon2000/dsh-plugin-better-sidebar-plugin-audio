import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeAudio, fetchBytes, MAX_DECODED_BYTES, MAX_FETCH_BYTES } from '../src/client/decode.ts'

afterEach(() => vi.unstubAllGlobals())

describe('bounded optional audio analysis', () => {
  it('refuses an oversized advertised body before reading it', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-length': String(MAX_FETCH_BYTES + 1) } })))
    await expect(fetchBytes('/audio')).rejects.toThrow(/byte budget/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a streaming body that crosses the budget without a content length', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_FETCH_BYTES))
      controller.enqueue(new Uint8Array(1))
    }, cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(fetchBytes('/audio')).rejects.toThrow(/byte budget/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('retains exact bytes for bounded bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))))
    expect(new Uint8Array(await fetchBytes('/audio'))).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('refuses oversized decoded PCM before allocating peaks or a downmix', async () => {
    const getChannelData = vi.fn()
    const close = vi.fn(async () => {})
    const context = { decodeAudioData: async () => ({ duration: 120, length: MAX_DECODED_BYTES, numberOfChannels: 2, getChannelData }), close }
    await expect(decodeAudio(new ArrayBuffer(1), { contextFactory: () => context as unknown as BaseAudioContext })).rejects.toThrow(/analysis budget/)
    expect(getChannelData).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does no PCM analysis after a native decode completes following cancellation', async () => {
    const controller = new AbortController()
    const getChannelData = vi.fn()
    let finish!: (value: unknown) => void
    const context = { decodeAudioData: () => new Promise(resolve => { finish = resolve }), close: vi.fn(async () => {}) }
    const result = decodeAudio(new ArrayBuffer(1), { contextFactory: () => context as unknown as BaseAudioContext, signal: controller.signal })
    controller.abort()
    finish({ duration: 12, length: 4, numberOfChannels: 1, getChannelData })
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(getChannelData).not.toHaveBeenCalled()
    expect(context.close).toHaveBeenCalledOnce()
  })
})
