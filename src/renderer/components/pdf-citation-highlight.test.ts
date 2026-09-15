import { describe, expect, it } from 'vitest'
import { pdfCitationHighlights, pdfCitationMatchCount } from './pdf-citation-highlight'
describe('PDF quote geometry', () => {
  const viewport = { scale: 1, transform: [1, 0, 0, -1, 0, 200] }
  const items = [{ str: 'Annual ', transform: [12, 0, 0, 12, 20, 150], width: 40, height: 12 }, { str: 'budget: 42', transform: [12, 0, 0, 12, 20, 130], width: 70, height: 12 }]
  it('matches across lines and maps original PDF baselines into canvas bounds', () => {
    expect(pdfCitationHighlights(items, 'Annual\nbudget: 42', viewport)).toEqual([{ left: 20, top: 38, width: 40, height: 12 }, { left: 20, top: 58, width: 70, height: 12 }])
  })
  it('does not fabricate a highlight for scanned or unmatched pages', () => {
    expect(pdfCitationHighlights([], '原文', viewport)).toEqual([])
    expect(pdfCitationHighlights(items, 'budget: 99', viewport)).toEqual([])
  })
  it('uses stored chunk context to distinguish repeated quotes and otherwise marks every match', () => {
    const repeated = [{ ...items[0], str: 'First budget: 42' }, { ...items[1], str: 'Second budget: 42' }]
    expect(pdfCitationMatchCount(repeated, 'budget: 42')).toBe(2)
    expect(pdfCitationHighlights(repeated, 'budget: 42', viewport)).toHaveLength(2)
    expect(pdfCitationHighlights(repeated, 'budget: 42', viewport, 'Second budget: 42')).toEqual([{ left: 20, top: 58, width: 70, height: 12 }])
  })
})
