import { expect, it, vi } from 'vitest'
import { createPlayer } from '../src/client/player.ts'

function fixture() {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const analyser = { frequencyBinCount: 8, connect: vi.fn(), disconnect: vi.fn() }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    state: 'suspended', destination: {},
    createAnalyser: () => analyser, createMediaElementSource: () => source,
    resume: vi.fn(async () => { await gate; context.state = 'running' }),
    close: vi.fn(async () => {}),
  }
  const element = {
    src: '', preload: '', play: vi.fn(async () => {}), pause: vi.fn(),
    removeAttribute: vi.fn(), load: vi.fn(),
  }
  const player = createPlayer('/fixture.wav', {
    elementFactory: () => element as unknown as HTMLAudioElement,
    audioContextFactory: () => context as unknown as AudioContext,
  })
  return { player, element, context, finish }
}

it.each(['pause', 'dispose'] as const)('does not start after %s cancels pending resume', async action => {
  const f = fixture()
  const pending = f.player.play()
  expect(f.context.resume).toHaveBeenCalledOnce()
  f.player[action]()
  f.finish()
  await pending
  expect(f.element.play).not.toHaveBeenCalled()
  if (action === 'dispose') {
    await f.player.play()
    expect(f.element.play).not.toHaveBeenCalled()
  }
  f.player.dispose()
})

it('allows a new explicit Play after cancelling the old request', async () => {
  const f = fixture()
  const old = f.player.play()
  f.player.pause()
  const next = f.player.play()
  f.finish()
  await Promise.all([old, next])
  expect(f.element.play).toHaveBeenCalledOnce()
  f.player.dispose()
})

it.each([true, false])('only reports a current media play rejection (cancelled=%s)', async cancelled => {
  const f = fixture()
  f.context.state = 'running'
  let reject!: (reason: Error) => void
  f.element.play.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
  const pending = f.player.play()
  if (cancelled) f.player.pause()
  const error = new Error('media play rejected')
  reject(error)
  if (cancelled) await expect(pending).resolves.toBeUndefined()
  else await expect(pending).rejects.toBe(error)
  f.player.dispose()
})
