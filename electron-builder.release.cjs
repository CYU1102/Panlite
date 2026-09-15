const path = require('node:path')

module.exports = {
  extends: './electron-builder.yml',
  directories: { output: path.resolve(__dirname, 'release') },
  npmRebuild: false,
}
