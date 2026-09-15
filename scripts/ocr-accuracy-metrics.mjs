function editDistance(expected, actual) {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index)
  for (let row = 0; row < expected.length; row++) {
    const current = [row + 1]
    for (let column = 0; column < actual.length; column++) current.push(Math.min(current[column] + 1, previous[column + 1] + 1, previous[column] + Number(expected[row] !== actual[column])))
    previous = current
  }
  return previous[actual.length]
}
export function textMetrics(truth, recognized) {
  // Normalize only platform line endings. Do not repair case, punctuation, O/0 or I/1.
  const expected = truth.replace(/\r\n?/g, '\n').trimEnd()
  const actual = recognized.replace(/\r\n?/g, '\n').trimEnd()
  const expectedCharacters = [...expected]
  const actualCharacters = [...actual]
  const expectedCompact = [...expected.replace(/\s/gu, '')]
  const actualCompact = [...actual.replace(/\s/gu, '')]
  const numeric = value => value.match(/\d+(?:\.\d+)?/g) || []
  const amounts = value => value.match(/(?<![\d.])\d+\.\d{2}(?!\d)/g) || []
  const expectedNumbers = numeric(expected)
  const actualNumbers = numeric(actual)
  const expectedAmounts = amounts(expected)
  const actualAmounts = amounts(actual)
  const characterErrors = editDistance(expectedCharacters, actualCharacters)
  const compactErrors = editDistance(expectedCompact, actualCompact)
  return {
    strictCer: characterErrors / Math.max(1, expectedCharacters.length),
    strictCharacterErrors: characterErrors,
    strictReferenceCharacters: expectedCharacters.length,
    whitespaceInsensitiveCer: compactErrors / Math.max(1, expectedCompact.length),
    whitespaceInsensitiveCharacterErrors: compactErrors,
    whitespaceInsensitiveReferenceCharacters: expectedCompact.length,
    numericTokensExact: JSON.stringify(expectedNumbers) === JSON.stringify(actualNumbers),
    expectedNumbers, actualNumbers,
    numericTokenErrors: editDistance(expectedNumbers, actualNumbers),
    amountTokensExact: JSON.stringify(expectedAmounts) === JSON.stringify(actualAmounts),
    expectedAmounts, actualAmounts,
    amountTokenErrors: editDistance(expectedAmounts, actualAmounts),
  }
}
