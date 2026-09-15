import type { TaskStatus } from '../shared/types'

/**
 * Events understood by the task lifecycle state machine.
 *
 * `retry` is used both for an automatic retry after a transient failure and
 * for an explicit retry requested by the user.  `recover` is deliberately a
 * separate event: only work that was running when the process disappeared is
 * eligible for crash recovery.  A paused task must remain paused after a
 * restart because that state represents an explicit user choice.
 */
export type TaskTransitionEvent =
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'success'
  | 'partial_success'
  | 'fail'
  | 'retry'
  | 'recover'

/** Allow callers to use either a compact event string or an event object. */
export type TaskTransition = TaskTransitionEvent | { type: TaskTransitionEvent }

export interface TaskTransitionResult {
  /** Whether the event is valid for the current state. */
  readonly ok: boolean
  /** State before the event (kept as string so malformed DB data is reported). */
  readonly from: string
  /** State after the event. For a rejected event this is the unchanged state. */
  readonly to: string
  /** Alias for `to`, convenient for callers that model a state reducer. */
  readonly state: string
  /** True only when the event actually changes the state. */
  readonly changed: boolean
  /** True when the event is a safe replay/no-op for an already applied event. */
  readonly idempotent: boolean
  /** Human-readable reason for a rejected event. */
  readonly reason?: string
}
const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'running',
  'paused',
  'cancelled',
  'success',
  'partial_success',
  'failed',
]

/**
 * Explicit lifecycle transition table.
 *
 * Self-transitions are intentional. Queue delivery, process shutdown hooks,
 * and UI retries can all replay an event; accepting a replay as a no-op makes
 * those operations idempotent while still rejecting resurrection of a
 * terminal task through an unrelated event.
 */
const TRANSITIONS: Readonly<Record<TaskTransitionEvent, Readonly<Partial<Record<TaskStatus, TaskStatus>>>> > = {
  start: {
    pending: 'running',
    running: 'running',
  },
  pause: {
    pending: 'paused',
    running: 'paused',
    paused: 'paused',
  },
  resume: {
    paused: 'pending',
    pending: 'pending',
  },
  cancel: {
    pending: 'cancelled',
    running: 'cancelled',
    paused: 'cancelled',
    cancelled: 'cancelled',
  },
  success: {
    running: 'success',
    success: 'success',
  },
  partial_success: {
    running: 'partial_success',
    partial_success: 'partial_success',
  },
  fail: {
    running: 'failed',
    failed: 'failed',
  },
  retry: {
    pending: 'pending',
    running: 'pending',
    failed: 'pending',
    partial_success: 'pending',
    cancelled: 'pending',
  },
  recover: {
    running: 'pending',
    pending: 'pending',
  },
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

function normalizeEvent(event: TaskTransition): TaskTransitionEvent | null {
  const candidate = typeof event === 'string' ? event : event?.type
  if (!candidate) return null
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, candidate) ? candidate : null
}

/**
 * Reduce one task lifecycle event without side effects.
 *
 * Invalid states/events never throw.  Returning a rejected result lets the DB
 * adapter and callers handle races consistently, while `assertTaskTransition`
 * is available for code that prefers exception-based validation.
 */
export function transitionTaskState(current: string, event: TaskTransition): TaskTransitionResult {
  const normalizedEvent = normalizeEvent(event)
  if (!isTaskStatus(current)) {
    return {
      ok: false,
      from: current,
      to: current,
      state: current,
      changed: false,
      idempotent: false,
      reason: `未知任务状态: ${current}`,
    }
  }

  if (!normalizedEvent) {
    return {
      ok: false,
      from: current,
      to: current,
      state: current,
      changed: false,
      idempotent: false,
      reason: '未知任务迁移事件',
    }
  }

  const next = TRANSITIONS[normalizedEvent][current]
  if (!next) {
    return {
      ok: false,
      from: current,
      to: current,
      state: current,
      changed: false,
      idempotent: false,
      reason: `不允许从 ${current} 执行 ${normalizedEvent}`,
    }
  }

  return {
    ok: true,
    from: current,
    to: next,
    state: next,
    changed: next !== current,
    idempotent: next === current,
  }
}

export function canTransitionTaskState(current: string, event: TaskTransition): boolean {
  return transitionTaskState(current, event).ok
}

export class InvalidTaskTransitionError extends Error {
  readonly transition: TaskTransitionResult

  constructor(transition: TaskTransitionResult) {
    super(transition.reason || `不允许任务状态迁移: ${transition.from}`)
    this.name = 'InvalidTaskTransitionError'
    this.transition = transition
  }
}

export function assertTaskTransition(current: string, event: TaskTransition): TaskTransitionResult {
  const result = transitionTaskState(current, event)
  if (!result.ok) throw new InvalidTaskTransitionError(result)
  return result
}

/**
 * Convenience reducer for startup recovery.  It intentionally does not
 * recover paused or terminal tasks.
 */
export function recoverTaskState(current: string): TaskTransitionResult {
  return transitionTaskState(current, 'recover')
}
