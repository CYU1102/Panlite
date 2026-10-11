const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const yaml = require('js-yaml')

const publisherName = process.env.PANLITE_PUBLISHER_NAME?.trim()
if (!publisherName) {
  throw new Error('Set PANLITE_PUBLISHER_NAME before creating a signed release.')
}

const base = yaml.load(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'))

module.exports = {
  ...base,
  forceCodeSigning: true,
  win: {
    ...base.win,
    signtoolOptions: {
      ...base.win.signtoolOptions,
      publisherName,
    },
    signAndEditExecutable: true,
    signExecutable: true,
  },
}
