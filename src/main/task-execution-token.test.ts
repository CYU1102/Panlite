import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-task-token-'))
process.env.PANLITE_TEST_USER_DATA = testUserDataDir

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.PANLITE_TEST_USER_DATA,
  },
}))

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  getDb,
  getTaskById,
  initDatabase,
  insertTask,
  recoverInterruptedTasks,
  transitionTaskStatusIfCurrent,
  updateTaskPayloadIfOwned,
  updateTaskProgressIfOwned,
} from './db'

describe('task execution token ownership', () => {
  beforeAll(() => {
    vi.useFakeTimers()
    initDatabase()
  })

  afterAll(() => {
    vi.useRealTimers()
    getDb().close()
    fs.rmSync(testUserDataDir, { recursive: true, force: true })
  })

  it('rejects stale A writes after a pause/resume generation B claims the row', () => {
    const taskId = 'token-race-task'
    insertTask({
      id: taskId,
      account_id: 'account-1',
      platform: 'quark',
      task_type: 'upload',
      title: 'token race',
      payload: JSON.stringify({ results: [] }),
      status: 'pending',
      progress: 0,
      retry_count: 0,
      error_message: null,
      execution_token: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      finished_at: null,
    })

    expect(transitionTaskStatusIfCurrent(taskId, 'pending', 'running', {
      expectedExecutionToken: null,
      executionToken: 'A',
    })).toBe(true)
    expect(updateTaskProgressIfOwned(taskId, 'A', 35)).toBe(true)
    expect(updateTaskPayloadIfOwned(taskId, 'A', { results: [{ key: 'a', status: 'success' }] })).toBe(true)

    expect(transitionTaskStatusIfCurrent(taskId, 'running', 'paused', {
      expectedExecutionToken: 'A',
      executionToken: null,
    })).toBe(true)
    expect(transitionTaskStatusIfCurrent(taskId, 'paused', 'pending', {
      expectedExecutionToken: null,
      executionToken: null,
    })).toBe(true)
    expect(transitionTaskStatusIfCurrent(taskId, 'pending', 'running', {
      expectedExecutionToken: null,
      executionToken: 'B',
    })).toBe(true)

    expect(updateTaskProgressIfOwned(taskId, 'A', 99)).toBe(false)
    expect(updateTaskPayloadIfOwned(taskId, 'A', { results: [{ key: 'stale', status: 'success' }] })).toBe(false)
    expect(transitionTaskStatusIfCurrent(taskId, 'running', 'success', {
      expectedExecutionToken: 'A',
      executionToken: 'A',
      progress: 100,
    })).toBe(false)

    expect(updateTaskProgressIfOwned(taskId, 'B', 65)).toBe(true)
    expect(transitionTaskStatusIfCurrent(taskId, 'running', 'success', {
      expectedExecutionToken: 'B',
      executionToken: 'B',
      progress: 100,
    })).toBe(true)

    const finalTask = getTaskById(taskId)
    expect(finalTask?.status).toBe('success')
    expect(finalTask?.progress).toBe(100)
    expect(finalTask?.execution_token).toBe('B')
    expect(JSON.parse(finalTask?.payload || '{}')).toEqual({ results: [{ key: 'a', status: 'success' }] })
  })

  it('handles NULL token predicates for legacy/unclaimed rows', () => {
    const taskId = 'legacy-null-token-task'
    insertTask({
      id: taskId,
      account_id: 'account-1',
      platform: 'quark',
      task_type: 'rename',
      title: 'legacy token',
      payload: '{}',
      status: 'pending',
      progress: 0,
      retry_count: 0,
      error_message: null,
      execution_token: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      finished_at: null,
    })

    expect(transitionTaskStatusIfCurrent(taskId, 'pending', 'running', {
      expectedExecutionToken: null,
      executionToken: 'new-token',
    })).toBe(true)
    expect(transitionTaskStatusIfCurrent(taskId, 'running', 'paused', {
      expectedExecutionToken: null,
      executionToken: null,
    })).toBe(false)
    expect(getTaskById(taskId)?.execution_token).toBe('new-token')
    expect(transitionTaskStatusIfCurrent(taskId, 'running', 'paused', {
      expectedExecutionToken: 'new-token',
      executionToken: null,
    })).toBe(true)
  })

  it('enforces the automatic retry ceiling inside the ownership CAS', () => {
    const taskId = 'retry-ceiling-task'
    insertTask({
      id: taskId,
      account_id: 'account-1',
      platform: 'quark',
      task_type: 'upload',
      title: 'retry ceiling',
      payload: '{}',
      status: 'running',
      progress: 20,
      retry_count: 2,
      error_message: null,
      execution_token: 'retry-owner',
      created_at: Date.now(),
      updated_at: Date.now(),
      finished_at: null,
    })

    expect(transitionTaskStatusIfCurrent(taskId, 'running', 'pending', {
      expectedExecutionToken: 'retry-owner',
      executionToken: null,
      incrementRetry: true,
      maxRetryCount: 3,
    })).toBe(true)
    expect(getTaskById(taskId)).toMatchObject({ status: 'pending', retry_count: 3, execution_token: null })

    // A duplicate/stale failure handler cannot increment beyond the ceiling.
    expect(transitionTaskStatusIfCurrent(taskId, 'pending', 'pending', {
      expectedExecutionToken: null,
      executionToken: null,
      incrementRetry: true,
      maxRetryCount: 3,
    })).toBe(false)
    expect(getTaskById(taskId)?.retry_count).toBe(3)
  })

  it('recovers running attempts and preserves an explicit paused choice', () => {
    const timestamp = Date.now()
    insertTask({
      id: 'recover-running-task',
      account_id: 'account-1',
      platform: 'quark',
      task_type: 'download',
      title: 'recover running',
      payload: '{}',
      status: 'running',
      progress: 47,
      retry_count: 1,
      error_message: 'old worker error',
      execution_token: 'dead-process-token',
      created_at: timestamp,
      updated_at: timestamp,
      finished_at: timestamp - 1,
    })
    insertTask({
      id: 'preserve-paused-task',
      account_id: 'account-1',
      platform: 'quark',
      task_type: 'download',
      title: 'preserve paused',
      payload: '{}',
      status: 'paused',
      progress: 61,
      retry_count: 2,
      error_message: 'paused by user',
      execution_token: null,
      created_at: timestamp,
      updated_at: timestamp,
      finished_at: timestamp - 2,
    })

    expect(recoverInterruptedTasks()).toBe(1)
    expect(getTaskById('recover-running-task')).toMatchObject({
      status: 'pending',
      progress: 47,
      retry_count: 1,
      error_message: 'Recovered after application restart',
      execution_token: null,
      finished_at: null,
    })
    expect(getTaskById('preserve-paused-task')).toMatchObject({
      status: 'paused',
      progress: 61,
      retry_count: 2,
      error_message: 'paused by user',
      execution_token: null,
      finished_at: timestamp - 2,
    })
  })
})
