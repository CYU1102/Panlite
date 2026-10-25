import type { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'

/** Operates only on the caller's hidden test renderer; never controls the user's windows. */
export async function verifyHiddenMedia(window: BrowserWindow, assetUrl: string): Promise<unknown> {
  if (window.isVisible()) throw new Error('Media acceptance requires a hidden window')
  if (!/^panlite-preview:\/\/session\/[a-f\d-]+$/i.test(assetUrl)) throw new Error('Expected an opaque preview session URL')
  return window.webContents.executeJavaScript(`(async () => {
    const video = document.createElement('video');
    video.muted = true; video.volume = 0; video.preload = 'metadata';
    video.style.cssText = 'width:640px;height:360px;background:black';
    document.body.append(video);
    const started = performance.now();
    const waitFor = (predicate, label, timeout = 30000) => new Promise((resolve, reject) => {
      const deadline = performance.now() + timeout;
      const timer = setInterval(() => {
        if (video.error) { clearInterval(timer); reject(new Error(label + ': media error ' + video.error.code)); }
        else if (predicate()) { clearInterval(timer); resolve(true); }
        else if (performance.now() >= deadline) { clearInterval(timer); reject(new Error(label + ': timeout')); }
      }, 50);
    });
    const advance = async (seconds) => {
      const begin = video.currentTime;
      await video.play();
      await waitFor(() => video.currentTime >= begin + seconds, 'Playback time advance', 20000);
      video.pause();
      return { from: begin, to: video.currentTime };
    };
    try {
      video.src = ${JSON.stringify(assetUrl)};
      await waitFor(() => video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 5, 'Metadata');
      const metadataMs = performance.now() - started;
      const duration = video.duration;
      const initial = await advance(2);
      const seeks = [];
      for (const fraction of [0.25, 0.7]) {
        const target = duration * fraction;
        const seekStarted = performance.now();
        video.currentTime = target;
        await waitFor(() => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) <= 1, 'Seek');
        const reached = video.currentTime;
        const playback = await advance(1);
        seeks.push({ target, reached, elapsedMs: performance.now() - seekStarted, playback });
      }
      video.playbackRate = 1.5;
      if (video.playbackRate !== 1.5) throw new Error('Playback rate did not change');
      const atSpeed = await advance(2);
      const quality = video.getVideoPlaybackQuality?.();
      if (!video.videoWidth || !video.videoHeight) throw new Error('No video frame dimensions');
      if (!quality || quality.totalVideoFrames <= 0) throw new Error('No decoded video frames');
      return { passed: true, metadataMs, duration, width: video.videoWidth, height: video.videoHeight,
        initial, seeks, playbackRate: video.playbackRate, atSpeed,
        decodedFrames: quality?.totalVideoFrames ?? null, droppedFrames: quality?.droppedVideoFrames ?? null,
        wallMs: performance.now() - started, muted: video.muted,
        scope: 'Hidden renderer decoding and sampled playback/seeks; no full-video or audible A/V-sync verification' };
    } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); }
  })()`)
}

export async function verifyHiddenImage(window: BrowserWindow, assetUrl: string): Promise<unknown> {
  if (window.isVisible()) throw new Error('Image acceptance requires a hidden window')
  if (!/^panlite-preview:\/\/session\/[a-f\d-]+$/i.test(assetUrl)) throw new Error('Expected an opaque preview session URL')
  return window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = document.createElement('img');
    const timer = setTimeout(() => { image.remove(); reject(new Error('Image decode timeout')); }, 30000);
    image.onload = () => { clearTimeout(timer); const result = { passed: image.naturalWidth > 0 && image.naturalHeight > 0,
      width: image.naturalWidth, height: image.naturalHeight }; image.remove(); resolve(result); };
    image.onerror = () => { clearTimeout(timer); image.remove(); reject(new Error('Image decode failed')); };
    image.src = ${JSON.stringify(assetUrl)};
    document.body.append(image);
  })`)
}

/** Mirrors the ordinary preview dialog's built-in PDF object, then captures only
 * this new hidden test surface. The PNG must be visually reviewed before pass. */
export async function verifyHiddenPdf(window: BrowserWindow, assetUrl: string, screenshotPath: string): Promise<unknown> {
  if (window.isVisible()) throw new Error('PDF acceptance requires a hidden window')
  if (!/^panlite-preview:\/\/session\/[a-f\d-]+$/i.test(assetUrl)) throw new Error('Expected an opaque preview session URL')
  const load = await window.webContents.executeJavaScript(`new Promise(resolve => {
    document.body.replaceChildren(); document.body.style.margin = '0';
    const object = document.createElement('object');
    object.type = 'application/pdf'; object.style.cssText = 'display:block;width:960px;height:720px;border:0';
    const done = loadEvent => { clearTimeout(timer); resolve({ loadEvent }); };
    const timer = setTimeout(() => done(false), 15000);
    object.onload = () => done(true);
    object.onerror = () => done(false);
    object.data = ${JSON.stringify(assetUrl)};
    document.body.append(object);
  })`)
  // The PDF viewer paints after the outer object has completed its load event.
  await new Promise(resolve => setTimeout(resolve, 2500))
  const screenshot = await window.webContents.capturePage()
  if (screenshot.isEmpty()) throw new Error('Hidden PDF capture is empty')
  await writeFile(screenshotPath, screenshot.toPNG())
  return { ...load, ...screenshot.getSize(), screenshotPath, requiresVisualReview: true,
    scope: 'Ordinary preview PDF object in a new hidden renderer; capture alone does not establish a pass' }
}
