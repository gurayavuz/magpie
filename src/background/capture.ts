/**
 * Full-page capture orchestration.
 *
 * Chrome only ever hands us the visible viewport (`captureVisibleTab`), rate
 * limited to two calls per second, so a full-page shot is a scroll-and-stitch
 * loop: drive the page from the content script, capture each tile, and compose
 * them onto an `OffscreenCanvas` here in the worker.
 */

import {
  sendToTab,
  type CaptureMode,
  type CaptureResult,
  type ImageFormat,
  type PageMetrics,
  type Rect,
} from '@/lib/protocol'
import { getShot, putShot } from '@/lib/shot-store'

/** Chrome's own limit; going faster just earns us quota errors. */
const CAPTURE_INTERVAL_MS = 1000 / chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND + 60

/**
 * Chrome refuses to allocate a canvas past these bounds, so very long pages come
 * back as several images rather than one impossible one.
 */
const MAX_CANVAS_DIM = 16384
const MAX_CANVAS_AREA = 16384 * 16384

let lastCaptureAt = 0

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Serialise captures across the whole worker so we never trip the quota. */
async function throttle(): Promise<void> {
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now()
  if (wait > 0) await delay(wait)
  lastCaptureAt = Date.now()
}

async function captureViewport(windowId: number, format: ImageFormat, quality: number) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle()
    try {
      const options =
        format === 'png' ? { format: 'png' as const } : { format: 'jpeg' as const, quality }
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options)
      const blob = await (await fetch(dataUrl)).blob()
      return await createImageBitmap(blob)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('MAX_CAPTURE') && !message.toLowerCase().includes('quota')) throw error
      await delay(CAPTURE_INTERVAL_MS * (attempt + 1))
    }
  }
  throw new Error('captureVisibleTab kept hitting its rate limit')
}

/**
 * The content script is declared for `<all_urls>`, but it will not be present on
 * a tab that was already open when the extension loaded or reloaded.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendToTab(tabId, 'capture:metrics', undefined)
    return
  } catch {
    // Not injected yet.
  }

  // The bundler rewrites the content script to a hashed filename, so read the
  // real path back out of the manifest rather than hardcoding the source path.
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js
  if (!files?.length) throw new Error('No content script is declared in the manifest')

  await chrome.scripting.executeScript({ target: { tabId }, files })
  await delay(120)
}

interface PartPlan {
  index: number
  /** Device-pixel origin of this part within the whole page image. */
  originPx: number
  widthPx: number
  heightPx: number
}

function planParts(metrics: PageMetrics, scale: number): PartPlan[] {
  const widthPx = Math.min(Math.round(metrics.scrollWidth * scale), MAX_CANVAS_DIM)
  const totalHeightPx = Math.round(metrics.scrollHeight * scale)
  const maxPartHeight = Math.min(MAX_CANVAS_DIM, Math.floor(MAX_CANVAS_AREA / widthPx))
  const partCount = Math.max(1, Math.ceil(totalHeightPx / maxPartHeight))

  return Array.from({ length: partCount }, (_, index) => {
    const originPx = index * maxPartHeight
    return {
      index,
      originPx,
      widthPx,
      heightPx: Math.min(maxPartHeight, totalHeightPx - originPx),
    }
  })
}

async function encode(
  canvas: OffscreenCanvas,
  format: ImageFormat,
  quality: number,
): Promise<Blob> {
  return canvas.convertToBlob({ type: `image/${format}`, quality })
}

async function store(
  blob: Blob,
  meta: Omit<CaptureResult, 'id' | 'bytes' | 'createdAt'>,
): Promise<CaptureResult> {
  const result: CaptureResult = {
    ...meta,
    id: crypto.randomUUID(),
    bytes: blob.size,
    createdAt: Date.now(),
  }
  await putShot({ id: result.id, blob, meta: result })
  return result
}

/** Capture just what is on screen right now. */
async function captureVisible(
  tab: chrome.tabs.Tab,
  format: ImageFormat,
  quality: number,
): Promise<CaptureResult[]> {
  const metrics = await sendToTab(tab.id!, 'capture:metrics', undefined)
  const bitmap = await captureViewport(tab.windowId, format, quality)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()

  const blob = await encode(canvas, format, quality)
  return [
    await store(blob, {
      width: canvas.width,
      height: canvas.height,
      format,
      scale: canvas.width / Math.max(1, metrics.windowWidth),
      part: 1,
      partCount: 1,
      title: tab.title ?? '',
      url: tab.url ?? '',
    }),
  ]
}

/**
 * Scroll the page in viewport-sized steps, capturing and compositing as we go.
 *
 * Tiles are drawn at the position the page *actually* scrolled to rather than
 * the position we asked for. At the end of a page the browser clamps the scroll,
 * so the last tile overlaps the previous one; drawing by actual position makes
 * that overlap land exactly on top of identical pixels instead of duplicating a
 * strip of content.
 */
