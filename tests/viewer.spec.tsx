// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioSourceFacts } from '../src/client/source.ts'

/** Player double with a listener registry, shared with the module mock. */
const player = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const element = {
    duration: 12,
    currentTime: 0,
    paused: true,
    loop: false,
    playbackRate: 1,
    volume: 1,
    muted: false,
    addEventListener: (type: string, handler: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners.get(type)?.delete(handler)
    },
    removeAttribute: () => {},
    load: () => {},
  }
  return {
    element,
    emit: (type: string) => {
      for (const handler of listeners.get(type) ?? []) handler()
    },
    play: vi.fn(async () => {}),
    pause: vi.fn(() => {}),
    dispose: vi.fn(() => {}),
    ensureContext: vi.fn(() => true),
    bins: vi.fn(() => null),
    analyser: null,
    contextState: 'idle',
  }
})

vi.mock('../src/client/player.ts', () => ({
  createPlayer: () => player,
}))

const { AudioViewer } = await import('../src/client/AudioViewer.tsx')

const source: AudioSourceFacts = {
  url: '/audio-preview/media?sessionId=s1&path=%2Fmusic%2Fclip.mp3',
  path: '/music/clip.mp3',
  name: 'clip.mp3',
  size: 4096,
  mime: 'audio/mpeg',
  sessionId: 's1',
}

