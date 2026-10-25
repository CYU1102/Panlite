// @vitest-environment jsdom
import { defineComponent } from 'vue'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '@shared/ai-types'

const api = vi.hoisted(() => ({ aiProviderList: vi.fn(), aiProviderUsage: vi.fn(), aiProviderSave: vi.fn(),
  aiProviderActivate: vi.fn(), aiProviderDuplicate: vi.fn(), aiProviderDelete: vi.fn(), aiProviderTestConfig: vi.fn(),
  aiProviderListModels: vi.fn(), aiProviderQueryBalance: vi.fn(), openExternal: vi.fn(),
  success: vi.fn(), warning: vi.fn(), error: vi.fn(), confirm: vi.fn() }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { success: api.success, warning: api.warning, error: api.error } }))
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({ ElMessageBox: { confirm: api.confirm } }))
import AiProviderDialog from './AiProviderDialog.vue'

const Dialog = defineComponent({ props: ['beforeClose'], emits: ['update:modelValue'],
  template: '<section><button aria-label="关闭" @click="beforeClose(() => $emit(\'update:modelValue\', false))">关闭</button><slot/><slot name="footer"/></section>' })
const Select = defineComponent({ props: ['modelValue'], emits: ['update:modelValue', 'change'],
  template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value); $emit(\'change\', $event.target.value)"><slot/></select>' })
const Option = defineComponent({ props: ['value', 'label'], template: '<option :value="value">{{ label }}</option>' })

function profile(id: string, name: string): AiProviderConfig {
  return { id, name, type: 'openai-compatible', baseUrl: 'https://mock.invalid/v1', model: `${id}-model`,
    transcriptionModel: 'transcribe-model', embeddingModel: 'embedding-model', hasApiKey: true, keyCount: 2,
    keyPreviews: ['test-***-one', 'test-***-two'] }
}
let first: AiProviderConfig
let second: AiProviderConfig
let wrapper: VueWrapper | undefined

