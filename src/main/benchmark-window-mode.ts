/** A visible benchmark window is allowed only on a disposable hosted runner. */
export function benchmarkVisibleWindow(args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (!args.includes('--benchmark-visible')) return false
  if (!args.includes('--benchmark-startup') || platform !== 'win32' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows'
    || !env.RUNNER_TEMP || !env.GITHUB_WORKSPACE || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
    || !/^[a-f\d]{40}$/i.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Visible startup benchmarks require a disposable GitHub-hosted Windows runner')
  }
  return true
}
