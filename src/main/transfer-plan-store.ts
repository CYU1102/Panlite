import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { TransferExecutionItem, TransferPlan, TransferPlanInput, TransferPlanObject, TransferPreview, TransferPreviewItem, TransferRun } from '../shared/transfer-plan'

export interface TransferTreeEntry { relativePath: string; object: TransferPlanObject }
export interface TransferSnapshot {
  source: TransferTreeEntry[]; target: TransferTreeEntry[]
  sourceDirectoryIds: string[]; targetDirectoryIds: string[]
  failures: TransferPreview['failures']
}
export interface StoredTransferPreview { preview: TransferPreview; items: TransferPreviewItem[]; snapshot: TransferSnapshot }
export interface StoredTransferResult extends TransferExecutionItem { object?: TransferPlanObject }
interface JsonRow { data: string }

export function initializeTransferPlanSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transfer_plan_schema(version INTEGER NOT NULL);
      INSERT INTO transfer_plan_schema(version) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM transfer_plan_schema);
    `)
    const version = (db.prepare('SELECT version FROM transfer_plan_schema').get() as { version: number }).version
    if (version > 1) throw new Error('Unsupported transfer plan schema')
    if (version === 1) return
    db.exec(`
      CREATE TABLE transfer_plans(id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE transfer_previews(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES transfer_plans(id) ON DELETE CASCADE, data TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE INDEX transfer_previews_plan ON transfer_previews(plan_id);
      CREATE TABLE transfer_preview_items(preview_id TEXT NOT NULL REFERENCES transfer_previews(id) ON DELETE CASCADE, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, category TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(preview_id,item_id));
      CREATE INDEX transfer_preview_items_page ON transfer_preview_items(preview_id,category,ordinal);
      CREATE TABLE transfer_runs(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES transfer_plans(id) ON DELETE CASCADE, preview_id TEXT NOT NULL REFERENCES transfer_previews(id), owner_token TEXT, data TEXT NOT NULL);
      CREATE INDEX transfer_runs_plan ON transfer_runs(plan_id);
      CREATE TABLE transfer_execution_items(run_id TEXT NOT NULL REFERENCES transfer_runs(id) ON DELETE CASCADE, item_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,item_id));
      UPDATE transfer_plan_schema SET version=1;
    `)
  })()
}

export class TransferPlanStore {
  constructor(readonly db: Database.Database, readonly now: () => number = Date.now) {}
  getPlan(id: string): TransferPlan | undefined {
    const row = this.db.prepare('SELECT data FROM transfer_plans WHERE id=?').get(id) as JsonRow | undefined
    return row ? JSON.parse(row.data) as TransferPlan : undefined
  }
  listPlans(): TransferPlan[] { return (this.db.prepare('SELECT data FROM transfer_plans ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.data) as TransferPlan) }
  savePlan(input: TransferPlanInput): TransferPlan {
    return this.db.transaction(() => {
      const previous = input.id ? this.getPlan(input.id) : undefined
      if (input.id && !previous) throw new Error('PLAN_MISSING')
      if (previous && (previous.status === 'running' || previous.status === 'previewing')) throw new Error('PLAN_BUSY')
      if (previous && previous.version !== input.expectedVersion) throw new Error('PLAN_VERSION')
      const plan: TransferPlan = { id: previous?.id ?? randomUUID(), name: input.name, source: input.source, target: input.target, exclude: input.exclude,
        conflictPolicy: input.conflictPolicy, version: (previous?.version ?? 0) + 1, status: 'draft', createdAt: previous?.createdAt ?? this.now(), updatedAt: this.now(), latestRunId: previous?.latestRunId }
      this.db.prepare('INSERT INTO transfer_plans(id,version,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,data=excluded.data')
        .run(plan.id, plan.version, plan.status, JSON.stringify(plan))
      return plan
    }).immediate()
  }
  patchPlan(id: string, patch: Partial<Pick<TransferPlan, 'status' | 'latestPreviewId' | 'latestRunId'>>): TransferPlan {
    const plan = this.getPlan(id)
    if (!plan) throw new Error('PLAN_MISSING')
    Object.assign(plan, patch, { updatedAt: this.now() })
    this.db.prepare('UPDATE transfer_plans SET status=?,data=? WHERE id=?').run(plan.status, JSON.stringify(plan), id)
    return plan
  }
  removePlan(id: string): void {
    this.db.transaction(() => {
      const plan = this.getPlan(id)
      if (!plan) throw new Error('PLAN_MISSING')
      if (plan.status === 'running' || plan.status === 'previewing') throw new Error('PLAN_BUSY')
      // Remove referencing runs first; preview evidence stays immutable while a run exists.
      this.db.prepare('DELETE FROM transfer_runs WHERE plan_id=?').run(id)
      this.db.prepare('DELETE FROM transfer_plans WHERE id=?').run(id)
    }).immediate()
  }
  beginPreview(id: string): TransferPlan {
    return this.db.transaction(() => {
      const plan = this.getPlan(id)
      if (!plan) throw new Error('PLAN_MISSING')
      if (plan.status === 'running' || plan.status === 'previewing') throw new Error('PLAN_BUSY')
      return this.patchPlan(id, { status: 'previewing' })
    }).immediate()
  }
  savePreview(document: StoredTransferPreview): void {
    this.db.transaction(() => {
      const { preview, items, snapshot } = document
      this.db.prepare('INSERT INTO transfer_previews(id,plan_id,data,snapshot) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(preview.id, preview.planId, JSON.stringify(preview), JSON.stringify(snapshot))
      this.db.prepare('DELETE FROM transfer_preview_items WHERE preview_id=?').run(preview.id)
      const insert = this.db.prepare('INSERT INTO transfer_preview_items(preview_id,item_id,ordinal,category,data) VALUES(?,?,?,?,?)')
      items.forEach((item, ordinal) => insert.run(preview.id, item.id, ordinal, item.category, JSON.stringify(item)))
      this.patchPlan(preview.planId, { status: 'ready', latestPreviewId: preview.id })
    })()
  }
  getPreview(id: string): StoredTransferPreview | undefined {
    const row = this.db.prepare('SELECT data,snapshot FROM transfer_previews WHERE id=?').get(id) as (JsonRow & { snapshot: string }) | undefined
    if (!row) return undefined
    return { preview: JSON.parse(row.data) as TransferPreview, snapshot: JSON.parse(row.snapshot) as TransferSnapshot,
      items: (this.db.prepare('SELECT data FROM transfer_preview_items WHERE preview_id=? ORDER BY ordinal').all(id) as JsonRow[]).map(item => JSON.parse(item.data) as TransferPreviewItem) }
  }
  createRun(preview: TransferPreview): TransferRun {
    return this.db.transaction(() => {
      const plan = this.getPlan(preview.planId)
      if (!plan || plan.version !== preview.planVersion || plan.latestPreviewId !== preview.id) throw new Error('STALE_PREVIEW')
      if (plan.status === 'running' || plan.status === 'previewing') throw new Error('PLAN_BUSY')
      const run: TransferRun = { id: randomUUID(), planId: plan.id, previewId: preview.id, planVersion: plan.version, status: 'queued', totalItems: preview.summary.totalItems,
        succeeded: 0, skipped: 0, failed: 0, uncertain: 0, createdAt: this.now(), updatedAt: this.now() }
      this.db.prepare('INSERT INTO transfer_runs(id,plan_id,preview_id,data) VALUES(?,?,?,?)').run(run.id, run.planId, run.previewId, JSON.stringify(run))
      this.patchPlan(plan.id, { status: 'running', latestRunId: run.id })
      return run
    }).immediate()
  }
  getRun(id: string): TransferRun | undefined {
    const row = this.db.prepare('SELECT data FROM transfer_runs WHERE id=?').get(id) as JsonRow | undefined
    return row ? JSON.parse(row.data) as TransferRun : undefined
  }
  listRuns(planId: string): TransferRun[] {
    return (this.db.prepare('SELECT data FROM transfer_runs WHERE plan_id=? ORDER BY rowid DESC').all(planId) as JsonRow[]).map(row => JSON.parse(row.data) as TransferRun)
  }
  patchRun(id: string, patch: Partial<TransferRun>, token?: string): TransferRun {
    const run = this.getRun(id)
    if (!run) throw new Error('RUN_MISSING')
    Object.assign(run, patch, { updatedAt: this.now() })
    const result = token ? this.db.prepare('UPDATE transfer_runs SET data=? WHERE id=? AND owner_token=?').run(JSON.stringify(run), id, token)
      : this.db.prepare('UPDATE transfer_runs SET data=? WHERE id=?').run(JSON.stringify(run), id)
    if (result.changes !== 1) throw new Error('TASK_SUPERSEDED')
    return run
  }
  claimRun(id: string, taskId: string, token: string): TransferRun {
    return this.db.transaction(() => {
      const run = this.getRun(id)
      if (!run || (run.taskId && run.taskId !== taskId)) throw new Error('RUN_MISSING')
      const plan = this.getPlan(run.planId)
      if (!plan || plan.version !== run.planVersion || plan.latestRunId !== run.id || plan.latestPreviewId !== run.previewId) throw new Error('STALE_PREVIEW')
      this.db.prepare('UPDATE transfer_runs SET owner_token=? WHERE id=?').run(token, id)
      this.patchPlan(plan.id, { status: 'running' })
      return this.patchRun(id, { taskId, status: 'running' }, token)
    }).immediate()
  }
  putResult(runId: string, item: StoredTransferResult, token: string): void {
    this.db.prepare(`INSERT INTO transfer_execution_items(run_id,item_id,data)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM transfer_runs WHERE id=? AND owner_token=?)
      ON CONFLICT(run_id,item_id) DO UPDATE SET data=excluded.data`)
      .run(runId, item.itemId, JSON.stringify(item), runId, token)
  }
  results(runId: string): StoredTransferResult[] {
    return (this.db.prepare('SELECT data FROM transfer_execution_items WHERE run_id=? ORDER BY rowid').all(runId) as JsonRow[]).map(row => JSON.parse(row.data) as StoredTransferResult)
  }
  summarizeRun(id: string, token?: string): TransferRun {
    const results = this.results(id)
    return this.patchRun(id, { succeeded: results.filter(item => item.status === 'success').length, skipped: results.filter(item => item.status === 'skipped').length,
      failed: results.filter(item => item.status === 'failed').length, uncertain: results.filter(item => item.status === 'uncertain').length }, token)
  }
}
