import type { AiLocalToolStatus, AiProviderConfig } from './ai-types'
import { DEFAULT_AI_PROCESSING_POLICY, type AiProcessingPolicy } from './ai-processing-policy'

export type AiCapabilityKey = 'text' | 'pdf' | 'office' | 'ocr' | 'archive' | 'media'
export interface AiCapability {
  key: AiCapabilityKey
  name: string
  state: 'builtin' | 'partial' | 'local' | 'configured' | 'missing' | 'checking'
  label: string
  description: string
  formats: string[]
}

/** A configured model is deliberately not presented as a tested capability. */
export function getAiCapabilities(provider: AiProviderConfig, tools: AiLocalToolStatus[] | null, policy: AiProcessingPolicy = DEFAULT_AI_PROCESSING_POLICY): AiCapability[] {
  const ready = (key: AiLocalToolStatus['key']) => tools?.some(tool => tool.key === key && tool.available && tool.ready === true) === true
  const visualConfigured = policy.allowModelFallback && Boolean(provider.model.trim() && provider.baseUrl.trim())
  const pdfRendererAvailable = tools?.some(tool => tool.key === 'pdftoppm' && tool.available) === true
  const pdfPageModelConfigured = pdfRendererAvailable && visualConfigured
  const wholePdfModelConfigured = !pdfRendererAvailable && visualConfigured && provider.type !== 'ollama'
  const transcriptionConfigured = policy.allowModelFallback && ['openai-compatible', 'openai-responses'].includes(provider.type)
    && Boolean(provider.baseUrl.trim() && provider.transcriptionModel.trim())
  const ocr = ready('tesseract')
  const pdfOcr = ocr && ready('pdftoppm')
  const legacyOffice = ready('libreoffice')
  const media = ready('whisper') && ready('ffmpeg')
  const embedded = tools?.some(tool => tool.key === 'ffmpeg' && tool.available && tool.subtitleAvailable) === true
  return [
    { key: 'text', name: '文本与数据', state: 'builtin', label: '内置解析', formats: ['TXT', 'MD', 'CSV', 'SRT'],
      description: '提取文本、结构化数据原文和字幕时间信息；内容过长时明确提示截断。' },
    { key: 'pdf', name: 'PDF 文档', state: pdfOcr ? 'local' : 'partial', label: pdfOcr ? '本地 OCR 已就绪' : '文本层可用', formats: ['文本 PDF', '扫描 PDF'],
      description: pdfOcr
        ? '按页提取文本层；扫描页通过 pdftoppm + Tesseract 本地识别，效果取决于扫描清晰度与语言包。'
        : pdfPageModelConfigured ? '按页提取文本层；缺字页由 pdftoppm 转为图片后交给当前模型补充识别，需确认模型支持图片输入，能力待实际验证。'
          : wholePdfModelConfigured ? '文本层可直接提取；缺少页面渲染器时，仅纯扫描 PDF 可交给支持 PDF 输入的模型补充识别，能力待实际验证。'
            : policy.allowModelFallback ? '文本层可直接提取；扫描页需 Tesseract + pdftoppm，或安装 pdftoppm 后使用图片模型；无渲染器时纯扫描件需配置支持 PDF 输入的模型。'
            : '文本层可直接提取；扫描页需安装 Tesseract 语言包与 pdftoppm，已关闭模型补充识别。' },
    { key: 'office', name: 'Office 文档', state: legacyOffice ? 'local' : 'partial', label: legacyOffice ? '转换工具已就绪' : '新格式可用', formats: ['DOCX / DOC', 'XLSX / XLS', 'PPTX / PPT'],
      description: legacyOffice
        ? '新格式提取文本、单元格和幻灯片内容；旧格式通过 LibreOffice 转换，不保留完整排版。'
        : 'DOCX、XLSX、PPTX 内置文本解析；DOC、XLS、PPT 需安装并配置 LibreOffice。' },
    { key: 'ocr', name: '图片 OCR', state: ocr ? 'local' : visualConfigured ? 'configured' : tools === null ? 'checking' : 'missing',
      label: ocr ? '本地工具已就绪' : visualConfigured ? '模型待验证' : tools === null ? '检测中' : '需要配置', formats: ['PNG', 'JPG', 'WEBP'],
      description: ocr
        ? '已检测 Tesseract 与所选语言包；识别效果取决于图像清晰度，重要数字建议核对原图。'
        : visualConfigured ? '已配置 AI 模型，仍需确认支持图片输入；可安装 Tesseract 与语言包启用离线识别。'
          : policy.allowModelFallback ? '需要 Tesseract 及对应语言包，或支持图片输入的 AI 模型。'
            : '需要 Tesseract 及对应语言包；已关闭模型补充识别。' },
    { key: 'archive', name: '压缩包解析', state: 'builtin', label: '内置解析', formats: ['ZIP', 'RAR', '7Z', 'TAR'],
      description: '在条目数、大小和递归深度限制内解析支持的成员；跳过或失败会提示。' + (policy.useSemanticIndex ? '已启用语义向量索引，需配置可用嵌入模型。' : '使用本地关键词索引，语义向量索引已关闭。') },
    { key: 'media', name: '音视频转写', state: media ? 'local' : transcriptionConfigured ? 'configured' : 'partial',
      label: media ? '本地工具已就绪' : transcriptionConfigured ? '转写接口待验证' : '字幕优先', formats: ['MP3', 'MP4', 'MKV'],
      description: media
        ? '优先读取字幕，再尝试 FFmpeg + Whisper；首次使用 Python Whisper 可能需要下载模型，结果需核对。'
        : transcriptionConfigured ? '优先字幕，云端转写需服务支持配置的转写模型与格式；单文件上限 25 MB。'
          : embedded ? '可读取外挂与可提取的内嵌字幕；无字幕时需本地 Whisper。' + (policy.allowModelFallback ? '也可配置兼容的转写服务。' : '已关闭模型补充识别。')
            : '可读取同名外挂字幕；内嵌字幕需 FFmpeg + FFprobe，无字幕转写需本地 Whisper。' + (policy.allowModelFallback ? '也可配置兼容的转写服务。' : '已关闭模型补充识别。') },
  ]
}
