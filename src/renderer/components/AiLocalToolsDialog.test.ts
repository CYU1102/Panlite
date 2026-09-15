// @vitest-environment jsdom
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ElMessage } from 'element-plus'

const api = vi.hoisted(() => ({ aiLocalToolsGet: vi.fn(), aiLocalToolsSave: vi.fn(), aiLocalToolsSelect: vi.fn(), aiProcessingPolicyGet: vi.fn(), aiProcessingPolicySave: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import AiLocalToolsDialog from './AiLocalToolsDialog.vue'

let wrapper: VueWrapper | undefined
const config = { tesseractPath: '', pdftoppmPath: '', ffmpegPath: '', whisperPath: '', libreOfficePath: '', ocrLanguage: 'chi_sim+eng', whisperModel: 'small', whisperModelPath: '' }
const off = { allowModelFallback: false, useSemanticIndex: false }
beforeEach(() => {
  api.aiLocalToolsGet.mockResolvedValue({ success: true, config, tools: [] })
  api.aiLocalToolsSave.mockResolvedValue({ success: true, config, tools: [] })
  api.aiProcessingPolicyGet.mockResolvedValue({ success: true, policy: off })
  api.aiProcessingPolicySave.mockImplementation(async policy => ({ success: true, policy }))
  vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close: vi.fn() }))
  vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close: vi.fn() }))
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.resetAllMocks() })

async function render() {
  wrapper = mount(AiLocalToolsDialog, { props: { modelValue: true }, global: {
    stubs: { ElDialog: { name: 'ElDialog', template: '<section><slot /><slot name="footer" /></section>' } },
  } })
  wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('open')
  await flushPromises()
  return wrapper
}
function button(view: VueWrapper, label: string) { return view.findAll('button').find(item => item.text() === label)! }

it('defaults both automatic model options off and explains local extraction and explicit question answering', async () => {
  const view = await render()
  const switches = view.findAll('[role="switch"]')
  expect(switches).toHaveLength(2)
  expect(switches.every(item => item.attributes('aria-checked') === 'false')).toBe(true)
  expect(view.text()).toContain('主动发起文档问答仍需调用你配置的模型')
  expect(view.text()).toContain('可能上传文件内容并产生费用')
  expect(view.findAll('.tool-list article')).toHaveLength(5)
  expect(view.text()).toContain('pdftoppm')
  expect(api.aiProcessingPolicySave).not.toHaveBeenCalled()
})

it('saves processing options independently from unsaved executable paths', async () => {
  const view = await render()
  await view.get('input[placeholder="留空则自动检测 Tesseract OCR"]').setValue('C:/custom/tesseract.exe')
  await view.findAll('[role="switch"]')[0].trigger('click')
  await button(view, '保存处理方式').trigger('click')
  await flushPromises()
  expect(api.aiProcessingPolicySave).toHaveBeenCalledWith({ allowModelFallback: true, useSemanticIndex: false })
  expect(api.aiLocalToolsSave).not.toHaveBeenCalled()
  expect(view.emitted('policyUpdated')?.slice(-1)[0]).toEqual([{ allowModelFallback: true, useSemanticIndex: false }])
  expect((view.get('input[placeholder="留空则自动检测 Tesseract OCR"]').element as HTMLInputElement).value).toBe('C:/custom/tesseract.exe')
})

it('saves tool paths independently without persisting unsaved policy switches', async () => {
  const view = await render()
  await view.findAll('[role="switch"]')[1].trigger('click')
  const pdf = view.findAll('.tool-list article').find(item => item.text().includes('PDF 页面渲染器'))!
  api.aiLocalToolsSelect.mockResolvedValue({ success: true, filePath: 'C:/Poppler/pdftoppm.exe' })
  await pdf.get('button').trigger('click')
  await flushPromises()
  await button(view, '保存工具配置').trigger('click')
  await flushPromises()
  expect(api.aiLocalToolsSelect).toHaveBeenCalledWith('pdftoppmPath')
  expect(api.aiLocalToolsSave).toHaveBeenCalledWith({ ...config, pdftoppmPath: 'C:/Poppler/pdftoppm.exe' })
  expect(api.aiProcessingPolicySave).not.toHaveBeenCalled()
  expect(view.findAll('[role="switch"]')[1].attributes('aria-checked')).toBe('true')
})

it('keeps failed policy changes editable for retry without emitting a false saved state', async () => {
  const view = await render()
  await view.findAll('[role="switch"]')[0].trigger('click')
  api.aiProcessingPolicySave.mockResolvedValueOnce({ success: false, error: '磁盘写入失败' })
  await button(view, '保存处理方式').trigger('click')
  await flushPromises()
  expect(ElMessage.error).toHaveBeenCalledWith('磁盘写入失败')
  expect(view.emitted('policyUpdated')).toEqual([[off]])
  expect(view.findAll('[role="switch"]')[0].attributes('aria-checked')).toBe('true')
  await button(view, '保存处理方式').trigger('click')
  await flushPromises()
  expect(view.emitted('policyUpdated')?.slice(-1)[0]).toEqual([{ allowModelFallback: true, useSemanticIndex: false }])
})

it('does not overwrite unknown persisted settings when their initial read fails', async () => {
  api.aiProcessingPolicyGet.mockRejectedValueOnce(new Error('设置读取失败'))
  const view = await render()
  expect(button(view, '保存处理方式').attributes('disabled')).toBeDefined()
  expect(view.text()).toContain('处理方式读取失败')
  expect(view.emitted('policyUpdated')).toBeUndefined()
  await button(view, '重新检测').trigger('click')
  await flushPromises()
  expect(button(view, '保存处理方式').attributes('disabled')).toBeUndefined()
  expect(view.emitted('policyUpdated')).toEqual([[off]])
})
