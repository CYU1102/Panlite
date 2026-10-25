import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ShareSubscription, ShareSubscriptionInput, SubscriptionEntry, SubscriptionRun, SubscriptionWork } from '../shared/subscription-types'
import type { Platform } from '../shared/types'

interface JsonRow { data: string }

/** Separate, versioned tables keep old queued transfer payloads readable during upgrade. */
export function initializeSubscriptionSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS subscription_schema(version INTEGER NOT NULL);
      INSERT INTO subscription_schema(version) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM subscription_schema);`)
    const { version } = db.prepare('SELECT version FROM subscription_schema').get() as { version: number }
    if (version > 1) throw new Error('订阅数据版本高于当前应用，请升级应用')
    if (version === 1) return
    db.exec(`CREATE TABLE subscription_configs(id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE subscription_observations(subscription_id TEXT NOT NULL REFERENCES subscription_configs(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(subscription_id,entry_id));
      CREATE TABLE subscription_runs(id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, config_version INTEGER NOT NULL,
        state TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX subscription_one_active_run ON subscription_runs(subscription_id,config_version)
        WHERE state IN ('pending','running','blocked');
      CREATE INDEX subscription_runs_subscription ON subscription_runs(subscription_id);
      CREATE TABLE subscription_run_work(run_id TEXT NOT NULL REFERENCES subscription_runs(id) ON DELETE CASCADE,
        work_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        saved_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id,work_id));`)
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='share_subscriptions'").get()) {
      const legacy = db.prepare('SELECT * FROM share_subscriptions').all() as Array<Record<string, unknown>>
      const insert = db.prepare('INSERT INTO subscription_configs(id,version,data) VALUES(?,1,?)')
      const observe = db.prepare('INSERT OR IGNORE INTO subscription_observations(subscription_id,entry_id,data) VALUES(?,?,?)')
      for (const row of legacy) {
        const config: ShareSubscription = {
          id: String(row.id), configVersion: 1, accountId: String(row.account_id), platform: String(row.platform) as Platform,
          url: String(row.url), password: String(row.password || ''), title: String(row.title || ''),
          targetDirId: String(row.target_dir_id || '0'), targetDirPath: String(row.target_dir_path || ''),
          scope: 'root', initialMode: 'baseline', includeKeywords: [], excludeKeywords: [], extensions: [],
          preserveStructure: true, detectChanges: false, status: row.status === 'paused' ? 'paused' : 'active',
          baselineComplete: Boolean(row.last_signature), lastError: String(row.last_error || ''), failureCount: 0,
          nextCheckAt: 0, lastCheckedAt: Number(row.last_checked_at) || undefined, lastSyncedAt: Number(row.last_synced_at) || undefined,
          createdAt: Number(row.created_at) || Date.now(), updatedAt: Number(row.updated_at) || Date.now(),
        }
        let ids: unknown = []
        try { ids = JSON.parse(String(row.seen_file_ids || '[]')) } catch { config.baselineComplete = false }
        if (!Array.isArray(ids)) config.baselineComplete = false
        insert.run(config.id, JSON.stringify(config))
        if (Array.isArray(ids)) for (const id of ids) {
          if (typeof id === 'string' && id) observe.run(config.id, id, JSON.stringify({ fileId: id, name: '', isDir: false, parentId: '0', relativePath: '' }))
        }
      }
    }
    db.exec('UPDATE subscription_schema SET version=1')
  }).immediate()
}

export class SubscriptionStore {
  constructor(readonly db: Database.Database, readonly clock: () => number = Date.now) { initializeSubscriptionSchema(db) }
  get(id: string): ShareSubscription | undefined {
    const row = this.db.prepare('SELECT data FROM subscription_configs WHERE id=?').get(id) as JsonRow | undefined
    return row ? JSON.parse(row.data) as ShareSubscription : undefined
  }
  list(): ShareSubscription[] {
    return (this.db.prepare('SELECT data FROM subscription_configs ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.data) as ShareSubscription)
  }
  private write(config: ShareSubscription): ShareSubscription {
    this.db.prepare('INSERT INTO subscription_configs(id,version,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data')
      .run(config.id, config.configVersion, JSON.stringify(config))
    return config
  }
  save(input: ShareSubscriptionInput): ShareSubscription {
    return this.db.transaction(() => {
      const previous = input.id ? this.get(input.id) : undefined
      if (input.id && !previous) throw new Error('订阅不存在')
      if (previous && previous.configVersion !== input.expectedVersion) throw new Error('订阅配置已更新，请刷新后重试')
      if (previous) {
        this.db.prepare('DELETE FROM subscription_observations WHERE subscription_id=?').run(previous.id)
        this.db.prepare("UPDATE subscription_runs SET state='superseded' WHERE subscription_id=? AND state!='success'").run(previous.id)
      }
      const config: ShareSubscription = {
        accountId: input.accountId, platform: input.platform as Platform, url: input.url, password: input.password || '',
        title: input.title || '', targetDirId: input.targetDirId, targetDirPath: input.targetDirPath || '',
        scope: input.scope || 'root', initialMode: input.initialMode || 'baseline', includeKeywords: input.includeKeywords || [],
        excludeKeywords: input.excludeKeywords || [], extensions: input.extensions || [],
        preserveStructure: input.preserveStructure !== false, detectChanges: input.detectChanges === true,
        id: previous?.id || randomUUID(), configVersion: (previous?.configVersion || 0) + 1,
        status: previous?.status || 'active', baselineComplete: false, lastError: '', failureCount: 0,
        nextCheckAt: 0, createdAt: previous?.createdAt || this.clock(), updatedAt: this.clock(),
      }
      return this.write(config)
    }).immediate()
  }
  patch(id: string, version: number, patch: Partial<Pick<ShareSubscription, 'status' | 'lastError' | 'lastCheckedAt' | 'lastSyncedAt' | 'nextCheckAt' | 'failureCount' | 'activeRunId' | 'taskId' | 'baselineComplete'>>): boolean {
    const config = this.get(id)
    if (!config || config.configVersion !== version) return false
    this.write({ ...config, ...patch, updatedAt: this.clock() })
    return true
  }
  remove(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM subscription_observations WHERE subscription_id=?').run(id)
      this.db.prepare('DELETE FROM subscription_configs WHERE id=?').run(id)
      // Keep operation evidence on old runs, but they cannot commit to a deleted config.
      this.db.prepare("UPDATE subscription_runs SET state='superseded' WHERE subscription_id=? AND state!='success'").run(id)
    }).immediate()
  }
  observations(id: string): SubscriptionEntry[] {
    return (this.db.prepare('SELECT data FROM subscription_observations WHERE subscription_id=?').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as SubscriptionEntry)
  }
  private observe(id: string, snapshot: SubscriptionEntry[]): void {
    const statement = this.db.prepare('INSERT INTO subscription_observations(subscription_id,entry_id,data) VALUES(?,?,?) ON CONFLICT(subscription_id,entry_id) DO UPDATE SET data=excluded.data')
    // Retain missing IDs. A transient disappearance/reappearance is not new content.
    for (const entry of snapshot) statement.run(id, entry.fileId, JSON.stringify(entry))
  }
  commitBaseline(config: ShareSubscription, snapshot: SubscriptionEntry[], nextCheckAt: number): boolean {
    return this.db.transaction(() => {
      const current = this.get(config.id)
      if (!current || current.status !== 'active' || current.configVersion !== config.configVersion) return false
      this.observe(config.id, snapshot)
      return this.patch(config.id, config.configVersion, { baselineComplete: true, lastCheckedAt: this.clock(), lastError: '', failureCount: 0, nextCheckAt })
    }).immediate()
  }
  createRun(config: ShareSubscription, snapshot: SubscriptionEntry[], work: SubscriptionWork[]): SubscriptionRun | undefined {
    return this.db.transaction(() => {
      const current = this.get(config.id)
      if (!current || current.status !== 'active' || current.configVersion !== config.configVersion) return undefined
      const existing = this.activeRun(config.id, config.configVersion)
      if (existing) return existing
      const run: SubscriptionRun = { id: randomUUID(), subscriptionId: config.id, configVersion: config.configVersion,
        config, snapshot, work, state: 'pending', createdAt: this.clock(), updatedAt: this.clock() }
      this.db.prepare('INSERT INTO subscription_runs(id,subscription_id,config_version,state,data) VALUES(?,?,?,?,?)')
        .run(run.id, run.subscriptionId, run.configVersion, run.state, JSON.stringify({ ...run, work: [] }))
      const insert = this.db.prepare('INSERT INTO subscription_run_work(run_id,work_id,ordinal,data) VALUES(?,?,?,?)')
      work.forEach((item, ordinal) => insert.run(run.id, item.id, ordinal, JSON.stringify(item)))
      this.patch(config.id, config.configVersion, { activeRunId: run.id, lastError: '', lastCheckedAt: this.clock() })
      return run
    }).immediate()
  }
  getRun(id: string): SubscriptionRun | undefined {
    const row = this.db.prepare('SELECT data,state,task_id FROM subscription_runs WHERE id=?').get(id) as (JsonRow & { state: SubscriptionRun['state']; task_id: string | null }) | undefined
    if (!row) return undefined
    const items = this.db.prepare('SELECT data,done,saved_count FROM subscription_run_work WHERE run_id=? ORDER BY ordinal').all(id) as Array<JsonRow & { done: number; saved_count: number }>
    return { ...JSON.parse(row.data) as SubscriptionRun, state: row.state, taskId: row.task_id || undefined,
      work: items.map(item => ({ ...JSON.parse(item.data) as SubscriptionWork, done: Boolean(item.done), savedCount: item.saved_count })) }
  }
  activeRun(id: string, version: number): SubscriptionRun | undefined {
    const row = this.db.prepare("SELECT id FROM subscription_runs WHERE subscription_id=? AND config_version=? AND state IN ('pending','running','blocked')")
      .get(id, version) as { id: string } | undefined
    return row ? this.getRun(row.id) : undefined
  }
  updateRun(run: SubscriptionRun): void {
    this.db.prepare("UPDATE subscription_runs SET state=?,task_id=?,data=? WHERE id=? AND state NOT IN ('superseded','success')")
      .run(run.state, run.taskId || null, JSON.stringify({ ...run, work: [], updatedAt: this.clock() }), run.id)
  }
  completeWork(runId: string, workId: string, count: number): void {
    // One small receipt write per item; never rewrite a full 50,000-entry snapshot.
    this.db.prepare(`UPDATE subscription_run_work SET done=1,saved_count=? WHERE run_id=? AND work_id=?
      AND EXISTS(SELECT 1 FROM subscription_runs WHERE id=? AND state NOT IN ('superseded','success'))`).run(count, runId, workId, runId)
  }
  commitRun(runId: string, nextCheckAt: number): boolean {
    return this.db.transaction(() => {
      const run = this.getRun(runId)
      if (!run || run.state === 'superseded' || run.state === 'success' || run.work.some(item => !item.done)) return false
      const current = this.get(run.subscriptionId)
      if (!current || current.status !== 'active' || current.configVersion !== run.configVersion) return false
      this.observe(current.id, run.snapshot)
      run.state = 'success'
      this.updateRun(run)
      return this.patch(current.id, current.configVersion, { baselineComplete: true, lastSyncedAt: this.clock(), lastCheckedAt: this.clock(),
        nextCheckAt, failureCount: 0, lastError: '', activeRunId: undefined, taskId: undefined })
    }).immediate()
  }
}
