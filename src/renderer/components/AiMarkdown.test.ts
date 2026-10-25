// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ openExternal: vi.fn().mockResolvedValue({ success: true }) }))
vi.mock('../api/ipc', () => ({ electronApi: api }))
import AiMarkdown from './AiMarkdown.vue'
import { aiMarkdownBlocks, safeAiLink } from './ai-markdown'

describe('AI answer Markdown', () => {
  it('keeps model supplied HTML and unsafe links inert while safely opening allowed links', async () => {
    const view = mount(AiMarkdown, { props: { content: '# 回答\n<img src=x onerror=alert(1)>\n[危险](javascript:alert) [原文](https://example.com/source)\n<script>alert(1)</script>' } })
    expect(view.find('img').exists()).toBe(false)
    expect(view.find('script').exists()).toBe(false)
    expect(view.text()).toContain('<img src=x onerror=alert(1)>')
    expect(view.findAll('.inline-link')).toHaveLength(1)
    await view.get('.inline-link').trigger('click')
    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/source')
    for (const link of ['file:///C:/secret', 'data:text/html,evil', 'javascript:alert(1)', 'panlite-preview://session/secret']) expect(safeAiLink(link)).toBe('')
    view.unmount()
  })
  it('renders a readable table and list, and preserves code while a streamed fence is incomplete', async () => {
    const view = mount(AiMarkdown, { props: { content: '| 字段 | 结果 |\n| --- | --- |\n| 金额 | **42 万元** |\n\n1. 核对合同\n```ts\nconst source = "<img>"' } })
    expect(view.get('table').text()).toContain('42 万元')
    expect(view.get('td strong').text()).toBe('42 万元')
    expect(view.get('.list-row').text()).toContain('核对合同')
    expect(view.get('pre').text()).toBe('const source = "<img>"')
    expect(view.find('img').exists()).toBe(false)
    await view.setProps({ content: `${view.props('content')}\n\`\`\`\n处理完成` })
    expect(view.get('pre').text()).toBe('const source = "<img>"')
    expect(view.text()).toContain('处理完成')
    view.unmount()
  })
  it('treats a table separator as a table only when every column is valid', () => {
    expect(aiMarkdownBlocks('a | b\n--- | text\nx | y').some(block => block.type === 'table')).toBe(false)
    expect(aiMarkdownBlocks('| a | b |\n| :--- | ---: |\n| x\\|y | z |')[0].rows).toEqual([['x|y', 'z']])
  })
})
