import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PDF_OCR_LIMITS, parseTesseractConfidence, recognizePdfPages, withLocalRenderedPdfPage, type PdfLocalCommand, type PdfLocalTools } from './local-pdf-ocr'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-pdf-ocr-test-'))
  roots.push(root)
  const file = path.join(root, 'fixture.pdf')
  fs.writeFileSync(file, '%PDF-1.4\n%synthetic command fixture')
  return file
}
function png(width = 100, height = 200): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.write('IHDR', 12)
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}
function tools(run: PdfLocalCommand): PdfLocalTools {
  return { pdftoppm: '/fixture/pdftoppm', tesseract: '/fixture/tesseract', language: 'chi_sim+eng', run }
}

function confidenceFixture(words: Array<[string, string | number]>): string {
  return 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
    words.map(([text, confidence], index) => `5\t1\t1\t1\t1\t${index + 1}\t0\t0\t10\t10\t${confidence}\t${text}`).join('\n')
}

function writeOcrFixture(args: string[], content: string, confidence = confidenceFixture([['fixture', 90]])): void {
  fs.writeFileSync(`${args[1]}.txt`, content)
  fs.writeFileSync(`${args[1]}.tsv`, confidence)
}

describe('bounded local scanned PDF processing', () => {
  it('renders only the requested missing pages sequentially, preserves page numbers, and removes every image', async () => {
    const file = fixture()
    const images: string[] = []
    const calls: Array<{ executable: string; args: string[]; timeout?: number }> = []
    const run: PdfLocalCommand = async (executable, args, options) => {
      calls.push({ executable, args, timeout: options?.timeoutMs })
      if (executable.endsWith('pdftoppm')) {
        expect(images.every(image => !fs.existsSync(image))).toBe(true)
        expect(args.slice(0, 8)).toEqual(['-f', args[1], '-l', args[1], '-singlefile', '-scale-to', '3500', '-png'])
        expect(args[8]).toBe(file)
        images.push(`${args[9]}.png`)
        fs.writeFileSync(images[images.length - 1], png())
        return { stdout: '', stderr: '' }
      }
      expect(args.slice(2)).toEqual(['-l', 'chi_sim+eng', '--psm', '3', 'txt', 'tsv'])
      writeOcrFixture(args, `OCR ${path.basename(args[0])}`)
      return { stdout: '', stderr: '' }
    }
    expect(await recognizePdfPages(file, tools(run), undefined, [7, 3, 7])).toEqual([
      { pageNumber: 3, content: 'OCR page-3.png', confidence: 90 }, { pageNumber: 7, content: 'OCR page-7.png', confidence: 90 },
    ])
    expect(calls.map(call => path.basename(call.executable))).toEqual(['pdftoppm', 'tesseract', 'pdftoppm', 'tesseract'])
    expect(calls.map(call => call.timeout)).toEqual([45_000, 60_000, 45_000, 60_000])
    expect(images.every(image => !fs.existsSync(path.dirname(image)))).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
  })

  it('requires explicit bounded page selection and does no work for an empty selection', async () => {
    const run = vi.fn()
    await expect(recognizePdfPages('unused.pdf', tools(run), undefined, [])).resolves.toEqual([])
    for (const pages of [undefined, [0], [-1], [1.2], [1001], Array.from({ length: 51 }, (_, index) => index + 1)]) {
      await expect(recognizePdfPages('unused.pdf', tools(run), undefined, pages)).rejects.toThrow(/页码|50 页/)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects oversized input before launching a process', async () => {
    const file = fixture()
    fs.truncateSync(file, LOCAL_PDF_OCR_LIMITS.maxFileBytes + 1)
    const run = vi.fn()
    await expect(recognizePdfPages(file, tools(run), undefined, [1])).rejects.toThrow('200 MB')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([Buffer.from('not a png'), png(3501, 100), png(0, 100)])('rejects invalid or excessive rendered pixels and cleans output', async (data) => {
    let image = ''
    const run: PdfLocalCommand = async (_executable, args) => {
      image = `${args[args.length - 1]}.png`
      fs.writeFileSync(image, data)
      return { stdout: '', stderr: '' }
    }
    const result = await recognizePdfPages(fixture(), tools(run), undefined, [1])
    expect(result[0].content).toBe('')
    expect(result[0].warnings?.join()).toMatch(/PNG|像素/)
    expect(fs.existsSync(path.dirname(image))).toBe(false)
  })

  it('removes temporary images after cancellation and never launches another page', async () => {
    const controller = new AbortController()
    let directory = ''
    const run: PdfLocalCommand = vi.fn(async (_executable, args, options) => {
      directory = path.dirname(args[args.length - 1])
      const result = new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
      })
      controller.abort()
      return result
    })
    await expect(recognizePdfPages(fixture(), tools(run), controller.signal, [1, 2])).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('enforces the total deadline between subprocesses', async () => {
    let now = 100
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let directory = ''
    const run: PdfLocalCommand = vi.fn(async (_executable, args) => {
      directory = path.dirname(args[args.length - 1])
      fs.writeFileSync(`${args[args.length - 1]}.png`, png())
      now += LOCAL_PDF_OCR_LIMITS.totalTimeoutMs + 1
      return { stdout: '', stderr: '' }
    })
    const result = await recognizePdfPages(fixture(), tools(run), undefined, [1])
    expect(result[0].warnings?.join()).toContain('10 分钟')
    expect(run).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(directory)).toBe(false)
  })

  it('keeps a single rendered page alive only during its callback and cleans on callback failure', async () => {
    let image = ''
    const run: PdfLocalCommand = async (_executable, args) => {
      image = `${args[args.length - 1]}.png`
      fs.writeFileSync(image, png())
      return { stdout: '', stderr: '' }
    }
    await expect(withLocalRenderedPdfPage(fixture(), 5, tools(run), async (imagePath, signal) => {
      expect(imagePath).toBe(image)
      expect(fs.existsSync(imagePath)).toBe(true)
      expect(signal.aborted).toBe(false)
      throw new Error('callback failed')
    })).rejects.toThrow('callback failed')
    expect(fs.existsSync(path.dirname(image))).toBe(false)
  })

  it('cancels a hanging single-page callback and removes its image', async () => {
    const controller = new AbortController()
    let image = ''
    const run: PdfLocalCommand = async (_executable, args) => {
      image = `${args[args.length - 1]}.png`
      fs.writeFileSync(image, png())
      return { stdout: '', stderr: '' }
    }
    await expect(withLocalRenderedPdfPage(fixture(), 1, tools(run), async (_imagePath, signal) => {
      controller.abort()
      expect(signal.aborted).toBe(true)
      return new Promise<string>(() => undefined)
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fs.existsSync(path.dirname(image))).toBe(false)
  })

  it('preserves successful OCR pages when another page fails, and continues to later pages', async () => {
    const run: PdfLocalCommand = async (executable, args) => {
      if (executable.endsWith('pdftoppm')) fs.writeFileSync(`${args[args.length - 1]}.png`, png())
      else {
        if (args[0].endsWith('page-2.png')) throw new Error('page fixture failed')
        writeOcrFixture(args, `正文 ${path.basename(args[0])}`)
      }
      return { stdout: '', stderr: '' }
    }
    const result = await recognizePdfPages(fixture(), tools(run), undefined, [1, 2, 3])
    expect(result[0].content).toBe('正文 page-1.png')
    expect(result[1]).toMatchObject({ pageNumber: 2, content: '', warnings: [expect.stringContaining('page fixture failed')] })
    expect(result[2].content).toBe('正文 page-3.png')
  })

  it('preserves Chinese, decimal amounts, line breaks and low-confidence words without rewriting the text', async () => {
    const truth = '第一列：合同编号 AB-001\n第二列：金额 1,234.50 元\n需核对：O0l1'
    const run: PdfLocalCommand = async (executable, args) => {
      if (executable.endsWith('pdftoppm')) fs.writeFileSync(`${args[args.length - 1]}.png`, png())
      else writeOcrFixture(args, truth, confidenceFixture([['合同编号', 92], ['1,234.50', 82], ['O0l1', 18]]))
      return { stdout: '', stderr: '' }
    }
    const [result] = await recognizePdfPages(fixture(), tools(run), undefined, [1])
    expect(result.content).toBe(truth)
    expect(result.confidence).toBe(64)
    expect(result.warnings?.join()).toContain('O0l1')
    expect(result.warnings?.join()).toContain('不代表准确率')
  })

  it('retains prior pages and explicitly marks unprocessed pages when the total text budget is reached', async () => {
    let renders = 0
    const run: PdfLocalCommand = async (executable, args) => {
      if (executable.endsWith('pdftoppm')) { renders++; fs.writeFileSync(`${args[args.length - 1]}.png`, png()) }
      else writeOcrFixture(args, 'x'.repeat(1024 * 1024))
      return { stdout: '', stderr: '' }
    }
    const result = await recognizePdfPages(fixture(), tools(run), undefined, [1, 2, 3, 4])
    expect(result.slice(0, 2).every(page => page.content.length === 1024 * 1024)).toBe(true)
    expect(result.slice(2).every(page => !page.content && page.warnings?.join().includes('2 MB'))).toBe(true)
    expect(renders).toBe(3)
  })

  it('retains prior successful pages when the total deadline is reached on a later page', async () => {
    let now = 100
    let renders = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const run: PdfLocalCommand = async (executable, args) => {
      if (executable.endsWith('pdftoppm')) {
        renders++
        fs.writeFileSync(`${args[args.length - 1]}.png`, png())
        if (args[1] === '2') now += LOCAL_PDF_OCR_LIMITS.totalTimeoutMs + 1
      } else writeOcrFixture(args, '已识别的第一页')
      return { stdout: '', stderr: '' }
    }
    const result = await recognizePdfPages(fixture(), tools(run), undefined, [1, 2, 3])
    expect(result[0].content).toBe('已识别的第一页')
    expect(result.slice(1).every(page => !page.content && page.warnings?.join().includes('10 分钟'))).toBe(true)
    expect(renders).toBe(2)
  })

  it('returns an explicit empty-page warning and keeps text if confidence output is missing', async () => {
    const run: PdfLocalCommand = async (executable, args) => {
      if (executable.endsWith('pdftoppm')) fs.writeFileSync(`${args[args.length - 1]}.png`, png())
      else fs.writeFileSync(`${args[1]}.txt`, args[0].endsWith('page-1.png') ? '' : '保留正文')
      return { stdout: '', stderr: '' }
    }
    const result = await recognizePdfPages(fixture(), tools(run), undefined, [1, 2])
    expect(result[0].warnings?.join()).toContain('不能据此认定原页为空白')
    expect(result[1].content).toBe('保留正文')
    expect(result[1].warnings?.join()).toContain('词级置信度')
  })
})

describe('Tesseract confidence metadata', () => {
  it('never treats missing, invalid or negative confidence values as zero-percent accuracy', () => {
    expect(parseTesseractConfidence(confidenceFixture([['word', -1], ['value', 'NaN'], ['missing', '']])).confidence).toBeUndefined()
    expect(parseTesseractConfidence('broken').warnings).toBeDefined()
    expect(parseTesseractConfidence(confidenceFixture([['right', 80], ['wrong', 101]]))).toMatchObject({ confidence: 80, warnings: [expect.stringContaining('记录无效')] })
  })
})