beforeEach(() => {
  player.element.duration = 12
  player.element.currentTime = 0
  player.element.paused = true
  // jsdom has no canvas backend; the viewer must cope with a null context.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('AudioViewer', () => {
  it('leaves keyboard events on native controls to those controls', () => {
    const pane = render(<AudioViewer data={source} />)
    act(() => player.emit('loadedmetadata'))
    player.element.currentTime = 3
    act(() => player.emit('timeupdate'))
    for (const control of [screen.getByLabelText('Volume'), screen.getByLabelText('Loop'), screen.getByRole('button', { name: 'Stop' })]) {
      for (const key of ['ArrowRight', 'Home', 'End', ' ']) {
        expect(fireEvent.keyDown(control, { key })).toBe(true)
        expect(player.element.currentTime).toBe(3)
        expect(player.play).not.toHaveBeenCalled()
      }
    }
    const root = pane.container.querySelector('[data-dsh-audio-preview="viewer"]') as HTMLElement
    expect(fireEvent.keyDown(root, { key: 'ArrowRight' })).toBe(false)
    expect(player.element.currentTime).toBe(8)
    fireEvent.keyDown(root, { key: ' ' })
    expect(player.play).toHaveBeenCalledOnce()
  })

  it('preserves zoom and pan when a parked viewer re-analyzes the same source', async () => {
    const buffer = { duration: 12, length: 4, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(4) }
    const decode = vi.fn(async () => buffer)
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    vi.stubGlobal('PointerEvent', MouseEvent)
    const pane = render(<AudioViewer data={source} visible />)
    act(() => player.emit('loadedmetadata'))
    await vi.waitFor(() => expect(pane.container.textContent).toContain('44.1 kHz'))
    const lane = pane.container.querySelector('.dsh-audio__lane') as HTMLElement
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.pointerDown(lane, { clientX: 80, altKey: true, button: 0 })
    fireEvent.pointerMove(lane, { clientX: 60, altKey: true })
    fireEvent.pointerUp(lane)
    const view = lane.getAttribute('data-view')
    expect(view).not.toBe('0.000-12.000')
    pane.rerender(<AudioViewer data={source} visible={false} />)
    pane.rerender(<AudioViewer data={source} visible />)
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(pane.container.textContent).toContain('44.1 kHz'))
    expect(lane.getAttribute('data-view')).toBe(view)
    expect(player.pause).not.toHaveBeenCalled()
    player.element.duration = 20
    decode.mockResolvedValue({ ...buffer, duration: 20 })
    pane.rerender(<AudioViewer data={{ ...source, url: '/audio-preview/media?path=new.wav' }} visible />)
    act(() => player.emit('loadedmetadata'))
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(pane.container.textContent).toContain('44.1 kHz'))
    expect(lane.getAttribute('data-view')).toBe('0.000-20.000')
  })

  it('uses the exact data duration for clips shorter than the viewport minimum', async () => {
    const samples = Float32Array.from({ length: 480 }, (_, index) => index < 240 ? 0.25 : 1)
    const buffer = { duration: 0.01, length: samples.length, numberOfChannels: 1, sampleRate: 48000, getChannelData: () => samples }
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = vi.fn(async () => buffer) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    vi.stubGlobal('PointerEvent', MouseEvent)
    player.element.duration = 0.01
    const pane = render(<AudioViewer data={source} />)
    act(() => player.emit('loadedmetadata'))
    await vi.waitFor(() => expect(pane.container.textContent).toContain('48.0 kHz'))
    const lane = pane.container.querySelector('.dsh-audio__lane') as HTMLElement
    fireEvent.pointerDown(lane, { clientX: 90, shiftKey: true, button: 0 })
    fireEvent.pointerMove(lane, { clientX: 120, shiftKey: true })
    fireEvent.pointerUp(lane)
    expect(pane.container.querySelector('.dsh-audio__hint-readout')!.textContent).toContain('Peak 0.0 dB · RMS 0.0 dB')
  })

  it('keeps selection peak and RMS tied to source time while zooming and panning', async () => {
    const samples = Float32Array.from({ length: 8000 }, (_, index) => index < 2000 ? 0.25 : 1)
    const buffer = { duration: 8, length: samples.length, numberOfChannels: 1, sampleRate: 1000, getChannelData: () => samples }
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = vi.fn(async () => buffer) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    vi.stubGlobal('PointerEvent', MouseEvent)
    player.element.duration = 8
    const pane = render(<AudioViewer data={source} />)
    act(() => player.emit('loadedmetadata'))
    await vi.waitFor(() => expect(pane.container.textContent).toContain('1.0 kHz'))
    const lane = pane.container.querySelector('.dsh-audio__lane') as HTMLElement
    fireEvent.pointerDown(lane, { clientX: 0, shiftKey: true, button: 0 })
    fireEvent.pointerMove(lane, { clientX: 30, shiftKey: true })
    fireEvent.pointerUp(lane)
    const readout = () => pane.container.querySelector('.dsh-audio__hint-readout')!.textContent!.split('Selection ')[1]
    const original = readout()
    expect(original).toContain('Peak -12.0 dB')
    expect(original).toContain('RMS -12.0 dB')
    const initialView = lane.getAttribute('data-view')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const zoomedView = lane.getAttribute('data-view')
    expect(zoomedView).not.toBe(initialView)
    expect(readout()).toBe(original)
    fireEvent.pointerDown(lane, { clientX: 80, altKey: true, button: 0 })
    fireEvent.pointerMove(lane, { clientX: 60, altKey: true })
    fireEvent.pointerUp(lane)
    expect(lane.getAttribute('data-view')).not.toBe(zoomedView)
    expect(readout()).toBe(original)
  })

  it('stops all animation frames while parked without pausing streaming playback', () => {
    let next = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const pane = render(<AudioViewer data={source} visible />)
    expect(frames.size).toBeGreaterThan(0)
    pane.rerender(<AudioViewer data={source} visible={false} />)
    expect(frames.size).toBe(0)
    expect(player.pause).not.toHaveBeenCalled()
    pane.rerender(<AudioViewer data={source} visible />)
    expect(frames.size).toBeGreaterThan(0)
  })

  it('keeps the selected A/B loop active with spectrum off and while parked', () => {
    vi.useFakeTimers()
    vi.stubGlobal('PointerEvent', MouseEvent)
    const pane = render(<AudioViewer data={source} />)
    act(() => player.emit('loadedmetadata'))
    const lane = pane.container.querySelector('.dsh-audio__lane') as HTMLElement
    fireEvent.pointerDown(lane, { clientX: 20, shiftKey: true, button: 0 })
    fireEvent.pointerMove(lane, { clientX: 80, shiftKey: true })
    fireEvent.pointerUp(lane)
    fireEvent.change(screen.getByLabelText('Loop'), { target: { value: 'ab' } })
    fireEvent.change(screen.getByLabelText('Spectrum'), { target: { value: 'off' } })
    player.element.paused = false
    act(() => player.emit('play'))
    player.element.currentTime = 9
    act(() => vi.advanceTimersByTime(30))
    expect(player.element.currentTime).toBeCloseTo(2)
    pane.rerender(<AudioViewer data={source} visible={false} />)
    player.element.currentTime = 9
    act(() => vi.advanceTimersByTime(30))
    expect(player.element.currentTime).toBeCloseTo(2)
  })

  it('restarts an A/B selection ending at the media end', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const pane = render(<AudioViewer data={source} />)
    act(() => player.emit('loadedmetadata'))
    const lane = pane.container.querySelector('.dsh-audio__lane') as HTMLElement
    fireEvent.pointerDown(lane, { clientX: 20, shiftKey: true, button: 0 })
    fireEvent.pointerMove(lane, { clientX: 120, shiftKey: true })
    fireEvent.pointerUp(lane)
    fireEvent.change(screen.getByLabelText('Loop'), { target: { value: 'ab' } })
    fireEvent.change(screen.getByLabelText('Spectrum'), { target: { value: 'off' } })
    player.element.currentTime = 12
    player.element.paused = true
    act(() => player.emit('ended'))
    expect(player.element.currentTime).toBeCloseTo(2)
    expect(player.play).toHaveBeenCalledOnce()
  })

  it('waits for an uncancellable decode before starting a new visible analysis', async () => {
    const finishes: Array<(value: unknown) => void> = []
    const decode = vi.fn(() => new Promise(resolve => finishes.push(resolve)))
    vi.stubGlobal('OfflineAudioContext', class { decodeAudioData = decode })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))))
    const pane = render(<AudioViewer data={source} />)
    act(() => player.emit('loadedmetadata'))
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
    pane.rerender(<AudioViewer data={source} visible={false} />)
    pane.rerender(<AudioViewer data={source} visible />)
    await act(async () => { await Promise.resolve() })
    expect(decode).toHaveBeenCalledOnce()
    const buffer = { duration: 12, length: 4, numberOfChannels: 1, sampleRate: 44100, getChannelData: () => new Float32Array(4) }
    await act(async () => { finishes[0]!(buffer) })
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2))
    await act(async () => { finishes[1]!(buffer) })
  })

  it('streams large files without automatically downloading them for analysis', () => {
    render(<AudioViewer data={{ ...source, size: 17 * 1024 * 1024 }} />)
    act(() => player.emit('loadedmetadata'))
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText(/Analysis budget exceeded/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(player.play).toHaveBeenCalled()
  })

  it('renders the transport, the file facts and a single-line read-out', () => {
    const { container } = render(<AudioViewer data={source} />)
    expect(screen.getByRole('toolbar')).toBeTruthy()
    expect(screen.getByText('clip.mp3')).toBeTruthy()
    expect(screen.getByText(/4\.0 KB/)).toBeTruthy()
    expect(container.querySelector('.dsh-audio__hint-readout')).toBeTruthy()
  })

  it('keeps every knob in the toolbar, with no manual decode button', () => {
    render(<AudioViewer data={source} />)
    expect(screen.queryByRole('button', { name: 'Decode waveform' })).toBeNull()
  })

  it('starts decoding on its own once the duration is known', async () => {
    render(<AudioViewer data={source} />)
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).not.toHaveBeenCalled()
    player.emit('loadedmetadata')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/audio-preview/media?')
  })

  it('moves the interaction cheatsheet into the help button instead of the flow', () => {
    render(<AudioViewer data={source} />)
    const help = screen.getByRole('button', { name: 'Controls' })
    expect(help.getAttribute('title')).toMatch(/Space/)
  })

  it('keeps notices in a floating layer', () => {
    const { container } = render(<AudioViewer data={source} />)
    expect(container.querySelector('.dsh-audio__notices')).toBeTruthy()
    expect(container.querySelector('.dsh-audio__lane')).toBeTruthy()
  })

  it('publishes the visible window for diagnosis', () => {
    const { container } = render(<AudioViewer data={source} />)
    const lane = container.querySelector('.dsh-audio__lane') as HTMLElement
    expect(lane.getAttribute('data-view')).toMatch(/^-?\d+\.\d{3}--?\d+\.\d{3}$/)
  })

  it('renders the main lane with the playhead overlay and its own ruler', () => {
    const { container } = render(<AudioViewer data={source} />)
    // Data canvas + the pointer-transparent playhead/cursor overlay.
    expect(container.querySelectorAll('.dsh-audio__lane > canvas').length).toBe(2)
    expect(container.querySelector('.dsh-audio__lane-overlay')).toBeTruthy()
    expect(container.querySelectorAll('.dsh-audio__ruler canvas').length).toBe(1)
    expect(container.querySelectorAll('.dsh-audio__spectrum canvas').length).toBe(1)
  })

  it('plays and pauses through the engine', () => {
    render(<AudioViewer data={source} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(player.play).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(player.pause).toHaveBeenCalledTimes(1)
  })

  it('starts playback from the keyboard with Space', () => {
    const { container } = render(<AudioViewer data={source} />)
    const root = container.querySelector('[data-dsh-audio-preview="viewer"]') as HTMLElement
    fireEvent.keyDown(root, { key: ' ' })
    expect(player.play).toHaveBeenCalled()
  })

  it('switches to the spectrogram view and reports that it is computing', () => {
    render(<AudioViewer data={source} />)
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'spectrogram' } })
    expect(screen.getByText(/Computing spectrogram/)).toBeTruthy()
  })

  it('switches back to the waveform view', () => {
    render(<AudioViewer data={source} />)
    const view = screen.getByLabelText('View')
    fireEvent.change(view, { target: { value: 'spectrogram' } })
    fireEvent.change(view, { target: { value: 'waveform' } })
    expect(screen.queryByText(/Computing spectrogram/)).toBeNull()
  })

  it('hides the live spectrum lane when it is switched off', () => {
    const { container } = render(<AudioViewer data={source} />)
    fireEvent.change(screen.getByLabelText('Spectrum'), { target: { value: 'off' } })
    expect(container.querySelector('.dsh-audio__spectrum')).toBeNull()
  })

  it('offers the A-B loop only once a selection exists', () => {
    render(<AudioViewer data={source} />)
    const option = screen.getByRole('option', { name: 'Loop selection' }) as HTMLOptionElement
    expect(option.disabled).toBe(true)
  })

  it('reports a load failure instead of rendering a player', () => {
    render(<AudioViewer data={{ error: 'boom' }} />)
    expect(screen.getByText(/Cannot read this audio file/)).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('surfaces a decode failure without breaking playback controls', async () => {
    render(<AudioViewer data={source} />)
    player.emit('loadedmetadata')
    expect(await screen.findByText(/Decode failed/)).toBeTruthy()
    expect(screen.getByRole('toolbar')).toBeTruthy()
  })

  it('disposes the engine on unmount', () => {
    const { unmount } = render(<AudioViewer data={source} />)
    unmount()
    expect(player.dispose).toHaveBeenCalledTimes(1)
  })
})
