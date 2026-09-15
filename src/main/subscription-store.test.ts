import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubscriptionStore } from './subscription-store'
import type { ShareSubscriptionInput, SubscriptionEntry } from '../shared/subscription-types'

let db: Database.Database
const input: ShareSubscriptionInput = { accountId: 'a', platform: 'quark', url: 'https://pan.quark.cn/s/fixture', targetDirId: 'target' }
const entry: SubscriptionEntry = { fileId: 'new', name: 'new', parentId: '0', relativePath: 'new', isDir: false }
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys=ON') })
afterEach(() => db.close())

describe('versioned subscription persistence', () => {
  it('migrates legacy baselines once, preserves paused intent and recovers temporary errors', () => {
    db.exec(`CREATE TABLE share_subscriptions(id,account_id,platform,url,target_dir_id,status,last_signature,seen_file_ids);
      INSERT INTO share_subscriptions VALUES('legacy','a','quark','https://pan.quark.cn/s/fixture','0','paused','signature','["old"]');
      INSERT INTO share_subscriptions VALUES('error','a','quark','https://pan.quark.cn/s/fixture','0','error','signature','["old"]');`)
    const first = new SubscriptionStore(db)
    expect(first.get('legacy')).toMatchObject({ configVersion: 1, status: 'paused', scope: 'root', baselineComplete: true })
    expect(first.get('error')?.status).toBe('active')
    expect(first.observations('legacy')[0].fileId).toBe('old')
    first.remove('legacy')
    const reopened = new SubscriptionStore(db)
    expect(reopened.get('legacy')).toBeUndefined()
    expect(reopened.list()).toHaveLength(1)
  })
  it('keeps only one active run per config version across independent service instances', () => {
    const first = new SubscriptionStore(db); const second = new SubscriptionStore(db)
    const config = first.save(input)
    const run = first.createRun(config, [entry], [])!
    expect(second.createRun(config, [entry], [])?.id).toBe(run.id)
  })
  it('rejects stale success after changing the target and leaves its operation evidence separate', () => {
    const store = new SubscriptionStore(db); const config = store.save(input)
    const run = store.createRun(config, [entry], [])!
    store.save({ ...input, id: config.id, expectedVersion: 1, targetDirId: 'another' })
    expect(store.commitRun(run.id, 10)).toBe(false)
    expect(store.observations(config.id)).toEqual([])
    expect(store.getRun(run.id)?.state).toBe('superseded')
  })
  it('does not advance a paused cursor and commits successfully only after resume', () => {
    const store = new SubscriptionStore(db); const config = store.save(input)
    const run = store.createRun(config, [entry], [])!
    store.patch(config.id, 1, { status: 'paused' })
    expect(store.commitRun(run.id, 10)).toBe(false)
    expect(store.observations(config.id)).toEqual([])
    store.patch(config.id, 1, { status: 'active' })
    expect(store.commitRun(run.id, 10)).toBe(true)
    expect(store.observations(config.id)).toEqual([entry])
  })
  it('requires every work item to succeed and retains disappeared IDs in the observed set', () => {
    const store = new SubscriptionStore(db); const config = store.save(input)
    const run = store.createRun(config, [entry], [{ id: 'work', parentId: '0', targetRelativePath: '', entries: [entry], kind: 'save' }])!
    expect(store.commitRun(run.id, 10)).toBe(false)
    store.completeWork(run.id, 'work', 1)
    expect(store.commitRun(run.id, 10)).toBe(true)
    store.commitBaseline(store.get(config.id)!, [], 10)
    expect(store.observations(config.id)).toEqual([entry])
  })
  it('keeps a completed run immutable when a stale queue attachment arrives later', () => {
    const store = new SubscriptionStore(db); const config = store.save(input)
    const oldRun = store.createRun(config, [entry], [])!
    expect(store.commitRun(oldRun.id, 10)).toBe(true)
    store.updateRun({ ...oldRun, state: 'pending', taskId: 'late-task' })
    expect(store.getRun(oldRun.id)?.state).toBe('success')
    expect(store.activeRun(config.id, config.configVersion)).toBeUndefined()
  })
})
