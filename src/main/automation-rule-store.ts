import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AutomationRule, AutomationRuleInput, AutomationRun } from '../shared/automation-rules'

interface JsonRow { data: string }
export function initializeAutomationRuleSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_rules(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automation_rule_runs(id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      event_key TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(rule_id,event_key));
    CREATE INDEX IF NOT EXISTS automation_rule_runs_status ON automation_rule_runs(status);
    CREATE INDEX IF NOT EXISTS automation_rule_runs_rule ON automation_rule_runs(rule_id,created_at);
  `)
}

export class AutomationRuleStore {
  constructor(readonly db: Database.Database, readonly now: () => number = Date.now) {}
  list(): AutomationRule[] { return (this.db.prepare('SELECT data FROM automation_rules ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.data)) }
  get(id: string): AutomationRule | undefined { const row = this.db.prepare('SELECT data FROM automation_rules WHERE id=?').get(id) as JsonRow | undefined; return row ? JSON.parse(row.data) : undefined }
  active(ruleId: string): boolean { return !!this.db.prepare("SELECT 1 FROM automation_rule_runs WHERE rule_id=? AND status IN ('preparing','dispatching','running') LIMIT 1").get(ruleId) }
  save(input: AutomationRuleInput, nextRunAt?: number): AutomationRule {
    return this.db.transaction(() => {
      const old = input.id ? this.get(input.id) : undefined
      if (input.id && !old) throw new Error('RULE_MISSING')
      if (old && old.version !== input.expectedVersion) throw new Error('RULE_VERSION')
      if (old && this.active(old.id)) throw new Error('RULE_BUSY')
      const rule: AutomationRule = { id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, name: input.name, enabled: input.enabled,
        action: input.action, trigger: input.trigger, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now(), nextRunAt,
        lastRunId: old?.lastRunId, lastSuccessAt: old?.lastSuccessAt, triggerSince: this.now() }
      this.put(rule); return rule
    }).immediate()
  }
  put(rule: AutomationRule): void { this.db.prepare('INSERT INTO automation_rules(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(rule.id, JSON.stringify(rule)) }
  remove(id: string): void { this.db.prepare('DELETE FROM automation_rules WHERE id=?').run(id) }
  run(id: string): AutomationRun | undefined { const row = this.db.prepare('SELECT data FROM automation_rule_runs WHERE id=?').get(id) as JsonRow | undefined; return row ? JSON.parse(row.data) : undefined }
  findEvent(ruleId: string, eventKey: string): AutomationRun | undefined {
    const row = this.db.prepare('SELECT data FROM automation_rule_runs WHERE rule_id=? AND event_key=?').get(ruleId, eventKey) as JsonRow | undefined
    return row ? JSON.parse(row.data) : undefined
  }
  claim(rule: AutomationRule, eventKey: string): AutomationRun {
    return this.db.transaction(() => {
      const previous = this.findEvent(rule.id, eventKey)
      if (previous) return previous
      const current = this.get(rule.id)
      if (!current || !current.enabled || current.version !== rule.version) throw new Error('RULE_DISABLED')
      if (this.active(rule.id)) throw new Error('RULE_BUSY')
      const run: AutomationRun = { id: randomUUID(), ruleId: rule.id, ruleVersion: rule.version, eventKey, status: 'preparing', action: rule.action,
        createdAt: this.now(), updatedAt: this.now() }
      this.db.prepare('INSERT INTO automation_rule_runs(id,rule_id,event_key,status,created_at,data) VALUES(?,?,?,?,?,?)')
        .run(run.id, run.ruleId, eventKey, run.status, run.createdAt, JSON.stringify(run))
      this.put({ ...current, lastRunId: run.id, updatedAt: this.now() }); return run
    }).immediate()
  }
  patchRun(id: string, patch: Partial<AutomationRun>): AutomationRun {
    const old = this.run(id)
    if (!old) throw new Error('RUN_MISSING')
    const run = { ...old, ...patch, id: old.id, ruleId: old.ruleId, updatedAt: this.now() }
    this.db.prepare('UPDATE automation_rule_runs SET status=?,data=? WHERE id=?').run(run.status, JSON.stringify(run), id)
    return run
  }
  activeRuns(): AutomationRun[] { return (this.db.prepare("SELECT data FROM automation_rule_runs WHERE status IN ('preparing','dispatching','running')").all() as JsonRow[]).map(row => JSON.parse(row.data)) }
  runs(ruleId: string): AutomationRun[] { return (this.db.prepare('SELECT data FROM automation_rule_runs WHERE rule_id=? ORDER BY created_at DESC,rowid DESC').all(ruleId) as JsonRow[]).map(row => JSON.parse(row.data)) }
}
