// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { getPlatformCapabilities } from '@shared/capabilities'
import type { FileItem } from '@shared/types'
import FileTable from './FileTable.vue'

const file = (name: string, isDir = false): FileItem => ({ id: name, name, isDir, accountId: 'account', platform: 'quark', parentId: '0', size: 42, createdAt: 0, updatedAt: 0 })
const caps = getPlatformCapabilities('quark')
const rows = [file('movie.mp4'), file('notes.srt'), file('unknown.bin'), file('folder', true)]
afterEach(() => localStorage.removeItem('panlite:file-table-layout:v1'))

function render(downloadFile = true) {
  return mount(FileTable, { props: { files: rows, capabilities: { ...caps, downloadFile } }, global: {
    directives: { loading: () => {} },
    stubs: {
      ElTable: { name: 'ElTable', props: ['data', 'defaultSort'], template: '<div><slot /></div>' },
      ElTableColumn: { name: 'ElTableColumn', props: ['label', 'width'], setup: () => ({ rows }), template: '<section v-if="label === \'操作\'"><div v-for="row in rows" :key="row.id" :data-file="row.name"><slot :row="row" /></div></section>' },
    },
  } })
}

describe('file preview entry points', () => {
  it('previews playable and subtitle files on double click while preserving folder navigation', () => {
    const view = render()
    const table = view.findComponent({ name: 'ElTable' })
    for (const row of rows) table.vm.$emit('row-dblclick', row)
    expect(view.emitted('preview')).toEqual([[rows[0]], [rows[1]]])
    expect(view.emitted('enter')).toEqual([[rows[3]]])
    view.unmount()
  })

  it('disables unsupported file formats and labels media as online playback', async () => {
    const view = render()
    expect(view.get('[data-file="unknown.bin"] button').attributes('disabled')).toBeDefined()
    const play = view.get('[data-file="movie.mp4"] button')
    expect(play.attributes('title')).toBe('在线播放')
    await play.trigger('click')
    expect(view.emitted('preview')).toEqual([[rows[0]]])
    view.unmount()
  })

  it('blocks clicks and double clicks when the provider cannot download', async () => {
    const view = render(false)
    const play = view.get('[data-file="movie.mp4"] button')
    expect(play.attributes('disabled')).toBeDefined()
    await play.trigger('click')
    view.findComponent({ name: 'ElTable' }).vm.$emit('row-dblclick', rows[0])
    expect(view.emitted('preview')).toBeUndefined()
    view.unmount()
  })
})

describe('remembered file table layout', () => {
  it('sorts locally with directories first, preserves input order and restores provider order when cleared', async () => {
    const view = render()
    const table = view.findComponent({ name: 'ElTable' })
    table.vm.$emit('sort-change', { prop: 'name', order: 'descending' })
    await view.vm.$nextTick()
    expect((table.props('data') as FileItem[]).map(row => row.name)).toEqual(['folder', 'unknown.bin', 'notes.srt', 'movie.mp4'])
    expect(rows.map(row => row.name)).toEqual(['movie.mp4', 'notes.srt', 'unknown.bin', 'folder'])
    table.vm.$emit('sort-change', { prop: 'name', order: null })
    await view.vm.$nextTick()
    expect(table.props('data')).toEqual(rows)
    view.unmount()
  })

  it('persists sort and clamped column widths and restores them on the next visit', async () => {
    const view = render()
    const table = view.findComponent({ name: 'ElTable' })
    table.vm.$emit('sort-change', { prop: 'updatedAt', order: 'ascending' })
    table.vm.$emit('header-dragend', 350, 260, { columnKey: 'name' })
    table.vm.$emit('header-dragend', 2, 100, { columnKey: 'size' })
    await view.vm.$nextTick()
    expect(JSON.parse(localStorage.getItem('panlite:file-table-layout:v1')!)).toEqual({ sort: { prop: 'updatedAt', order: 'ascending' }, widths: { name: 350, size: 80 } })
    view.unmount()
    const reopened = render()
    expect(reopened.findComponent({ name: 'ElTable' }).props('defaultSort')).toEqual({ prop: 'updatedAt', order: 'ascending' })
    expect(reopened.findAllComponents({ name: 'ElTableColumn' }).find(column => column.props('label') === '文件名')!.props('width')).toBe(350)
    reopened.unmount()
  })

  it('ignores invalid persisted widths and sort fields', () => {
    localStorage.setItem('panlite:file-table-layout:v1', JSON.stringify({ sort: { prop: 'credential', order: 'ascending' }, widths: { name: -10, size: '200', type: 9000, createdAt: 170 } }))
    const view = render()
    expect(view.findComponent({ name: 'ElTable' }).props('data')).toEqual(rows)
    const columns = view.findAllComponents({ name: 'ElTableColumn' })
    expect(columns.find(column => column.props('label') === '大小')!.props('width')).toBe(100)
    expect(columns.find(column => column.props('label') === '类型')!.props('width')).toBe(90)
    expect(columns.find(column => column.props('label') === '创建时间')!.props('width')).toBe(170)
    view.unmount()
  })
})
