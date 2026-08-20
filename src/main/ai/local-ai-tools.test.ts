import { describe, expect, it } from 'vitest'
import { hasSubtitleStream } from './local-ai-tools'

describe('local AI tool metadata parsing', () => {
  it('detects subtitle streams reported by ffprobe', () => {
    expect(hasSubtitleStream({ streams: [{ codec_type: 'video' }, { codec_type: 'subtitle' }] })).toBe(true)
    expect(hasSubtitleStream({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] })).toBe(false)
    expect(hasSubtitleStream(null)).toBe(false)
  })
})
