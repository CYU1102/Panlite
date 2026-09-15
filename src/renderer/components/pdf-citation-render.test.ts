// @vitest-environment node
import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { pdfCitationHighlights, type PdfTextPosition } from './pdf-citation-highlight'

function twoPagePdf(): Uint8Array {
  const streams = ['BT /F1 18 Tf 40 220 Td (Opening page) Tj ET', 'BT /F1 18 Tf 40 220 Td (Annual budget: 42) Tj ET']
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...streams.map(stream => `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)]
  let output = '%PDF-1.4\n'; const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(output))
}
describe('real PDF rendering for source citations', () => {
  it('renders page two with PDF.js and places visible highlights over its actual text pixels', async () => {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = getDocument({ data: twoPagePdf(), useSystemFonts: true })
    try {
      const pdf = await loading.promise
      expect(pdf.numPages).toBe(2)
      const page = await pdf.getPage(2), viewport = page.getViewport({ scale: 1 })
      const canvas = createCanvas(viewport.width, viewport.height)
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise
      const content = await page.getTextContent()
      const boxes = pdfCitationHighlights(content.items.filter(item => 'str' in item) as PdfTextPosition[], 'Annual budget: 42', viewport)
      expect(boxes).toHaveLength(1)
      const box = boxes[0]
      expect(box.left).toBeCloseTo(40); expect(box.top).toBeCloseTo(62)
      const ctx = canvas.getContext('2d')
      const region = ctx.getImageData(Math.floor(box.left), Math.floor(box.top), Math.ceil(box.width), Math.ceil(box.height)).data
      expect([...region].filter((channel, index) => index % 4 !== 3 && channel < 180).length).toBeGreaterThan(20)
      ctx.fillStyle = 'rgba(255, 210, 20, 0.34)'; ctx.fillRect(box.left, box.top, box.width, box.height)
      const rendered = canvas.toBuffer('image/png')
      expect(rendered.length).toBeGreaterThan(1000)
      if (process.env.PANLITE_AI_CITATION_VISUAL_OUTPUT) {
        const fs = await import('node:fs/promises')
        await fs.writeFile(process.env.PANLITE_AI_CITATION_VISUAL_OUTPUT, rendered)
      }
    } finally { await loading.destroy() }
  })
})
