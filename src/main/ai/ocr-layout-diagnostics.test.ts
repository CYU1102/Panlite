import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectTesseractReadingOrderWarnings } from './ocr-layout-diagnostics'
import { recognizePdfPages } from './local-pdf-ocr'

interface LineFixture { text: string; left: number; top: number; width?: number; height?: number }
function tsv(blocks: LineFixture[][]): string {
  const rows = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext']
  blocks.forEach((lines, blockIndex) => lines.forEach((line, lineIndex) => {
    const geometry = [line.left, line.top, line.width ?? 120, line.height ?? 20]
    rows.push([4, 1, blockIndex + 1, 1, lineIndex + 1, 0, ...geometry, -1, ''].join('\t'))
    rows.push([5, 1, blockIndex + 1, 1, lineIndex + 1, 1, ...geometry, 90, line.text].join('\t'))
  }))
  return `${rows.join('\n')}\n`
}
const labels = ['数量：', '单价：', '合计：'].map((text, index) => ({ text, left: 0, top: index * 40 }))
const values = ['12', '128.50', '1542.00'].map((text, index) => ({ text, left: 200, top: index * 40 }))

describe('conservative OCR reading-order diagnostics', () => {
  it('warns about repeated colon labels and unique horizontally aligned cross-block content', () => {
    expect(detectTesseractReadingOrderWarnings(tsv([labels, values]))).toEqual([expect.stringContaining('疑似标签与内容')])
  })
  it('does not confuse ordinary two-column paragraphs with short label blocks', () => {
    expect(detectTesseractReadingOrderWarnings(tsv([labels.map(line => ({ ...line, text: '这是独立左栏正文' })), values.map(line => ({ ...line, text: '这是独立右栏正文' }))]))).toEqual([])
  })
  it('does not select one value from an ambiguous multi-column table', () => {
    expect(detectTesseractReadingOrderWarnings(tsv([labels, values, values.map(line => ({ ...line, left: 400 }))]))).toEqual([])
  })
  it('does not treat nearby but vertically offset lines as the same horizontal row', () => {
    expect(detectTesseractReadingOrderWarnings(tsv([labels, values.map(line => ({ ...line, top: line.top + 12 }))]))).toEqual([])
  })
  it('does not infer horizontal labels from narrow vertical or rotated bounding boxes', () => {
    expect(detectTesseractReadingOrderWarnings(tsv([labels.map(line => ({ ...line, width: 20, height: 100 })), values]))).toEqual([])
  })
  it('explicitly does not claim semantic correspondence for indistinguishable independent lists', () => {
    // A glossary and an independent number list can have exactly this same geometry.
    expect(detectTesseractReadingOrderWarnings(tsv([labels, values]))[0]).toContain('不能据此推断语义')
  })
  it('skips malformed or excessive diagnostic input without changing content', () => {
    expect(detectTesseractReadingOrderWarnings('level\ttext\n5\t文字')).toEqual([])
    expect(detectTesseractReadingOrderWarnings(tsv([labels.map(line => ({ ...line, width: NaN })), values]))).toEqual([])
    expect(detectTesseractReadingOrderWarnings(' '.repeat(8 * 1024 * 1024 + 1))).toEqual([])
  })
  it('keeps the original PDF OCR text and PSM 3 while exposing the warning', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-layout-warning-'))
    const file = path.join(directory, 'fixture.pdf')
    fs.writeFileSync(file, '%PDF-1.4\n%test')
    const original = '数量：\n单价：\n合计：\n12\n128.50\n1542.00'
    try {
      const pages = await recognizePdfPages(file, {
        pdftoppm: 'pdftoppm', tesseract: 'tesseract', language: 'chi_sim+eng',
        run: async (executable, args) => {
          if (executable === 'pdftoppm') {
            const png = Buffer.alloc(24)
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
            png.write('IHDR', 12)
            png.writeUInt32BE(100, 16)
            png.writeUInt32BE(200, 20)
            fs.writeFileSync(`${args[args.length - 1]}.png`, png)
          } else {
            expect(args.slice(2)).toEqual(['-l', 'chi_sim+eng', '--psm', '3', 'txt', 'tsv'])
            fs.writeFileSync(`${args[1]}.txt`, original)
            fs.writeFileSync(`${args[1]}.tsv`, tsv([labels, values]))
          }
          return { stdout: '', stderr: '' }
        },
      }, undefined, [1])
      expect(pages[0].content).toBe(original)
      expect(pages[0].warnings).toEqual([expect.stringContaining('疑似标签与内容')])
      expect(pages[0].confidence).toBe(90)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
})
