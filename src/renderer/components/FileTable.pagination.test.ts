// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { computed, defineComponent, h, inject, provide, type ComputedRef } from 'vue'
import { getPlatformCapabilities } from '@shared/capabilities'
import type { FileItem } from '@shared/types'
import FileTable from './FileTable.vue'

const pageRowsKey = Symbol('visible table rows')
const PagedTable = defineComponent({ name: 'ElTable', props: ['data', 'defaultSort'], setup(props, { slots }) {
  provide(pageRowsKey, computed(() => props.data as FileItem[]))
  return () => h('div', slots.default?.())
} })
const PagedColumn = defineComponent({ name: 'ElTableColumn', props: ['label', 'columnKey', 'width'], setup(props, { slots }) {
  const visible = inject<ComputedRef<FileItem[]>>(pageRowsKey)!
  return () => props.columnKey === 'selection'
    ? h('section', [slots.header?.(), ...visible.value.map(row => h('div', { key: row.id, 'data-select-row': row.id }, slots.default?.({ row })))])
    : props.columnKey === 'name'
      ? h('section', visible.value.map(row => h('div', { key: row.id, 'data-rendered-file': row.id }, slots.default?.({ row })))) : null
} })
const PagedCheckbox = defineComponent({ name: 'ElCheckbox', props: ['modelValue', 'disabled', 'indeterminate', 'ariaLabel'], emits: ['change'],
  template: '<input type="checkbox" :checked="modelValue" :disabled="disabled" :aria-label="ariaLabel" :data-indeterminate="!!indeterminate" @change="$emit(\'change\', $event.target.checked)" />',
})
const largeDirectory: FileItem[] = Array.from({ length: 100_000 }, (_, index) => ({ id: String(index + 1), name: `file-${index + 1}.txt`,
  accountId: 'account', platform: 'quark', parentId: '0', isDir: false, size: index + 1, createdAt: 0, updatedAt: 0 }))
const views: VueWrapper[] = []
afterEach(() => { views.splice(0).forEach(view => view.unmount()); localStorage.removeItem('panlite:file-table-layout:v1') })
function render(files = largeDirectory, extra: Record<string, unknown> = {}) {
  const view = mount(FileTable, { props: { files, capabilities: getPlatformCapabilities('quark'), ...extra }, global: {
    directives: { loading: () => {} }, stubs: { ElTable: PagedTable, ElTableColumn: PagedColumn, ElCheckbox: PagedCheckbox },
  } })
  views.push(view)
  return view
}
const selected = (view: VueWrapper) => (view.emitted('selectionChange')?.slice(-1)[0]?.[0] || []) as FileItem[]
const shown = (view: VueWrapper) => view.findComponent({ name: 'ElTable' }).props('data') as FileItem[]

