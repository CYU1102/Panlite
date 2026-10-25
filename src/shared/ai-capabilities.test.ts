import { describe, expect, it } from 'vitest'
import { getAiCapabilities } from './ai-capabilities'
import type { AiProviderConfig } from './ai-types'

const provider: AiProviderConfig = { id: 'test', name: 'test', type: 'openai-compatible', baseUrl: 'https://example.com/v1', model: '', transcriptionModel: '', embeddingModel: '', hasApiKey: false }
const allowFallback = { allowModelFallback: true, useSemanticIndex: false }
describe('file understanding capability truthfulness', () => {
  it('never claims optional capabilities work without tools or a configured model', () => {
    const cards = getAiCapabilities(provider, [])
    expect(cards.find(card => card.key === 'ocr')?.state).toBe('missing')
    expect(cards.find(card => card.key === 'office')?.label).toBe('新格式可用')
    expect(cards.find(card => card.key === 'media')?.label).toBe('字幕优先')
    expect(cards.find(card => card.key === 'pdf')?.label).toBe('文本层可用')
  })
  it('does not equate an executable or a chat model name with verified OCR', () => {
    expect(getAiCapabilities(provider, [{ key: 'tesseract', available: true, ready: false, name: 'OCR', message: '语言包缺失' }]).find(card => card.key === 'ocr')?.state).toBe('missing')
    const configured = getAiCapabilities({ ...provider, model: 'text-only-model' }, [], allowFallback)
    expect(configured.find(card => card.key === 'ocr')?.state).toBe('configured')
    expect(configured.find(card => card.key === 'ocr')?.label).toBe('模型待验证')
  })
  it('distinguishes PDF input and transcription from chat protocol support', () => {
    const cards = getAiCapabilities({ ...provider, type: 'ollama', model: 'vision-model', transcriptionModel: 'whisper' }, [], allowFallback)
    expect(cards.find(card => card.key === 'pdf')?.description).toContain('配置支持 PDF')
    expect(cards.find(card => card.key === 'media')?.state).toBe('partial')
    expect(getAiCapabilities({ ...provider, transcriptionModel: 'transcribe' }, [], allowFallback).find(card => card.key === 'media')?.state).toBe('configured')
  })
  it('requires both audio extraction and a ready Whisper before reporting local transcription', () => {
    const tools = [{ key: 'whisper' as const, name: 'Whisper', available: true, ready: true, message: '' }]
    expect(getAiCapabilities(provider, tools).find(card => card.key === 'media')?.state).toBe('partial')
    expect(getAiCapabilities(provider, [...tools, { key: 'ffmpeg', name: 'FFmpeg', available: true, ready: true, message: '' }]).find(card => card.key === 'media')?.state).toBe('local')
  })
  it('keeps model-based extraction and semantic indexing off by default even with configured models', () => {
    const cards = getAiCapabilities({ ...provider, model: 'vision', transcriptionModel: 'speech', embeddingModel: 'embedding' }, [])
    expect(cards.find(card => card.key === 'ocr')?.state).toBe('missing')
    expect(cards.find(card => card.key === 'media')?.state).toBe('partial')
    for (const key of ['ocr', 'pdf', 'media']) expect(cards.find(card => card.key === key)?.description).toContain('已关闭模型补充识别')
    expect(cards.find(card => card.key === 'archive')?.description).toContain('本地关键词索引')
    expect(getAiCapabilities(provider, [], { ...allowFallback, useSemanticIndex: true }).find(card => card.key === 'archive')?.description).toContain('已启用语义向量索引')
  })
  it('requires both a ready PDF renderer and the selected OCR languages before reporting local PDF OCR', () => {
    const tesseract = { key: 'tesseract' as const, available: true, ready: true, name: 'OCR', message: '' }
    const pdftoppm = { key: 'pdftoppm' as const, available: true, ready: true, name: 'PDF', message: '' }
    expect(getAiCapabilities(provider, [tesseract]).find(card => card.key === 'pdf')?.state).toBe('partial')
    expect(getAiCapabilities(provider, [pdftoppm, { ...tesseract, ready: false }]).find(card => card.key === 'pdf')?.state).toBe('partial')
    const pdf = getAiCapabilities(provider, [pdftoppm, tesseract]).find(card => card.key === 'pdf')!
    expect(pdf.state).toBe('local')
    expect(pdf.description).toContain('pdftoppm + Tesseract 本地识别')
  })
  it('describes page-image fallback for an available renderer even when Tesseract is missing and the model uses Ollama', () => {
    const renderer = { key: 'pdftoppm' as const, available: true, ready: false, name: 'PDF', message: '缺少 Tesseract' }
    const ollama = { ...provider, type: 'ollama' as const, model: 'image-model' }
    const pdf = getAiCapabilities(ollama, [renderer], allowFallback).find(card => card.key === 'pdf')!
    expect(pdf.state).toBe('partial')
    expect(pdf.description).toContain('pdftoppm 转为图片')
    expect(pdf.description).toContain('模型支持图片输入')
    expect(pdf.description).not.toContain('PDF 输入')
    expect(getAiCapabilities(ollama, [renderer]).find(card => card.key === 'pdf')?.description).toContain('已关闭模型补充识别')
  })
  it('limits whole-PDF model fallback to pure scans without a renderer and a non-Ollama provider', () => {
    const configured = { ...provider, model: 'file-model' }
    const pdf = getAiCapabilities(configured, [], allowFallback).find(card => card.key === 'pdf')!
    expect(pdf.description).toContain('仅纯扫描 PDF')
    expect(pdf.description).toContain('支持 PDF 输入')
    const ollama = getAiCapabilities({ ...configured, type: 'ollama' }, [], allowFallback).find(card => card.key === 'pdf')!
    expect(ollama.description).toContain('安装 pdftoppm 后使用图片模型')
    expect(ollama.description).not.toContain('能力待实际验证')
  })
})
