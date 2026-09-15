// Run with Electron: render the existing vector source, without extra tooling.
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8')
  const window = new BrowserWindow({ width: 256, height: 256, useContentSize: true,
    frame: false, show: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await window.loadURL('data:text/html,<canvas id="icon" width="256" height="256"></canvas>')
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const pngUrl = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(source)}; await image.decode();
    const canvas = document.getElementById('icon'); canvas.getContext('2d').drawImage(image, 0, 0, 256, 256);
    return canvas.toDataURL('image/png');
  })()`)
  const rendered = nativeImage.createFromDataURL(pngUrl)
  if (rendered.isEmpty()) throw new Error('Icon rendering produced an empty image')
  const master = rendered.resize({ width: 256, height: 256, quality: 'best' })
  fs.writeFileSync(path.join(root, 'build/icon.png'), master.toPNG())
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map(size => master.resize({ width: size, height: size, quality: 'best' }).toPNG())
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  images.forEach((png, index) => {
    const entry = 6 + index * 16
    header[entry] = header[entry + 1] = sizes[index] % 256
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...images]))
  console.log('Rendered build/icon.svg to PNG and a 7-size Windows ICO')
  window.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