describe('bounded file table pages and complete selection', () => {
  it('renders 100 of 100000 files and opens the last item without truncating the data', async () => {
    const view = render()
    expect(shown(view)).toHaveLength(100)
    expect(view.findAll('[data-rendered-file]')).toHaveLength(100)
    expect(view.get('.page-range').text()).toBe('显示 1–100 / 共 100000 项')
    await view.get('[aria-label="文件末页"]').trigger('click')
    expect(shown(view).map(row => row.id)).toEqual(largeDirectory.slice(-100).map(row => row.id))
    await view.get('[data-rendered-file="100000"] button').trigger('click')
    expect(view.emitted('preview')?.[0]?.[0]).toMatchObject({ id: '100000', name: 'file-100000.txt' })
    expect(view.get('.page-range').text()).toBe('显示 99901–100000 / 共 100000 项')
  })
  it('sorts the complete data before paging and keeps the original provider order intact', async () => {
    const view = render()
    const table = view.findComponent({ name: 'ElTable' })
    table.vm.$emit('sort-change', { prop: 'size', order: 'descending' }); await view.vm.$nextTick()
    expect(shown(view)[0].id).toBe('100000')
    await view.get('[aria-label="文件末页"]').trigger('click')
    expect(shown(view)[99].id).toBe('1')
    expect(largeDirectory[0].id).toBe('1')
    expect(largeDirectory[99_999].id).toBe('100000')
    table.vm.$emit('sort-change', { prop: 'size', order: null }); await view.vm.$nextTick()
    expect(shown(view)[0].id).toBe('1')
  })
  it('supports 200 rows, direct page input and clamps the page when the list shrinks', async () => {
    const view = render()
    await view.get('[aria-label="每页文件数量"]').setValue('200')
    expect(shown(view)).toHaveLength(200)
    expect(view.findAll('[data-rendered-file]')).toHaveLength(200)
    await view.get('[aria-label="文件页码"]').setValue('999999')
    expect((view.get('[aria-label="文件页码"]').element as HTMLInputElement).value).toBe('500')
    expect(shown(view)[199].id).toBe('100000')
    await view.setProps({ files: largeDirectory.slice(0, 15) })
    expect(shown(view)).toHaveLength(15)
    expect((view.get('[aria-label="文件页码"]').element as HTMLInputElement).value).toBe('1')
    await view.get('[aria-label="文件页码"]').setValue('0')
    expect(shown(view)[0].id).toBe('1')
    await view.setProps({ files: [] })
    expect(view.get('.page-range').text()).toBe('显示 0–0 / 共 0 项')
    expect(view.get('[aria-label="文件末页"]').attributes('disabled')).toBeDefined()
  })
  it('preserves cross-page selection and sorting while the header changes only the current page', async () => {
    const view = render()
    await view.get('[data-select-row="1"] input').setValue(true)
    await view.get('[aria-label="文件下一页"]').trigger('click')
    await view.get('[data-select-row="101"] input').setValue(true)
    expect(selected(view).map(row => row.id)).toEqual(['1', '101'])
    await view.get('input[aria-label="仅选择本页文件"]').setValue(true)
    expect(selected(view)).toHaveLength(101)
    expect(selected(view).some(row => row.id === '1')).toBe(true)
    await view.get('input[aria-label="仅选择本页文件"]').setValue(false)
    expect(selected(view).map(row => row.id)).toEqual(['1'])
    view.findComponent({ name: 'ElTable' }).vm.$emit('sort-change', { prop: 'size', order: 'descending' }); await view.vm.$nextTick()
    expect(selected(view).map(row => row.id)).toEqual(['1'])
    await view.get('[aria-label="文件末页"]').trigger('click')
    expect((view.get('[data-select-row="1"] input').element as HTMLInputElement).checked).toBe(true)
    view.findComponent({ name: 'ElTable' }).vm.$emit('selection-change', []); await view.vm.$nextTick()
    expect(selected(view).map(row => row.id)).toEqual(['1'])
  })
  it('explicitly selects all 100000 files, keeps rendering bounded, and clears every page', async () => {
    const view = render()
    const all = view.findAll('.page-selection-scope button')[0]
    expect(all.text()).toBe('选择全部 100000 项')
    await all.trigger('click')
    expect(selected(view)).toHaveLength(100_000)
    expect(selected(view)[0].id).toBe('1')
    expect(selected(view)[99_999].id).toBe('100000')
    expect(shown(view)).toHaveLength(100)
    await view.get('[aria-label="文件末页"]').trigger('click')
    expect(view.text()).toContain('已选 100000 项（跨页保留）')
    expect((view.get('[data-select-row="100000"] input').element as HTMLInputElement).checked).toBe(true)
    await view.findAll('.page-selection-scope button')[1].trigger('click')
    expect(selected(view)).toEqual([])
    expect((view.get('[data-select-row="100000"] input').element as HTMLInputElement).checked).toBe(false)
  })
  it('synchronizes parent selection clearing and resets page/selection for another query context', async () => {
    const view = render(largeDirectory, { selectedFiles: [], selectionContext: 'account:root' })
    await view.get('[data-select-row="1"] input').setValue(true)
    await view.setProps({ selectedFiles: selected(view) })
    await view.setProps({ selectedFiles: [] })
    expect((view.get('[data-select-row="1"] input').element as HTMLInputElement).checked).toBe(false)
    await view.get('[data-select-row="1"] input').setValue(true)
    await view.setProps({ selectedFiles: selected(view) })
    await view.get('[aria-label="文件末页"]').trigger('click')
    await view.setProps({ selectionContext: 'account:other-directory', selectedFiles: [] })
    expect(shown(view)[0].id).toBe('1')
    expect(view.text()).toContain('已选 0 项（跨页保留）')
    expect((view.get('[data-select-row="1"] input').element as HTMLInputElement).checked).toBe(false)
  })
  it('prunes deleted selections and rejects matching IDs belonging to a different account', async () => {
    const view = render(largeDirectory.slice(0, 3))
    await view.get('[data-select-row="1"] input').setValue(true)
    await view.setProps({ files: largeDirectory.slice(1, 3) })
    expect(selected(view)).toEqual([])
    await view.get('[data-select-row="2"] input').setValue(true)
    await view.setProps({ files: [{ ...largeDirectory[1], accountId: 'another-account' }] })
    expect(selected(view)).toEqual([])
    expect(view.text()).toContain('已选 0 项')
  })
  it('disables row/page/all selection and page navigation while loading', async () => {
    const view = render(largeDirectory.slice(0, 300), { loading: true })
    expect(view.findAll('input[type="checkbox"]').every(input => input.attributes('disabled') !== undefined)).toBe(true)
    expect(view.findAll('.file-table-pagination button').every(button => button.attributes('disabled') !== undefined)).toBe(true)
    view.findComponent({ name: 'ElCheckbox' }).vm.$emit('change', true); await view.vm.$nextTick()
    expect(view.emitted('selectionChange')).toBeUndefined()
    expect(view.text()).toContain('已选 0 项')
  })
  it('keeps the real Element Plus DOM bounded and synchronizes actual checkboxes across pages', async () => {
    const view = mount(FileTable, { props: { files: largeDirectory, capabilities: getPlatformCapabilities('quark') },
      global: { directives: { loading: () => {} } } })
    views.push(view)
    await flushPromises()
    expect(view.findAll('.el-table__body tbody tr')).toHaveLength(100)
    await view.get('[aria-label="选择文件：file-1.txt"] input').setValue(true)
    await view.get('[aria-label="文件末页"]').trigger('click'); await flushPromises()
    expect(view.findAll('.el-table__body tbody tr')).toHaveLength(100)
    await view.get('[aria-label="仅选择本页文件"] input').setValue(true)
    expect(selected(view)).toHaveLength(101)
    await view.get('[aria-label="文件首页"]').trigger('click'); await flushPromises()
    expect((view.get('[aria-label="选择文件：file-1.txt"] input').element as HTMLInputElement).checked).toBe(true)
    expect((view.get('[aria-label="选择文件：file-2.txt"] input').element as HTMLInputElement).checked).toBe(false)
    await view.setProps({ loading: true })
    expect(view.get('[aria-label="仅选择本页文件"] input').attributes('disabled')).toBeDefined()
  }, 20_000)
})
