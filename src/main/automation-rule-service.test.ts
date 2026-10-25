import Database from 'better-sqlite3'
import fs from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationActionOption, AutomationRule, AutomationTrigger } from '../shared/automation-rules'
import type { TaskStatus } from '../shared/types'
import { AutomationRuleService, nextAutomationTime, type AutomationRuleDependencies } from './automation-rule-service'
import { AutomationRuleStore, initializeAutomationRuleSchema } from './automation-rule-store'
import { taskPayloadWithAutomationOrigin, withAutomationOrigin } from './automation-origin'

let directory: string, db: Database.Database, store: AutomationRuleStore, service: AutomationRuleService, now: number, sequence: number
let dependencies: AutomationRuleDependencies
let options: AutomationActionOption[]
function task(id: string) {
  return db.prepare('SELECT id,status,summary FROM fixture_tasks WHERE id=?').get(id) as { id: string; status: TaskStatus; summary?: string } | undefined
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-rules-'))
  db = new Database(path.join(directory, 'rules.db')); db.pragma('foreign_keys = ON')
  initializeAutomationRuleSchema(db)
  db.exec('CREATE TABLE fixture_tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,payload TEXT NOT NULL,summary TEXT)')
  now = new Date(2026, 8, 9, 10, 0).getTime(); sequence = 0
  options = [{ kind: 'migration', planId: 'migration', planVersion: 1, name: '迁移' }, { kind: 'backup', planId: 'backup', planVersion: 1, name: '备份' }]
  dependencies = {
    listActions: vi.fn(async () => options),
    prepare: vi.fn(async () => ({ executable: true, previewId: 'preview', itemCount: 10, writeCount: 10, transferBytes: 400, summary: '10项已核对' })),
    execute: vi.fn(async action => {
      const id = `task-${++sequence}`
      const payload = taskPayloadWithAutomationOrigin(action.kind === 'migration' ? 'planned_transfer' : 'file_backup', {})
      db.prepare("INSERT INTO fixture_tasks(id,status,payload) VALUES(?,'pending',?)").run(id, JSON.stringify(payload))
      return { taskId: id }
    }), task,
    findTaskByRun: id => {
      const row = db.prepare("SELECT id FROM fixture_tasks WHERE json_extract(payload,'$._automation.runId')=?").get(id) as { id: string } | undefined
      return row ? task(row.id) : undefined
    },
  }
  store = new AutomationRuleStore(db, () => now); service = new AutomationRuleService(store, dependencies)
})
afterEach(async () => {
  service.dispose(); await service.waitForIdle(); db.close()
  const checked = path.resolve(directory)
  if (path.dirname(checked) !== path.resolve(os.tmpdir()) || !path.basename(checked).startsWith('panlite-rules-')) throw new Error('Invalid cleanup path')
  fs.rmSync(checked, { recursive: true, force: true })
})
async function rule(trigger: AutomationTrigger = { kind: 'manual' }, kind: 'migration' | 'backup' = 'migration'): Promise<AutomationRule> {
  const saved = await service.saveRule({ name: 'test', enabled: true, trigger, action: { kind, planId: kind, planVersion: 1 } })
  if (!saved.success) throw new Error(saved.error)
  return saved.rule
}

