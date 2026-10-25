const path = require('node:path')
const { rm } = require('node:fs/promises')

// A custom unpacked Electron distribution is copied verbatim by
// electron-builder. Remove files that are only used by Electron's stock shell.
module.exports = async context => {
  const resourcesDir = path.join(context.appOutDir, 'resources')
  await Promise.all([
    rm(path.join(resourcesDir, 'default_app.asar'), { force: true }),
    rm(path.join(context.appOutDir, 'version'), { force: true }),
  ])
}
