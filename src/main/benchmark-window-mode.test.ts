import { describe, expect, it } from 'vitest'
import { benchmarkVisibleWindow } from './benchmark-window-mode'

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  RUNNER_TEMP: 'temporary', GITHUB_WORKSPACE: 'workspace', GITHUB_RUN_ID: '123', GITHUB_SHA: 'a'.repeat(40) }

describe('visible startup benchmark isolation', () => {
  it('keeps the existing hidden benchmark and normal launch behavior', () => {
    expect(benchmarkVisibleWindow(['--benchmark-startup'], {}, 'win32')).toBe(false)
    expect(benchmarkVisibleWindow([], {}, 'win32')).toBe(false)
  })
  it('accepts only an explicit visible benchmark on a hosted Windows runner', () => {
    expect(benchmarkVisibleWindow(['--benchmark-startup', '--benchmark-visible'], hosted, 'win32')).toBe(true)
    expect(() => benchmarkVisibleWindow(['--benchmark-visible'], hosted, 'win32')).toThrow()
    expect(() => benchmarkVisibleWindow(['--benchmark-startup', '--benchmark-visible'], hosted, 'linux')).toThrow()
    for (const env of [{}, { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...hosted, GITHUB_SHA: 'invalid' }]) {
      expect(() => benchmarkVisibleWindow(['--benchmark-startup', '--benchmark-visible'], env, 'win32')).toThrow()
    }
  })
})
