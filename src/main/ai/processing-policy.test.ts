import { beforeEach, describe, expect, it, vi } from 'vitest'
const settings = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
vi.mock('../db', () => ({ getSetting: settings.get, setSetting: settings.set }))
import { getAiProcessingPolicy, saveAiProcessingPolicy } from './processing-policy'

beforeEach(() => vi.resetAllMocks())
describe('automatic model use policy', () => {
  it('defaults both switches off for existing and new installations', () => {
    expect(getAiProcessingPolicy()).toEqual({ allowModelFallback: false, useSemanticIndex: false })
    settings.get.mockReturnValue({ value: '{}' })
    expect(getAiProcessingPolicy()).toEqual({ allowModelFallback: false, useSemanticIndex: false })
    expect(settings.set).not.toHaveBeenCalled()
  })
  it.each(['{broken', 'null', '42', '"true"', '{"allowModelFallback":"true","useSemanticIndex":1}'])('does not opt into model use from invalid stored data: %s', value => {
    settings.get.mockReturnValue({ value })
    expect(getAiProcessingPolicy()).toEqual({ allowModelFallback: false, useSemanticIndex: false })
  })
  it('keeps file ingestion usable without model requests if settings cannot be read', () => {
    settings.get.mockImplementation(() => { throw new Error('database unavailable') })
    expect(getAiProcessingPolicy()).toEqual({ allowModelFallback: false, useSemanticIndex: false })
  })
  it('persists each explicitly selected option independently and strips unrelated fields', () => {
    const policy = saveAiProcessingPolicy({ allowModelFallback: true, useSemanticIndex: false, unrelated: 'ignored' })
    expect(policy).toEqual({ allowModelFallback: true, useSemanticIndex: false })
    expect(settings.set).toHaveBeenCalledWith('aiProcessingPolicyV1', JSON.stringify(policy))
    settings.get.mockReturnValue({ value: JSON.stringify(policy) })
    expect(getAiProcessingPolicy()).toEqual(policy)
    expect(saveAiProcessingPolicy({ allowModelFallback: false, useSemanticIndex: true })).toEqual({ allowModelFallback: false, useSemanticIndex: true })
  })
  it.each([undefined, null, [], true, {}, { allowModelFallback: 'true', useSemanticIndex: false }, { allowModelFallback: true }])('rejects invalid writes without persisting settings', input => {
    expect(() => saveAiProcessingPolicy(input)).toThrow()
    expect(settings.set).not.toHaveBeenCalled()
  })
})
