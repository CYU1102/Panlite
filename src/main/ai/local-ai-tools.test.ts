import { describe, expect, it } from 'vitest'
import { hasSubtitleStream, parseOcrLanguageSelection } from './local-ai-tools'

describe('local AI tool metadata parsing', () => {
  it('detects subtitle streams reported by ffprobe', () => {
    expect(hasSubtitleStream({ streams: [{ codec_type: 'video' }, { codec_type: 'subtitle' }] })).toBe(true)
    expect(hasSubtitleStream({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] })).toBe(false)
    expect(hasSubtitleStream(null)).toBe(false)
  })

  it('preserves ordered multilingual and script selections without silently changing invalid languages', () => {
    expect(parseOcrLanguageSelection('chi_sim + eng + chi_sim')).toEqual(['chi_sim', 'eng'])
    expect(parseOcrLanguageSelection('script/Latin+eng')).toEqual(['script/Latin', 'eng'])
    for (const invalid of ['', '++', 'chi_sim eng', '../eng', 'eng+', 'osd']) expect(() => parseOcrLanguageSelection(invalid)).toThrow(/语言|方向/)
  })
})