async function captureFull(
  tab: chrome.tabs.Tab,
  format: ImageFormat,
  quality: number,
): Promise<CaptureResult[]> {
  const tabId = tab.id!
  await sendToTab(tabId, 'capture:prepare', { hideFixed: false })
  await sendToTab(tabId, 'capture:primeLazyImages', undefined)

  // Measure after priming: lazy images that just loaded change the page height.
  const metrics = await sendToTab(tabId, 'capture:metrics', undefined)
  const { viewportWidth, viewportHeight, scrollerRect } = metrics

  // Do not assume the captured tile is `viewport * devicePixelRatio`: headless
  // Chrome, browser zoom and capture-size caps all break that. Measure the real
  // ratio from one probe tile and use it for every calculation that follows.
  await sendToTab(tabId, 'capture:scrollTo', { x: 0, y: 0 })
  const probe = await captureViewport(tab.windowId, format, quality)
  const scale = probe.width / Math.max(1, metrics.windowWidth)
  probe.close()

  const parts = planParts(metrics, scale)
  const results: CaptureResult[] = []
  let furnitureHidden = false

  try {
    for (const part of parts) {
      const canvas = new OffscreenCanvas(part.widthPx, part.heightPx)
      const ctx = canvas.getContext('2d')!

      const partTopCss = part.originPx / scale
      const partBottomCss = (part.originPx + part.heightPx) / scale

      let previousY = -1
      for (let y = partTopCss; y < partBottomCss; y += viewportHeight) {
        let previousX = -1
        let landedY = -1
        for (let x = 0; x < metrics.scrollWidth; x += viewportWidth) {
          const at = await sendToTab(tabId, 'capture:scrollTo', { x, y })
          landedY = at.y

          // Keep sticky headers in the very first tile so the top of the image
          // looks like the real page, then take them out of every later tile.
          if (!furnitureHidden && (at.y > 0 || y > partTopCss || part.index > 0)) {
            await sendToTab(tabId, 'capture:prepare', { hideFixed: true })
            furnitureHidden = true
          }

          const bitmap = await captureViewport(tab.windowId, format, quality)
          ctx.drawImage(
            bitmap,
            // Source: crop the captured viewport down to the scrolling region.
            Math.round(scrollerRect.x * scale),
            Math.round(scrollerRect.y * scale),
            Math.round(scrollerRect.width * scale),
            Math.round(scrollerRect.height * scale),
            // Destination: where this tile sits inside the current part.
            Math.round(at.x * scale),
            Math.round(at.y * scale) - part.originPx,
            Math.round(scrollerRect.width * scale),
            Math.round(scrollerRect.height * scale),
          )
          bitmap.close()

          if (at.x <= previousX) break // horizontal scroll is clamped; row is done
          previousX = at.x
        }
        // The page would not scroll any further down, so this row was the last.
        if (landedY <= previousY) break
        previousY = landedY
      }

      const blob = await encode(canvas, format, quality)
      results.push(
        await store(blob, {
          width: canvas.width,
          height: canvas.height,
          format,
          scale,
          part: part.index + 1,
          partCount: parts.length,
          title: tab.title ?? '',
          url: tab.url ?? '',
        }),
      )
    }
  } finally {
    await sendToTab(tabId, 'capture:restore', undefined).catch(() => undefined)
  }

  return results
}

/** Crop an already-captured page image down to a region, in CSS page pixels. */
async function cropTo(results: CaptureResult[], rect: Rect): Promise<CaptureResult[]> {
  const source = results[0]
  if (!source) throw new Error('Nothing was captured to crop')
  const stored = await getShot(source.id)
  if (!stored) throw new Error('Captured image vanished before it could be cropped')

  const { scale } = source
  const bitmap = await createImageBitmap(stored.blob)
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(rect.width * scale)),
    Math.max(1, Math.round(rect.height * scale)),
  )
  canvas
    .getContext('2d')!
    .drawImage(
      bitmap,
      Math.round(rect.x * scale),
      Math.round(rect.y * scale),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    )
  bitmap.close()

  const blob = await encode(canvas, source.format, 0.92)
  return [
    await store(blob, {
      width: canvas.width,
      height: canvas.height,
      format: source.format,
      scale,
      part: 1,
      partCount: 1,
      title: source.title,
      url: source.url,
    }),
  ]
}

export async function runCapture(options: {
  tabId?: number
  mode: CaptureMode
  rect?: Rect
  format?: ImageFormat
  quality?: number
}): Promise<CaptureResult[]> {
  const format = options.format ?? 'png'
  const quality = options.quality ?? 0.92

  const tab = options.tabId
    ? await chrome.tabs.get(options.tabId)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]

  if (!tab?.id) throw new Error('No tab to capture')
  if (tab.url && /^(chrome|edge|about|devtools):/i.test(tab.url)) {
    throw new Error('Chrome blocks extensions from capturing browser-internal pages')
  }

  await ensureContentScript(tab.id)

  if (options.mode === 'visible') return captureVisible(tab, format, quality)

  const full = await captureFull(tab, format, quality)
  if (options.mode === 'full' || !options.rect) return full
  if (full.length > 1) {
    throw new Error('This page is too tall to crop a region from in one image')
  }

  return cropTo(full, options.rect)
}
