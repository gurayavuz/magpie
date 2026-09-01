/**
 * Page-side driver for full-page capture.
 *
 * The service worker owns the screenshot loop; this module does the things that
 * require a DOM: measuring the page, finding the element that actually scrolls,
 * neutralising sticky/fixed furniture that would otherwise repeat in every tile,
 * forcing lazy images to load, and putting everything back afterwards.
 */

import type { Handlers, PageMetrics, Rect } from '@/lib/protocol'

const STYLE_ID = 'aio-capture-style'

type Scroller = { kind: 'window' } | { kind: 'element'; element: HTMLElement }

interface RestorePoint {
  scrollX: number
  scrollY: number
  /** Elements we hid or unstuck, with the inline values they had before. */
  touched: { element: HTMLElement; visibility: string; position: string }[]
}

let restorePoint: RestorePoint | undefined

/**
 * Find what actually scrolls. Most pages scroll the document, but app-shell
 * layouts pin the document and scroll an inner container instead.
 */
function findScroller(): Scroller {
  const doc = document.documentElement
  if (doc.scrollHeight > doc.clientHeight + 1) return { kind: 'window' }

  let best: HTMLElement | undefined
  let bestArea = 0
  for (const element of document.body?.querySelectorAll<HTMLElement>('*') ?? []) {
    const overflowY = getComputedStyle(element).overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll') continue
    if (element.scrollHeight <= element.clientHeight + 100) continue
    const rect = element.getBoundingClientRect()
    const area = rect.width * rect.height
    if (area > bestArea) {
      bestArea = area
      best = element
    }
  }
  return best ? { kind: 'element', element: best } : { kind: 'window' }
}

function scrollPosition(scroller: Scroller): { x: number; y: number } {
  return scroller.kind === 'window'
    ? { x: window.scrollX, y: window.scrollY }
    : { x: scroller.element.scrollLeft, y: scroller.element.scrollTop }
}

function applyScroll(scroller: Scroller, x: number, y: number): void {
  if (scroller.kind === 'window') {
    window.scrollTo({ left: x, top: y, behavior: 'auto' })
  } else {
    scroller.element.scrollLeft = x
    scroller.element.scrollTop = y
  }
}

/** Two frames plus a beat: long enough for scroll-linked effects to settle. */
function settle(ms = 90): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setTimeout(resolve, ms)
      }),
    )
  })
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  // Smooth scrolling would leave the page mid-animation when we capture, and a
  // visible scrollbar would be baked into every tile.
  style.textContent = `
    *, *::before, *::after { scroll-behavior: auto !important; }
    html, body { scrollbar-width: none !important; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  `
  document.documentElement.appendChild(style)
}

/**
 * Hide `fixed` furniture (it would appear in every tile) and demote `sticky`
 * elements to static so they render once, in their natural place. Sticky
 * elements already occupy normal flow space, so demoting them does not reflow.
 */
function setFurnitureHidden(hidden: boolean): void {
  if (!restorePoint) return

  if (!hidden) {
    for (const { element, visibility, position } of restorePoint.touched) {
      element.style.visibility = visibility
      element.style.position = position
    }
    restorePoint.touched = []
    return
  }

  if (restorePoint.touched.length > 0) return

  for (const element of document.querySelectorAll<HTMLElement>('body *')) {
    if (element.id === STYLE_ID) continue
    const { position } = getComputedStyle(element)
    if (position !== 'fixed' && position !== 'sticky') continue

    restorePoint.touched.push({
      element,
      visibility: element.style.visibility,
      position: element.style.position,
    })
    if (position === 'fixed') {
      element.style.setProperty('visibility', 'hidden', 'important')
    } else {
      element.style.setProperty('position', 'static', 'important')
    }
  }
}

function measure(): PageMetrics {
  const scroller = findScroller()
  const doc = document.documentElement
  const body = document.body

  if (scroller.kind === 'element') {
    const element = scroller.element
    const rect = element.getBoundingClientRect()
    return {
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: element.scrollLeft,
      scrollY: element.scrollTop,
      scrollerRect: { x: rect.x, y: rect.y, width: element.clientWidth, height: element.clientHeight },
      usesElementScroller: true,
      windowWidth: doc.clientWidth || window.innerWidth,
      windowHeight: window.innerHeight,
    }
  }

  return {
    scrollWidth: Math.max(doc.scrollWidth, body?.scrollWidth ?? 0, doc.clientWidth),
    scrollHeight: Math.max(doc.scrollHeight, body?.scrollHeight ?? 0, doc.clientHeight),
    viewportWidth: doc.clientWidth || window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollerRect: {
      x: 0,
      y: 0,
      width: doc.clientWidth || window.innerWidth,
      height: window.innerHeight,
    },
    usesElementScroller: false,
    windowWidth: doc.clientWidth || window.innerWidth,
    windowHeight: window.innerHeight,
  }
}

/**
 * Walk the page once so viewport-triggered lazy images start loading, then wait
 * for them to decode. Without this, a full-page shot is full of blank boxes.
 */
async function primeLazyImages(): Promise<void> {
  const scroller = findScroller()
  const metrics = measure()
  const start = scrollPosition(scroller)

  for (const image of document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) {
    image.loading = 'eager'
  }

  const step = Math.max(metrics.viewportHeight * 0.9, 200)
  for (let y = 0; y < metrics.scrollHeight; y += step) {
    applyScroll(scroller, start.x, y)
    await settle(30)
  }

  applyScroll(scroller, start.x, start.y)
  await settle(60)

  const pending = [...document.images]
    .filter((image) => !image.complete && image.src)
    .map((image) =>
      image
        .decode()
        .catch(() => undefined),
    )
  // Never let one stalled image hold the whole capture hostage.
  await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 2500))])
}

export const captureHandlers: Handlers = {
  'capture:metrics': () => measure(),

  'capture:prepare': ({ hideFixed }) => {
    injectStyle()
    const scroller = findScroller()
    if (!restorePoint) {
      const { x, y } = scrollPosition(scroller)
      restorePoint = { scrollX: x, scrollY: y, touched: [] }
    }
    setFurnitureHidden(hideFixed)
  },

  'capture:primeLazyImages': () => primeLazyImages(),

  'capture:scrollTo': async ({ x, y }) => {
    const scroller = findScroller()
    applyScroll(scroller, x, y)
    await settle()
    // The page may refuse to scroll that far; the stitcher needs where we landed.
    return scrollPosition(scroller)
  },

  'capture:restore': async () => {
    setFurnitureHidden(false)
    document.getElementById(STYLE_ID)?.remove()
    if (restorePoint) {
      applyScroll(findScroller(), restorePoint.scrollX, restorePoint.scrollY)
      restorePoint = undefined
    }
    await settle(0)
  },
}

export type { Rect }
