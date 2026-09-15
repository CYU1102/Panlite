// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities } from '@shared/capabilities'
import type { FileItem } from '@shared/types'
import FileTable from './FileTable.vue'

const file = (name: string, isDir = false): FileItem => ({ id: name, name, isDir, accountId: 'account', platform: 'quark', parentId: '0', size: 42, createdAt: 0, updatedAt: 0 })
const caps = getPlatformCapabilities('quark')
const rows = [file('movie.mp4'), file('notes.srt'), file('unknown.bin'), file('folder', true)]

function render(downloadFile = true) {
  return mount(FileTable, { props: { files: rows, capabilities: { ...caps, downloadFile } }, global: {
    directives: { loading: () => {} },
    stubs: {
      ElTable: { name: 'ElTable', props: ['data'], template: '<div><slot /></div>' },
      ElTableColumn: { props: ['label'], setup: () => ({ rows }), template: '<section v-if="label === \'操作\'"><div v-for="row in rows" :key="row.id" :data-file="row.name"><slot :row="row" /></div></section>' },
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
