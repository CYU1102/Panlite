import { describe, expect, it } from 'vitest'
import {
  buildXunleiSharePageUrl,
  classifyXunleiTask,
  extractXunleiSharePassword,
  getXunleiRestoreTaskId,
  isXunleiRestoreComplete,
} from './xunlei-share'

describe('xunlei share transfer helpers', () => {
  it('keeps the password from a share URL and lets an explicit password win', () => {
    expect(extractXunleiSharePassword('https://pan.xunlei.com/s/share-id?pwd=kt75')).toBe('kt75')
    expect(extractXunleiSharePassword('https://pan.xunlei.com/s/share-id?pwd=old1', 'new2')).toBe('new2')
    expect(buildXunleiSharePageUrl('share-id', 'https://pan.xunlei.com/s/share-id', 'kt75'))
      .toBe('https://pan.xunlei.com/s/share-id?pwd=kt75')
  })

  it('reads the restore_task_id used by the browser API', () => {
    expect(getXunleiRestoreTaskId({ restore_status: 'RESTORE_START', restore_task_id: 'task-1' })).toBe('task-1')
    expect(getXunleiRestoreTaskId({ data: { task_id: 'task-2' } })).toBe('task-2')
  })

  it('recognizes immediate restore completion', () => {
    expect(isXunleiRestoreComplete({ restore_status: 'RESTORE_SUCCESS' })).toBe(true)
    expect(isXunleiRestoreComplete({ status: 'COMPLETED' })).toBe(true)
    expect(isXunleiRestoreComplete({ restore_status: 'RESTORE_START', file_id: '' })).toBe(false)
  })

  it('classifies terminal and pending task phases', () => {
    expect(classifyXunleiTask({ phase: 'PHASE_TYPE_COMPLETE' }).state).toBe('complete')
    expect(classifyXunleiTask({ task: { phase: 'PHASE_TYPE_RUNNING' } }).state).toBe('pending')
    expect(classifyXunleiTask({ data: { status: 'FAILED', message: 'quota exceeded' } })).toEqual({
      state: 'failed',
      phase: 'FAILED',
      message: 'quota exceeded',
    })
    expect(classifyXunleiTask({ phase: 'SOMETHING_NEW' }).state).toBe('unknown')
  })
})
