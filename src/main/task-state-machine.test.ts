import { describe, expect, it } from 'vitest'
import {
  assertTaskTransition,
  canTransitionTaskState,
  InvalidTaskTransitionError,
  recoverTaskState,
  transitionTaskState,
} from './task-state-machine'

describe('task lifecycle state machine', () => {
  it('accepts the normal pending → running → success path', () => {
    const started = transitionTaskState('pending', 'start')
    expect(started).toMatchObject({ ok: true, from: 'pending', to: 'running', state: 'running', changed: true, idempotent: false })

    const completed = transitionTaskState(started.state, { type: 'success' })
    expect(completed).toMatchObject({ ok: true, from: 'running', to: 'success', changed: true })
  })

  it('rejects illegal resurrection and control transitions', () => {
    expect(transitionTaskState('success', 'start').ok).toBe(false)
    expect(transitionTaskState('success', 'retry').ok).toBe(false)
    expect(transitionTaskState('paused', 'start').ok).toBe(false)
    expect(transitionTaskState('running', 'resume').ok).toBe(false)
    expect(transitionTaskState('failed', 'success').ok).toBe(false)
    expect(transitionTaskState('cancelled', 'pause').ok).toBe(false)
    expect(transitionTaskState('not-a-status', 'start')).toMatchObject({
      ok: false,
      state: 'not-a-status',
      changed: false,
    })
    expect(transitionTaskState('pending', 'not-an-event' as never).ok).toBe(false)
  })

  it('treats replayed events as idempotent no-ops', () => {
    for (const [state, event] of [
      ['running', 'start'],
      ['paused', 'pause'],
      ['pending', 'resume'],
      ['cancelled', 'cancel'],
      ['success', 'success'],
      ['partial_success', 'partial_success'],
      ['failed', 'fail'],
      ['pending', 'retry'],
      ['pending', 'recover'],
    ] as const) {
      expect(transitionTaskState(state, event)).toMatchObject({
        ok: true,
        from: state,
        to: state,
        state,
        changed: false,
        idempotent: true,
      })
    }
  })

  it('keeps pause ahead of a racing worker start', () => {
    const paused = transitionTaskState('pending', 'pause')
    expect(paused).toMatchObject({ ok: true, to: 'paused' })

    // A worker that read "pending" before the pause must re-check the state
    // before claiming it; the state machine rejects that stale start.
    expect(transitionTaskState(paused.state, 'start')).toMatchObject({
      ok: false,
      from: 'paused',
      to: 'paused',
      changed: false,
    })
    expect(canTransitionTaskState('paused', 'start')).toBe(false)
  })

  it('supports explicit retry and resume without allowing terminal success to regress', () => {
    expect(transitionTaskState('failed', 'retry')).toMatchObject({ ok: true, to: 'pending' })
    expect(transitionTaskState('partial_success', 'retry')).toMatchObject({ ok: true, to: 'pending' })
    expect(transitionTaskState('cancelled', 'retry')).toMatchObject({ ok: true, to: 'pending' })
    expect(transitionTaskState('paused', 'resume')).toMatchObject({ ok: true, to: 'pending' })
    expect(transitionTaskState('success', 'retry').ok).toBe(false)
  })

  it('recovers only work that was running at process termination', () => {
    expect(recoverTaskState('running')).toMatchObject({ ok: true, from: 'running', to: 'pending', changed: true })
    expect(recoverTaskState('pending')).toMatchObject({ ok: true, idempotent: true, to: 'pending' })
    expect(recoverTaskState('paused').ok).toBe(false)
    expect(recoverTaskState('cancelled').ok).toBe(false)
    expect(recoverTaskState('success').ok).toBe(false)
  })

  it('offers an exception-based guard for callers that require strict validation', () => {
    expect(() => assertTaskTransition('success', 'start')).toThrow(InvalidTaskTransitionError)
    expect(assertTaskTransition('pending', 'start').to).toBe('running')
  })

  it('rejects malformed runtime events without throwing or changing state', () => {
    for (const event of [null, undefined, {}, { type: '' }, { type: 'constructor' }]) {
      expect(transitionTaskState('running', event as never)).toMatchObject({
        ok: false, from: 'running', to: 'running', changed: false, reason: '未知任务迁移事件',
      })
    }
  })
})
