import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPdfOcrResolutionWarnings } from './pdf-ocr-resolution'
import { recognizePdfPages } from './local-pdf-ocr'

describe('long PDF page resolution diagnostics', () => {
  it('warns for the measured narrow raster of the real 1125 by 9714 guide page', () => {
    expect(getPdfOcrResolutionWarnings({ width: 406, height: 3500 })[0]).toContain('横向分辨率较低')
    expect(getPdfOcrResolutionWarnings({ width: 406, height: 3500 })[0]).toContain('不代表已完整提取')
  })
  it('does not add a warning to ordinary or already wide page rasters', () => {
    expect(getPdfOcrResolutionWarnings({ width: 2475, height: 3500 })).toEqual([])
    expect(getPdfOcrResolutionWarnings({ width: 1000, height: 3500 })).toEqual([])
    expect(getPdfOcrResolutionWarnings({ width: 3500, height: 406 })).toEqual([])
  })
  it('rejects invalid geometry rather than diagnosing it as a real long page', () => {
    expect(getPdfOcrResolutionWarnings({ width: 0, height: 3500 })).toEqual([])
    expect(getPdfOcrResolutionWarnings({ width: NaN, height: 3500 })).toEqual([])
  })
  it('keeps original scale, PSM, page number, and OCR body while adding only the warning', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-ocr-resolution-'))
    const file = path.join(directory, 'fixture.pdf')
    fs.writeFileSync(file, '%PDF-1.4\n%fixture')
    const original = 'OCR 原样保留：50MB/5\n不得依据测试参考改成 50MB/s'
    let imagePath = ''
    let calls = 0
    try {
      const pages = await recognizePdfPages(file, {
        pdftoppm: 'pdftoppm', tesseract: 'tesseract', language: 'chi_sim+eng',
        run: async (executable, args) => {
          calls++
          if (executable === 'pdftoppm') {
            expect(args.slice(0, 8)).toEqual(['-f', '3', '-l', '3', '-singlefile', '-scale-to', '3500', '-png'])
            const png = Buffer.alloc(24)
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
            png.write('IHDR', 12)
            png.writeUInt32BE(406, 16)
            png.writeUInt32BE(3500, 20)
            imagePath = `${args[args.length - 1]}.png`
            fs.writeFileSync(imagePath, png)
          } else {
            expect(args.slice(2)).toEqual(['-l', 'chi_sim+eng', '--psm', '3', 'txt', 'tsv'])
            fs.writeFileSync(`${args[1]}.txt`, original)
            fs.writeFileSync(`${args[1]}.tsv`, 'level\tconf\ttext\n5\t95\t原文')
          }
          return { stdout: '', stderr: '' }
        },
      }, undefined, [3])
      expect(calls).toBe(2)
      expect(pages[0]).toMatchObject({ pageNumber: 3, content: original, confidence: 95 })
      expect(pages[0].warnings).toEqual([expect.stringContaining('横向分辨率较低')])
      expect(fs.existsSync(path.dirname(imagePath))).toBe(false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
  })
})
