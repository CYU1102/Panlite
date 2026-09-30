// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ push: vi.fn() }))
const route = reactive({ path: '/files' })
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => router }))

import SideMenu from './SideMenu.vue'

beforeEach(() => {
  route.path = '/files'
  router.push.mockClear()
})

describe('SideMenu groups', () => {
  it('keeps the current section open and exposes other sections on demand', async () => {
    const view = mount(SideMenu)
    expect(view.find('button[aria-current="page"]').text()).toContain('文件管理')
    expect(view.find('button[aria-controls="nav-group-files"]').attributes('aria-expanded')).toBe('true')
    expect(view.find('button[aria-controls="nav-group-discovery"]').attributes('aria-expanded')).toBe('false')

    await view.find('button[aria-controls="nav-group-discovery"]').trigger('click')
    expect(view.find('button[aria-controls="nav-group-discovery"]').attributes('aria-expanded')).toBe('true')
    await view.find('button[title="资源搜索"]').trigger('click')
    expect(router.push).toHaveBeenCalledWith('/resource-search')

    route.path = '/settings'
    await nextTick()
    expect(view.find('button[aria-controls="nav-group-system"]').attributes('aria-expanded')).toBe('true')
    expect(view.find('button[aria-controls="nav-group-files"]').attributes('aria-expanded')).toBe('false')
    expect(view.find('button[aria-current="page"]').text()).toContain('设置')
    view.unmount()
  })
})
