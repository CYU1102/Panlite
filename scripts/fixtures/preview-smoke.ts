import { app, BrowserWindow, net, protocol } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FilePreviewService } from '../../src/main/file-preview'

const profile = process.env.PANLITE_PREVIEW_SMOKE_PROFILE!
const output = process.env.PANLITE_PREVIEW_SMOKE_OUTPUT!
if (!profile || !output) throw new Error('Isolated smoke profile and output are required')
app.setPath('userData', profile)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
protocol.registerSchemesAsPrivileged([{ scheme: 'panlite-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

function pdfFixture(): Buffer {
  const stream = 'BT /F1 28 Tf 50 700 Td (PanLite PDF Preview Verified) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

function wavFixture(): Buffer {
  const samples = 16000 * 2
  const wav = Buffer.alloc(44 + samples * 2)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 16000 * Math.PI * 440 * 2) * 4000), 44 + i * 2)
  return wav
}

app.whenReady().then(async () => {
  const service = new FilePreviewService({ tempRoot: join(profile, 'previews') })
  const assets = new Map<string, Buffer>([['document.pdf', pdfFixture()], ['audio.wav', wavFixture()]])
  const faultModes = new Map<string, 'disconnect' | 'stall' | 'healthy'>([['disconnected.wav', 'disconnect'], ['stalled.wav', 'stall']])
  const requests: Array<{ file: string; range: string; authenticated: boolean }> = []
  const server = createServer((request, response) => {
    const name = request.url!.slice(1)
    const bytes = assets.get(name) || (faultModes.has(name) ? assets.get('audio.wav') : undefined)
    const authenticated = request.headers.cookie === 'preview-fixture-auth=1'
    requests.push({ file: name, range: request.headers.range || '', authenticated })
    if (!authenticated || !bytes) { response.writeHead(403); response.end(); return }
    let start = 0, end = bytes.length - 1
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '')
    if (range) { start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2])); end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end }
    if (start > end) { response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); response.end(); return }
    response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) })
    const fault = faultModes.get(name)
    if (request.method !== 'HEAD' && (fault === 'disconnect' || fault === 'stall')) {
      // Real TCP faults after valid headers and a partial body, not a mocked fetch error.
      response.write(bytes.subarray(start, Math.min(end + 1, start + 128)))
      if (fault === 'disconnect') setTimeout(() => response.destroy(), 100)
      return
    }
    response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  protocol.handle('panlite-preview', request => service.handleRequest(request))
  const win = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  try {
    await win.loadURL('data:text/html,<html><body style="margin:20px;font:16px Arial;background:white"><h2>PanLite online preview runtime verification</h2><main></main></body></html>')
    const media = await win.webContents.executeJavaScript(`(async () => {
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      document.body.append(canvas);const context=canvas.getContext('2d');let frame=0;
      const draw=()=>{context.fillStyle='#18365c';context.fillRect(0,0,320,180);context.fillStyle='#fff';context.font='24px Arial';context.fillText('PanLite preview '+frame++,20,90)};
      draw();const stream=canvas.captureStream(15);const chunks=[];
      const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
      recorder.ondataavailable=event=>chunks.push(event.data);const stopped=new Promise(resolve=>recorder.onstop=resolve);
      recorder.start();const timer=setInterval(draw,66);await new Promise(resolve=>setTimeout(resolve,1600));recorder.stop();clearInterval(timer);await stopped;stream.getTracks().forEach(track=>track.stop());
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());const image=canvas.toDataURL('image/png').split(',')[1];canvas.remove();
      let mp4=null;
      if(MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42001E')) {
        document.body.append(canvas);const mp4Stream=canvas.captureStream(15);const mp4Chunks=[];
        const mp4Recorder=new MediaRecorder(mp4Stream,{mimeType:'video/mp4;codecs=avc1.42001E'});
        mp4Recorder.ondataavailable=event=>mp4Chunks.push(event.data);const mp4Stopped=new Promise(resolve=>mp4Recorder.onstop=resolve);
        mp4Recorder.start();const mp4Timer=setInterval(draw,66);await new Promise(resolve=>setTimeout(resolve,1600));mp4Recorder.stop();clearInterval(mp4Timer);await mp4Stopped;mp4Stream.getTracks().forEach(track=>track.stop());canvas.remove();
        mp4=btoa(String.fromCharCode(...new Uint8Array(await new Blob(mp4Chunks).arrayBuffer())));
      }
      return {video:btoa(String.fromCharCode(...bytes)),image,mp4};
    })()`)
    assets.set('video.webm', Buffer.from(media.video, 'base64'))
    assets.set('image.png', Buffer.from(media.image, 'base64'))
    if (media.mp4) assets.set('h264.mp4', Buffer.from(media.mp4, 'base64'))
    const previews = []
    for (const fileName of assets.keys()) previews.push(await service.createSession({ accountId: 'smoke', fileId: fileName, fileName,
      fileSize: fileName === 'video.webm' ? 5 * 1024 ** 3 : assets.get(fileName)!.length },
    async () => { throw new Error('Streaming preview must not download the entire file') },
    async () => ({ url: `http://127.0.0.1:${address.port}/${fileName}`, headers: { Cookie: 'preview-fixture-auth=1' } })))
    const video = previews.find(item => item.kind === 'video')!
    const pdf = previews.find(item => item.kind === 'pdf')!
    const renderer = await win.webContents.executeJavaScript(`(async () => {
      const previews=${JSON.stringify(previews)};const results=[];
      for(const preview of previews.filter(item=>item.kind!=='pdf')) {
        const node=document.createElement(preview.kind==='image'?'img':preview.kind);node.style.cssText='width:320px;max-height:180px;margin:8px';node.muted=true;node.controls=true;node.preload='metadata';document.querySelector('main').append(node);
        const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(preview.kind+' load timeout')),12000);node.addEventListener(preview.kind==='image'?'load':'loadedmetadata',()=>{clearTimeout(timer);resolve(true)},{once:true});node.onerror=()=>{clearTimeout(timer);reject(new Error(preview.kind+' decode failure '+node.error?.code))}});
        node.src=preview.assetUrl;await loaded;
        if(preview.kind!=='image') {await node.play();const playbackDeadline=Date.now()+3000;
          while(node.currentTime<=0 && Date.now()<playbackDeadline)await new Promise(resolve=>setTimeout(resolve,50));
          if(node.currentTime<=0)throw new Error(preview.kind+' did not advance');node.pause();node.playbackRate=1.5;
          const seeked=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('seek timeout')),5000);node.addEventListener('seeked',()=>{clearTimeout(timer);resolve(true)},{once:true})});node.currentTime=0.7;await seeked;}
        results.push({kind:preview.kind,fileName:preview.fileName,width:node.videoWidth||node.naturalWidth||null,currentTime:node.currentTime||null,playbackRate:node.playbackRate||null});
        if(preview.fileName==='h264.mp4')node.remove();
      }
      const object=document.createElement('object');object.type='application/pdf';object.data=${JSON.stringify(pdf.assetUrl)};object.style.cssText='display:block;width:100%;height:470px';document.body.append(object);return results;
    })()`)
    const range = await net.fetch(video.assetUrl!, { headers: { Range: 'bytes=10-19' } })
    const rangeBytes = Buffer.from(await range.arrayBuffer())
    if (range.status !== 206 || !rangeBytes.equals(assets.get('video.webm')!.subarray(10, 20))) throw new Error('Byte range content did not match source')
    await new Promise(resolve => setTimeout(resolve, 1800))
    const frames = win.webContents.mainFrame.framesInSubtree.map(frame => ({ url: frame.url, name: frame.name }))
    const pdfFrame = win.webContents.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('chrome-extension://'))
    if (!pdfFrame) throw new Error('Native PDF viewer did not load')
    const pdfState = await pdfFrame.executeJavaScript(`(() => {const viewer=document.querySelector('pdf-viewer');return {loaded:viewer?.loadProgress, state:viewer?.loadState, pageCount:viewer?.docLength, body:document.body.innerText.slice(0,200), elements:[...document.querySelectorAll('*')].map(node=>node.tagName).slice(-8)}})()`)
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise(resolve => setTimeout(resolve, 500))
    writeFileSync(join(output, 'preview.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
    const revoked = previews[0]
    service.cleanupSession(revoked.sessionId)
    const gone = await net.fetch(revoked.assetUrl!)
    if (gone.status !== 404) throw new Error('Closed preview URL was not revoked')
    const failures = []
    for (const fileName of faultModes.keys()) {
      const createFaultSession = () => service.createSession({ accountId: 'smoke', fileId: fileName, fileName },
        async () => { throw new Error('Fault recovery must remain streaming') },
        async () => ({ url: `http://127.0.0.1:${address.port}/${fileName}`, headers: { Cookie: 'preview-fixture-auth=1' } }))
      const failed = await createFaultSession()
      const began = Date.now()
      let headerMs: number | undefined
      let receivedBytes = 0
      let interrupted = false
      const watchdog = new AbortController()
      const watchdogTimer = setTimeout(() => watchdog.abort(), 36_000)
      try {
        const response = await net.fetch(failed.assetUrl!, { signal: watchdog.signal })
        headerMs = Date.now() - began
        if (response.status !== 200 || !response.body) throw new Error('Fault fixture did not deliver its valid response headers')
        const reader = response.body.getReader()
        while (true) {
          const part = await reader.read()
          if (part.done) break
          receivedBytes += part.value.length
        }
      } catch { interrupted = true }
      finally { clearTimeout(watchdogTimer) }
      const elapsedMs = Date.now() - began
      if (!interrupted || watchdog.signal.aborted || !receivedBytes || headerMs === undefined) throw new Error(`${fileName} was not interrupted by the real preview bridge after receiving data`)
      if (fileName === 'stalled.wav' && (elapsedMs < 29_000 || elapsedMs > 35_000)) throw new Error('The stalled read did not expire at the production 30-second timeout')
      service.cleanupSession(failed.sessionId)
      if ((await net.fetch(failed.assetUrl!)).status !== 404) throw new Error('Failed session remained accessible after close')
      faultModes.set(fileName, 'healthy')
      const recovered = await createFaultSession()
      if (recovered.sessionId === failed.sessionId) throw new Error('Recovery reused the failed preview session')
      const recoveredResponse = await net.fetch(recovered.assetUrl!, { headers: { Range: 'bytes=10-19' } })
      if (recoveredResponse.status !== 206 || !Buffer.from(await recoveredResponse.arrayBuffer()).equals(assets.get('audio.wav')!.subarray(10, 20))) throw new Error('Recovered byte range did not match source')
      const playback = await win.webContents.executeJavaScript(`(async () => {
        const node=document.createElement('audio');node.muted=true;node.preload='metadata';document.body.append(node);
        try {
          const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Recovery metadata timeout')),5000);node.onloadedmetadata=()=>{clearTimeout(timer);resolve(true)};node.onerror=()=>{clearTimeout(timer);reject(new Error('Recovery media error'))}});
          node.src=${JSON.stringify(recovered.assetUrl)};await loaded;await node.play();const playbackDeadline=Date.now()+3000;
          while(node.currentTime<=0 && Date.now()<playbackDeadline)await new Promise(resolve=>setTimeout(resolve,50));
          if(node.currentTime<=0)throw new Error('Recovered audio did not advance');node.pause();
          const seeked=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Recovery seek timeout')),5000);node.onseeked=()=>{clearTimeout(timer);resolve(true)}});node.currentTime=0.7;await seeked;
          return {currentTime:node.currentTime, playable:true, seeked:true};
        } finally {node.pause();node.removeAttribute('src');node.load();node.remove()}
      })()`)
      service.cleanupSession(recovered.sessionId)
      failures.push({ scenario: fileName === 'stalled.wav' ? 'read-timeout' : 'connection-dropped', headerMs, receivedBytes, elapsedMs,
        interrupted, recoveredWithNewSession: true, recoveredRangeExact: true, playback })
    }
    if (requests.some(request => !request.authenticated)) throw new Error('Authentication header was lost')
    writeFileSync(join(output, 'report.json'), JSON.stringify({ electron: process.versions.electron, scope: 'Isolated local synthetic authenticated server; no real cloud account or private files accessed',
      h264Recorded: Boolean(media.mp4), renderer, failures,
      range: { status: range.status, exactBytes: true }, revokedStatus: gone.status, pdfState, frames, requests }, null, 2))
  } finally {
    service.cleanupAll(); win.destroy(); server.closeAllConnections(); server.close(); app.quit()
  }
}).catch(error => { writeFileSync(join(output, 'error.txt'), String(error)); console.error(error); app.exit(1) })
