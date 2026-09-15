// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileItem } from '@shared/types'

const api = vi.hoisted(() => ({ renameFile: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: api.success, error: api.error, warning: vi.fn() } }))
import RenameDialog from './RenameDialog.vue'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); vi.clearAllMocks() })
const file: FileItem = { id: 'file', accountId: 'account', platform: 'quark', parentId: 'root', name: 'report.txt', isDir: false, size: 12, createdAt: 0, updatedAt: 0 }

async function render() {
  wrapper = mount(RenameDialog, { props: { modelValue: true, files: [file] }, global: {
    stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } },
  } })
  await flushPromises()
  return wrapper
}

it('keeps unchanged names disabled and submits the previewed name', async () => {
  api.renameFile.mockResolvedValue({ success: true })
  const view = await render()
  const submit = view.findAll('button').find(button => button.text().includes('执行重命名'))!
  expect(submit.attributes('disabled')).toBeDefined()
  await view.get('input[placeholder="要替换的文本"]').setValue('report')
  await view.get('input[placeholder="替换后的文本"]').setValue('final')
  expect(view.find('.new-name').text()).toBe('final.txt')
  await submit.trigger('click')
  await flushPromises()
  expect(api.renameFile).toHaveBeenCalledWith('account', 'file', 'final.txt')
  expect(view.emitted('success')).toHaveLength(1)
  expect(view.emitted('update:modelValue')).toEqual([[false]])
})

it('keeps the dialog open when the provider rejects a rename', async () => {
  api.renameFile.mockResolvedValue({ success: false, error: '文件不存在' })
  const view = await render()
  await view.get('input[placeholder="要替换的文本"]').setValue('report')
  await view.get('input[placeholder="替换后的文本"]').setValue('final')
  await view.findAll('button').find(button => button.text().includes('执行重命名'))!.trigger('click')
  await flushPromises()
  expect(api.error).toHaveBeenCalledWith('文件不存在')
  expect(view.emitted('success')).toBeUndefined()
  expect(view.emitted('update:modelValue')).toBeUndefined()
})