describe('durable rules reuse the original task queue', () => {
  it('dry-runs the plan with no queue writes or success cursor advancement', async () => {
    const created = await rule()
    expect(await service.dryRun(created.id)).toMatchObject({ success: true, preview: { writeCount: 10 } })
    expect(dependencies.prepare).toHaveBeenCalledTimes(1); expect(dependencies.execute).not.toHaveBeenCalled()
    expect(store.runs(created.id)).toEqual([]); expect(store.get(created.id)?.lastSuccessAt).toBeUndefined()
  })
  it('coalesces missed intervals into one task and advances only after full task success', async () => {
    const created = await rule({ kind: 'interval', everyMinutes: 5, missed: 'run_once' })
    now += 95 * 60_000
    await Promise.all([service.tick(), service.tick()]); await service.tick()
    expect(dependencies.execute).toHaveBeenCalledTimes(1)
    expect(store.get(created.id)?.lastSuccessAt).toBeUndefined()
    db.prepare("UPDATE fixture_tasks SET status='success'").run()
    await service.tick()
    expect(store.get(created.id)?.lastSuccessAt).toBe(now)
    expect(store.get(created.id)?.nextRunAt).toBe(now + 5 * 60_000)
    expect(dependencies.execute).toHaveBeenCalledTimes(1)
  })
  it('skips missed times under the explicit skip policy', async () => {
    const created = await rule({ kind: 'interval', everyMinutes: 5, missed: 'skip' }); now += 60 * 60_000
    await service.tick(); expect(dependencies.execute).not.toHaveBeenCalled()
    expect(store.get(created.id)?.nextRunAt).toBe(now + 5 * 60_000)
  })
  it('rejects a stale manual confirmation before claiming or submitting a run', async () => {
    const created = await rule()
    const updated = await service.setEnabled({ id: created.id, expectedVersion: created.version, enabled: false })
    expect(updated.success).toBe(true)
    const result = await service.runNow({ id: created.id, expectedVersion: created.version })
    expect(result).toMatchObject({ success: false, code: 'RULE_VERSION' })
    expect(store.runs(created.id)).toEqual([]); expect(dependencies.execute).not.toHaveBeenCalled()
  })
  it('stops preparation from submitting a task when the user pauses the rule', async () => {
    const created = await rule(); let resolve!: (value: Awaited<ReturnType<AutomationRuleDependencies['prepare']>>) => void
    dependencies.prepare = vi.fn(() => new Promise<Awaited<ReturnType<AutomationRuleDependencies['prepare']>>>(done => { resolve = done }))
    expect((await service.runNow(created.id)).success).toBe(true)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await service.setEnabled({ id: created.id, expectedVersion: created.version, enabled: false })
    resolve({ executable: true, previewId: 'preview', summary: 'ready', itemCount: 1, writeCount: 1, transferBytes: 1 })
    await service.waitForIdle()
    expect(dependencies.execute).not.toHaveBeenCalled(); expect(store.get(created.id)?.enabled).toBe(false)
  })
  it('requires a new plan version selection and refuses unresolved previews', async () => {
    const created = await rule(); options[0].planVersion = 2
    await service.runNow(created.id); await service.waitForIdle()
    expect(dependencies.execute).not.toHaveBeenCalled(); expect(store.get(created.id)?.error).toContain('计划已变化')
    const second = await rule({ kind: 'manual' }, 'backup')
    dependencies.prepare = vi.fn(async () => ({ executable: false, summary: '2项待核对', itemCount: 2, writeCount: 0, transferBytes: 0 }))
    await service.runNow(second.id); await service.waitForIdle()
    expect(store.runs(second.id)[0]).toMatchObject({ status: 'attention', summary: '2项待核对' })
  })
  it('rejects direct and indirect rule cycles and refuses removal of a referenced rule', async () => {
    const first = await rule(), second = await rule({ kind: 'task_success', sourceRuleId: first.id })
    const update = await service.saveRule({ ...first, expectedVersion: first.version, trigger: { kind: 'task_success', sourceRuleId: second.id } })
    expect(update).toMatchObject({ success: false, code: 'RULE_CYCLE' })
    expect(await service.removeRule(first.id)).toMatchObject({ success: false })
  })
  it('fires downstream rules only once for a fully successful source execution', async () => {
    const first = await rule(), second = await rule({ kind: 'task_success', sourceRuleId: first.id }, 'backup')
    await service.runNow(first.id); await service.waitForIdle(); await service.tick()
    expect(dependencies.execute).toHaveBeenCalledTimes(1)
    db.prepare("UPDATE fixture_tasks SET status='success' WHERE id='task-1'").run(); now++
    await service.tick(); await service.tick()
    expect(dependencies.execute).toHaveBeenCalledTimes(2)
    expect(store.runs(second.id)).toHaveLength(1)
    db.prepare("UPDATE fixture_tasks SET status='partial_success' WHERE id='task-2'").run(); await service.tick()
    expect(store.get(second.id)?.lastSuccessAt).toBeUndefined(); expect(store.get(second.id)?.enabled).toBe(false)
  })
  it('recovers a task committed before the dispatch acknowledgement and does not enqueue it again', async () => {
    const created = await rule(); const execute = dependencies.execute
    dependencies.execute = async (...args) => { const result = await execute(...args); service.dispose(); return result }
    await service.runNow(created.id); await service.waitForIdle()
    expect(store.runs(created.id)[0].status).toBe('dispatching')
    db.close(); db = new Database(path.join(directory, 'rules.db')); store = new AutomationRuleStore(db, () => now)
    service = new AutomationRuleService(store, dependencies); service.recover(); await service.tick()
    expect(store.runs(created.id)[0]).toMatchObject({ status: 'running', taskId: 'task-1' })
    expect(execute).toHaveBeenCalledTimes(1)
    db.prepare("UPDATE fixture_tasks SET status='success'").run(); service.reconcile()
    expect(store.runs(created.id)[0].status).toBe('success')
  })
  it('marks an interrupted preparation for attention and lets an independent rule continue', async () => {
    const first = await rule({ kind: 'interval', everyMinutes: 5, missed: 'run_once' })
    const second = await rule({ kind: 'interval', everyMinutes: 5, missed: 'run_once' }, 'backup')
    store.claim(first, 'time:interrupted'); service.recover(); now += 5 * 60_000
    await service.tick()
    expect(store.get(first.id)?.enabled).toBe(false); expect(store.runs(first.id)[0].status).toBe('attention')
    expect(store.runs(second.id)[0].status).toBe('running'); expect(dependencies.execute).toHaveBeenCalledTimes(1)
  })
  it('keeps scheduling and reconciling independent rules while a real HTTP preparation is pending', async () => {
    const preview = JSON.stringify({ executable: true, previewId: 'http-preview', itemCount: 1, writeCount: 1, transferBytes: 4, summary: 'ready' })
    let hold = true, heldResponse: ServerResponse | undefined
    const requests: string[] = [], ticks: Promise<void>[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/migration' && hold) heldResponse = response
      else response.end(preview)
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind')
    dependencies.prepare = async action => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${action.kind}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }
    try {
      const slow = await rule({ kind: 'interval', everyMinutes: 5, missed: 'run_once' })
      const independent = await rule({ kind: 'interval', everyMinutes: 10, missed: 'run_once' }, 'backup')
      now += 5 * 60_000
      ticks.push(service.tick())
      await vi.waitFor(() => expect(requests).toEqual(['/migration']))
      now += 5 * 60_000
      ticks.push(service.tick(), service.tick())
      await vi.waitFor(() => expect(store.runs(independent.id)[0]?.status).toBe('running'))
      expect(store.runs(slow.id)).toHaveLength(1)
      expect(store.runs(slow.id)[0].status).toBe('preparing')
      expect(requests.filter(url => url === '/migration')).toHaveLength(1)
      db.prepare("UPDATE fixture_tasks SET status='success'").run()
      ticks.push(service.tick())
      expect(store.runs(independent.id)[0].status).toBe('success')
      expect(store.get(independent.id)?.lastSuccessAt).toBe(now)
      expect(store.get(independent.id)?.nextRunAt).toBe(now + 10 * 60_000)
      expect(requests.filter(url => url === '/backup')).toHaveLength(1)
    } finally {
      hold = false; heldResponse?.end(preview)
      await Promise.allSettled(ticks)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
    }
  })
  it('never trusts renderer-supplied automation provenance and attaches it to only the primary task', async () => {
    expect(taskPayloadWithAutomationOrigin('file_backup', { _automation: { runId: 'forged' }, planId: 'x' })).toEqual({ planId: 'x' })
    const result = await withAutomationOrigin({ ruleId: 'r', runId: 'e', taskType: 'file_backup' }, async () => [
      taskPayloadWithAutomationOrigin('upload', {}), taskPayloadWithAutomationOrigin('file_backup', {}), taskPayloadWithAutomationOrigin('file_backup', {}),
    ])
    expect(result).toEqual([{}, { _automation: { ruleId: 'r', runId: 'e' } }, {}])
  })
  it('calculates daily runs in the machine local time and advances to the next day after the slot', () => {
    const next = nextAutomationTime({ kind: 'daily', time: '09:30', missed: 'skip' }, now)!
    expect(new Date(next).getHours()).toBe(9); expect(new Date(next).getMinutes()).toBe(30)
    expect(new Date(next).getDate()).toBe(new Date(now).getDate() + 1)
  })

  it('rejects a queue write after the rule is paused during asynchronous execute validation', async () => {
    const created = await rule(); let release!: () => void
    const execute = dependencies.execute
    dependencies.execute = vi.fn(async (...args: Parameters<AutomationRuleDependencies['execute']>) => { await new Promise<void>(resolve => { release = resolve }); return execute(...args) })
    await service.runNow(created.id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(store.runs(created.id)[0].status).toBe('dispatching')
    await service.setEnabled({ id: created.id, expectedVersion: created.version, enabled: false })
    release(); await service.waitForIdle()
    expect(db.prepare('SELECT COUNT(*) count FROM fixture_tasks').get()).toEqual({ count: 0 })
    expect(store.get(created.id)?.enabled).toBe(false); expect(store.runs(created.id)[0].status).toBe('attention')
  })

  it('does not let an old preparation failure disable a newly re-enabled rule version', async () => {
    const created = await rule(); let release!: () => void
    dependencies.prepare = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { executable: true, previewId: 'preview', itemCount: 1, writeCount: 1, transferBytes: 1, summary: 'ready' }
    })
    await service.runNow(created.id); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const paused = await service.setEnabled({ id: created.id, expectedVersion: created.version, enabled: false }); if (!paused.success) throw new Error(paused.error)
    const resumed = await service.setEnabled({ id: created.id, expectedVersion: paused.rule.version, enabled: true }); if (!resumed.success) throw new Error(resumed.error)
    release(); await service.waitForIdle()
    expect(dependencies.execute).not.toHaveBeenCalled()
    expect(store.get(created.id)).toMatchObject({ enabled: true, version: resumed.rule.version }); expect(store.get(created.id)?.error).toBeUndefined()
    expect(store.runs(created.id)[0].status).toBe('failed')
  })

  it('does not admit work from a disposed or expired asynchronous automation origin', async () => {
    const created = await rule(); let release!: () => void
    const execute = dependencies.execute
    dependencies.execute = vi.fn(async (...args: Parameters<AutomationRuleDependencies['execute']>) => { await new Promise<void>(resolve => { release = resolve }); return execute(...args) })
    await service.runNow(created.id); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    service.dispose(); release(); await service.waitForIdle()
    expect(db.prepare('SELECT COUNT(*) count FROM fixture_tasks').get()).toEqual({ count: 0 })
    let late!: Promise<Record<string, unknown>>; let finish!: () => void
    await withAutomationOrigin({ ruleId: 'r', runId: 'e', taskType: 'file_backup' }, async () => {
      late = new Promise<void>(resolve => { finish = resolve }).then(() => taskPayloadWithAutomationOrigin('file_backup', {}))
    })
    finish(); await expect(late).rejects.toThrow('RULE_DISABLED')
  })
})
