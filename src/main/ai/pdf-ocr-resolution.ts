/** Diagnostic only: recognizing every page does not imply retaining its small text. */
export function getPdfOcrResolutionWarnings(dimensions: { width: number; height: number }): string[] {
  const { width, height } = dimensions
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return []
  if (height / width < 3 || width >= 900) return []
  return [`超长页面已缩小至 ${width}×${height} 像素，横向分辨率较低，小字或局部内容可能遗漏；识别到该页不代表已完整提取，请对照原图核对`]
}