beforeEach(() => {
  vi.resetAllMocks()
  first = profile('first', '当前配置')
  second = profile('second', '备用配置')
  api.aiProviderList.mockResolvedValue({ success: true, profiles: [first, second], active: first })
  api.aiProviderUsage.mockResolvedValue({ success: true, usage: [] })
  api.aiProviderTestConfig.mockResolvedValue({ success: true, latencyMs: 12 })
  api.aiProviderListModels.mockResolvedValue({ success: true, models: ['available-model'] })
  api.aiProviderQueryBalance.mockResolvedValue({ success: true, balance: { remaining: 42, currency: 'USD' } })
  api.confirm.mockResolvedValue('confirm')
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

async function render() {
  wrapper = mount(AiProviderDialog, { props: { modelValue: true, activeConfig: first }, global: {
    stubs: { ElDialog: Dialog, ElSelect: Select, ElOption: Option },
  } })
  await flushPromises()
  return wrapper
}
async function click(view: VueWrapper, text: string) {
  const button = view.findAll('button').find(item => item.text() === text)
  expect(button, `button ${text}`).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}
async function selectSecond(view: VueWrapper) {
  await view.findAll('.profile-item')[1].trigger('click')
  await flushPromises()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('AI provider configuration management', () => {
  it('saves an edited profile without activating it or returning to a stale parent selection', async () => {
    const view = await render()
    await selectSecond(view)
    await view.get('input[placeholder="例如：日常模型"]').setValue('备用配置编辑后')
    const saved = { ...second, name: '备用配置编辑后' }
    api.aiProviderSave.mockResolvedValue({ success: true, config: saved, active: first })
    await click(view, '保存')
    expect(api.aiProviderSave).toHaveBeenCalledWith(expect.objectContaining({ id: second.id, name: saved.name, activate: false }))
    expect(api.aiProviderActivate).not.toHaveBeenCalled()
    expect(view.emitted('updated')).toEqual([[first]])
    expect(view.get('.profile-item.active').text()).toContain(saved.name)
    expect(view.get<HTMLInputElement>('input[placeholder="例如：日常模型"]').element.value).toBe(saved.name)
    expect(view.text()).not.toContain('有未保存的更改')
    expect(view.get('.manager-summary').text()).toContain(first.name)
  })

  it('separates save-and-use from activating an already saved profile', async () => {
    const view = await render()
    await selectSecond(view)
    api.aiProviderActivate.mockResolvedValue({ success: true, config: second })
    await click(view, '使用已保存配置')
    expect(api.aiProviderActivate).toHaveBeenCalledWith(second.id)
    expect(api.aiProviderSave).not.toHaveBeenCalled()
    await view.get('input[placeholder="例如：日常模型"]').setValue('启用并编辑')
    const saved = { ...second, name: '启用并编辑' }
    api.aiProviderSave.mockResolvedValue({ success: true, config: saved, active: saved })
    await click(view, '保存并使用')
    expect(api.aiProviderSave).toHaveBeenCalledWith(expect.objectContaining({ activate: true, id: second.id }))
    const updates = view.emitted('updated') || []
    expect(updates[updates.length - 1]).toEqual([saved])
    expect(view.get('.manager-summary').text()).toContain(saved.name)
  })

  it('uses the active profile returned by the server and duplicates securely without switching it', async () => {
    api.aiProviderList.mockResolvedValue({ success: true, profiles: [first, second], active: second })
    const view = await render()
    expect(view.get('.profile-item.active').text()).toContain(second.name)
    const copy = { ...second, id: 'copy', name: '备用配置（副本）' }
    api.aiProviderDuplicate.mockResolvedValue({ success: true, config: copy, active: second })
    await click(view, '复制配置')
    expect(api.aiProviderDuplicate).toHaveBeenCalledWith(second.id)
    expect(api.aiProviderSave).not.toHaveBeenCalled()
    expect(api.aiProviderActivate).not.toHaveBeenCalled()
    expect(view.get('.profile-item.active').text()).toContain(copy.name)
    expect(view.get('.manager-summary').text()).toContain(second.name)
    expect(view.emitted('updated')).toEqual([[second]])
    expect(view.get<HTMLInputElement>('input[type="password"]').element.value).toBe('')
    expect(view.findAll('.key-pool-item')).toHaveLength(2)
  })

  it('updates the current-use indicator after an external switch without replacing unsaved edits', async () => {
    const view = await render()
    await view.get('input[placeholder="例如：日常模型"]').setValue('仍在编辑当前表单')
    await view.setProps({ activeConfig: second })
    expect(view.get('.manager-summary').text()).toContain(second.name)
    expect(view.get('.profile-item.active').text()).toContain(first.name)
    expect(view.get<HTMLInputElement>('input[placeholder="例如：日常模型"]').element.value).toBe('仍在编辑当前表单')
    expect(view.text()).toContain('有未保存的更改')
    expect(api.aiProviderSave).not.toHaveBeenCalled()
  })

  it('keeps key deletions in the draft and gives save, test, model listing and balance the same key changes', async () => {
    const view = await render()
    await selectSecond(view)
    await view.findAll('button[title="删除该 Key"]')[0].trigger('click')
    await view.get('button[title="删除该 Key"]').trigger('click')
    await view.get('textarea').setValue('draft-key-one\ndraft-key-two')
    await view.get('input[type="checkbox"]').setValue(true)
    expect(view.findAll('.key-pending-delete')).toHaveLength(2)
    expect(api.aiProviderSave).not.toHaveBeenCalled()
    expect(api.aiProviderActivate).not.toHaveBeenCalled()
    await click(view, '测试问答接口')
    await view.get('button[title="从接口获取模型列表"]').trigger('click')
    await flushPromises()
    await click(view, '查余额')
    const expected = { profileId: second.id, clearApiKey: true, removeKeyIndices: [0, 1], appendKeys: ['draft-key-one', 'draft-key-two'] }
    for (const method of [api.aiProviderTestConfig, api.aiProviderListModels, api.aiProviderQueryBalance]) {
      expect(method).toHaveBeenCalledWith(expect.objectContaining(expected))
    }
    expect(view.get('.test-result').text()).toContain('不代表 OCR、转写或 Embedding 可用')
    api.aiProviderSave.mockResolvedValue({ success: true, config: second, active: first })
    await click(view, '保存')
    expect(api.aiProviderSave).toHaveBeenCalledWith(expect.objectContaining({ id: second.id, activate: false,
      clearApiKey: true, removeKeyIndices: [0, 1], appendKeys: ['draft-key-one', 'draft-key-two'] }))
  })

  it.each(['models', 'balance', 'test'] as const)('ignores a late %s response after selecting another profile', async kind => {
    const result = deferred<unknown>()
    const method = kind === 'models' ? api.aiProviderListModels : kind === 'balance' ? api.aiProviderQueryBalance : api.aiProviderTestConfig
    method.mockReturnValueOnce(result.promise)
    const view = await render()
    if (kind === 'models') await view.get('button[title="从接口获取模型列表"]').trigger('click')
    else await click(view, kind === 'balance' ? '查余额' : '测试问答接口')
    await selectSecond(view)
    result.resolve({ success: true, models: ['stale-first-model'], balance: { remaining: 999, currency: 'USD' }, latencyMs: 999 })
    await flushPromises()
    expect(view.get('.profile-item.active').text()).toContain(second.name)
    expect(view.text()).not.toContain('stale-first-model')
    expect(view.find('.balance-line').exists()).toBe(false)
    expect(view.find('.test-result').exists()).toBe(false)
    expect(api.success).not.toHaveBeenCalled()
  })

  it('invalidates in-flight results when key edits change the current draft without changing its profile ID', async () => {
    const result = deferred<unknown>()
    api.aiProviderQueryBalance.mockReturnValueOnce(result.promise)
    const view = await render()
    await click(view, '查余额')
    await view.get('input[type="password"]').setValue('new-draft-key')
    result.resolve({ success: true, balance: { remaining: 999, currency: 'USD' } })
    await flushPromises()
    expect(view.find('.balance-line').exists()).toBe(false)
    expect(view.text()).toContain('有未保存的更改')
  })

  it('preserves unsaved edits when switching is cancelled and discards them only after confirmation', async () => {
    const view = await render()
    await view.get('input[placeholder="例如：日常模型"]').setValue('正在编辑')
    api.confirm.mockRejectedValueOnce('cancel')
    await selectSecond(view)
    expect(view.get('.profile-item.active').text()).toContain(first.name)
    expect(view.get<HTMLInputElement>('input[placeholder="例如：日常模型"]').element.value).toBe('正在编辑')
    await selectSecond(view)
    expect(api.confirm).toHaveBeenCalledTimes(2)
    expect(view.get('.profile-item.active').text()).toContain(second.name)
    expect(view.text()).not.toContain('有未保存的更改')
    expect(api.aiProviderSave).not.toHaveBeenCalled()
  })

  it('protects unsaved edits on close and clears discarded drafts before reopening', async () => {
    const view = await render()
    await view.get('input[type="password"]').setValue('unsaved-draft-key')
    api.confirm.mockRejectedValueOnce('cancel')
    await view.get('button[aria-label="关闭"]').trigger('click'); await flushPromises()
    expect(view.emitted('update:modelValue')).toBeUndefined()
    await view.get('button[aria-label="关闭"]').trigger('click'); await flushPromises()
    expect(view.emitted('update:modelValue')).toEqual([[false]])
    await view.setProps({ modelValue: false }); await view.setProps({ modelValue: true }); await flushPromises()
    expect(view.get<HTMLInputElement>('input[type="password"]').element.value).toBe('')
    expect(view.text()).not.toContain('有未保存的更改')
  })

  it.each([
    ['anthropic', 'https://api.anthropic.com/v1'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ])('uses the %s endpoint and hides unsupported audio and embedding fields', async (type, baseUrl) => {
    const view = await render()
    await view.get('select[aria-label="接口类型"]').setValue(type)
    expect(view.get<HTMLInputElement>('input[aria-label="接口地址"]').element.value).toBe(baseUrl)
    expect(view.find('input[placeholder="填写服务商支持的转写模型"]').exists()).toBe(false)
    expect(view.find('input[placeholder="填写服务商支持的 Embedding 模型"]').exists()).toBe(false)
    expect(view.text()).toContain('暂不支持音视频转写与 Embedding')
    expect(view.find('textarea').exists()).toBe(true)
  })
})
