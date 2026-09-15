import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('../db', () => ({ getSetting: () => undefined, setSetting: vi.fn() }))
import { resolveAiLocalTool, withRenderedPdfPage } from './local-ai-tools'

const poppler = resolveAiLocalTool('pdftoppm')

function pdfFixture(): Buffer {
  const stream = 'BT /F1 28 Tf 50 700 Td (PanLite Local PDF Render Test) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

it.skipIf(!poppler)('renders a generated PDF using a real detected Poppler executable and cleans the PNG', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-poppler-smoke-'))
  const filePath = path.join(directory, 'fixture.pdf')
  let renderedPath = ''
  fs.writeFileSync(filePath, pdfFixture())
  try {
    const dimensions = await withRenderedPdfPage(filePath, 1, async (imagePath) => {
      renderedPath = imagePath
      const bytes = fs.readFileSync(imagePath)
      expect(bytes.length).toBeGreaterThan(1000)
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    })
    expect(dimensions?.height).toBe(3500)
    expect(dimensions?.width).toBeGreaterThan(2600)
    expect(dimensions?.width).toBeLessThan(2800)
    expect(fs.existsSync(path.dirname(renderedPath))).toBe(false)
    expect(fs.existsSync(filePath)).toBe(true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}, 15_000)
