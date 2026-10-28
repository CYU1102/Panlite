// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ archiveList: vi.fn(), archiveExtract: vi.fn(), selectDownloadDir: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() } }))
import ArchiveDialog from './ArchiveDialog.vue'

let wrapper: VueWrapper | undefined
const account = { id: 'account', name: 'test', type: 'quark' } as never
const meta = { format: 'rar', fileCount: 1, totalSize: 5, files: [], isEncrypted: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}
function render(initialPassword?: string) {
  wrapper = mount(ArchiveDialog, { props: { modelValue: true, account, fileId: 'one', fileName: 'encrypted.rar', initialPassword }, global: { stubs: {
    ElDialog: { template: '<section><slot/><slot name="footer"/></section>' },
    ElInput: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input type="password" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
    ElButton: { props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>' },
    ElTable: true, ElTableColumn: true,
  } } })
  return wrapper
}
beforeEach(() => { api.archiveList.mockResolvedValue({ success: true, meta }) })
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.resetAllMocks() })

describe('archive password and account scope', () => {
  it('offers a password retry when an encrypted header prevents the initial listing', async () => {
    api.archiveList.mockResolvedValueOnce({ success: false, error: '无法读取RAR文件内容' })
    const view = render()
    await flushPromises()
    expect(view.get('[role="alert"]').text()).toContain('无法读取RAR')
    await view.get('input[type=password]').setValue('1234')
    await view.findAll('button').find(button => button.text() === '重新读取')!.trigger('click')
    await flushPromises()
    expect(api.archiveList).toHaveBeenLastCalledWith('account', 'one', 'encrypted.rar', '1234')
    expect(view.text()).toContain('RAR')
    expect(view.find('[role="alert"]').exists()).toBe(false)
  })

  it('uses the preview password initially without carrying it to another file', async () => {
    const view = render('1234')
    await flushPromises()
    expect(api.archiveList).toHaveBeenLastCalledWith('account', 'one', 'encrypted.rar', '1234')
    await view.setProps({ fileId: 'two' })
    await flushPromises()
    expect(api.archiveList).toHaveBeenLastCalledWith('account', 'two', 'encrypted.rar', undefined)
  })

  it('passes the verified password to the extraction task', async () => {
    api.selectDownloadDir.mockResolvedValue({ success: true, dirPath: 'C:\\destination' })
    api.archiveExtract.mockResolvedValue({ success: true, taskId: 'task' })
    const view = render('1234')
    await flushPromises()
    await view.findAll('button').find(button => button.text() === '全部解压')!.trigger('click')
    await flushPromises()
    expect(api.archiveExtract).toHaveBeenCalledWith('account', 'one', 'encrypted.rar', {
      password: '1234', targetDir: 'C:\\destination', files: undefined,
    })
  })

  it('does not apply an old listing after switching accounts', async () => {
    const old = deferred<{ success: boolean; error: string }>()
    api.archiveList.mockReturnValueOnce(old.promise)
    const view = render()
    await view.setProps({ account: { id: 'other', name: 'other', type: 'quark' } as never })
    await flushPromises()
    old.resolve({ success: false, error: '旧账号错误' })
    await flushPromises()
    expect(view.text()).not.toContain('旧账号错误')
    expect(view.text()).toContain('RAR')
  })

  it('does not extract an old account file if selection changes while choosing a directory', async () => {
    const chooser = deferred<{ success: boolean; dirPath: string }>()
    api.selectDownloadDir.mockReturnValue(chooser.promise)
    const view = render()
    await flushPromises()
    await view.findAll('button').find(button => button.text() === '全部解压')!.trigger('click')
    await view.setProps({ account: { id: 'other', name: 'other', type: 'quark' } as never })
    chooser.resolve({ success: true, dirPath: 'C:\\destination' })
    await flushPromises()
    expect(api.archiveExtract).not.toHaveBeenCalled()
  })
})
