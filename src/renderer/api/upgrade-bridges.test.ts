// @vitest-environment jsdom
import { reactive } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { serialize } from 'node:v8'
import type { CatalogApi, CatalogQuery } from '@shared/catalog'
import type { TransferPlanInput, TransferPlansApi } from '@shared/transfer-plan'
import { catalogApi } from './catalog'
import { transferPlansApi } from './transfer-plans'

afterEach(() => { vi.unstubAllGlobals() })

it('serializes nested reactive catalog filters at the renderer boundary', async () => {
  const query = reactive<CatalogQuery>({ keyword: '合同', tags: ['项目'], accountIds: ['source'], minSize: undefined })
  const search = vi.fn(async (input: CatalogQuery) => { serialize(input); return { success: true, total: 0, entries: [], page: 1, pageSize: 50 } })
  vi.stubGlobal('catalogAPI', { search } as unknown as CatalogApi)
  await expect(catalogApi.search(query)).resolves.toMatchObject({ success: true })
  expect(search.mock.calls[0][0]).toEqual(query)
  expect(search.mock.calls[0][0].tags).not.toBe(query.tags)
})

it('serializes reactive locations, exclusions and decisions for saved plans', async () => {
  const input = reactive<TransferPlanInput>({ name: '项目', source: { accountId: 'a', rootId: '0', rootPath: '/' },
    target: { accountId: 'b', rootId: '0', rootPath: '/' }, exclude: ['**/*.tmp'], conflictPolicy: 'skip' })
  const savePlan = vi.fn(async (data: TransferPlanInput) => { serialize(data); return { success: false, error: 'fixture' } })
  const resolvePreview = vi.fn(async (data: unknown) => { serialize(data); return { success: false, error: 'fixture' } })
  vi.stubGlobal('transferPlansAPI', { savePlan, resolvePreview } as unknown as TransferPlansApi)
  await transferPlansApi.savePlan(input)
  await transferPlansApi.resolvePreview(reactive({ previewId: 'preview', decisions: [{ itemId: 'file', action: 'rename' as const }] }))
  expect(savePlan.mock.calls[0][0]).toEqual(input)
  expect(resolvePreview).toHaveBeenCalledOnce()
})
