/**
 * Typed message protocol shared by the service worker, content scripts and UI pages.
 *
 * Every message is routed through a single `chrome.runtime` channel; `Protocol`
 * maps a message name to its request and response shapes so both ends of a call
 * are checked at compile time.
 */

export type CaptureMode = 'full' | 'visible' | 'area' | 'element'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PageMetrics {
  /** Full scrollable size of whatever element actually scrolls. */
  scrollWidth: number
  scrollHeight: number
  viewportWidth: number
  viewportHeight: number
  devicePixelRatio: number
  /** Original scroll position, so we can put the page back where we found it. */
  scrollX: number
  scrollY: number
  /**
   * Where the scrolling region sits inside the viewport, in CSS pixels. For a
   * normally-scrolling page this is the whole viewport; for sites that scroll an
   * inner container (X, some web apps) it is that container's rect, and the
   * stitcher crops each captured tile to it.
   */
  scrollerRect: Rect
  usesElementScroller: boolean
  /**
   * The browser viewport in CSS pixels. `viewportWidth`/`Height` describe the
   * scrolling region, which is smaller when an inner container scrolls; the
   * captured tile always covers the whole window, so scale is derived from this.
   */
  windowWidth: number
  windowHeight: number
}

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface CaptureResult {
  /** Key into the IndexedDB shot store; the blob never crosses the message channel. */
  id: string
  width: number
  height: number
  bytes: number
  format: ImageFormat
  /**
   * Captured device pixels per CSS pixel, measured from the first tile rather
   * than assumed from devicePixelRatio - they do not always agree.
   */
  scale: number
  /** Pages taller than the canvas limit come back as several parts. */
  part: number
  partCount: number
  title: string
  url: string
  createdAt: number
}

export interface MediaItem {
  id: string
  url: string
  /** Container as sniffed from the URL or content-type. */
  kind: 'mp4' | 'hls' | 'dash' | 'image' | 'audio' | 'unknown'
  mimeType?: string
  bytes?: number
  width?: number
  height?: number
  /** Human label, e.g. "1280x720" or the playlist variant bandwidth. */
  label?: string
  /**
   * Which tracks the file actually contains. Sites that stream DASH (Instagram
   * among them) serve audio and video as separate files, so a "video" download
   * can arrive silent unless the two are muxed back together.
   */
  track?: 'video' | 'audio' | 'both'
  pageUrl?: string
  pageTitle?: string
  tabId?: number
  foundAt: number
}

export interface ClippedArticle {
  title: string
  byline: string | null
  siteName: string | null
  excerpt: string | null
  url: string
  markdown: string
  html: string
  wordCount: number
}

export type RecordSource = 'tab' | 'screen'

export interface RecordingMeta {
  id: string
  source: RecordSource
  mimeType: string
  extension: 'mp4' | 'webm'
  bytes: number
  durationMs: number
  startedAt: number
  hasAudio: boolean
  title: string
  url: string
}

export interface RecordingState {
  active: boolean
  paused: boolean
  /** Wall-clock start, so the control can show elapsed time without polling. */
  startedAt?: number
  /** Total time spent paused, subtracted from elapsed. */
  pausedMs?: number
  source?: RecordSource
  tabId?: number
}

export interface Protocol {
  // --- capture -------------------------------------------------------------
  'capture:run': {
    req: { tabId?: number; mode: CaptureMode; rect?: Rect; format?: ImageFormat; quality?: number }
    res: CaptureResult[]
  }
  'capture:metrics': { req: void; res: PageMetrics }
  'capture:prepare': { req: { hideFixed: boolean }; res: void }
  'capture:scrollTo': { req: { x: number; y: number }; res: { x: number; y: number } }
  'capture:primeLazyImages': { req: void; res: void }
  'capture:restore': { req: void; res: void }
  'capture:pickRegion': { req: { mode: 'area' | 'element' }; res: Rect | null }

  // --- media ---------------------------------------------------------------
  'media:resolveLink': { req: { url: string }; res: MediaItem[] }
  'media:download': { req: { item: MediaItem; filename?: string }; res: { downloadId?: number } }

  // --- clipper -------------------------------------------------------------
  'clip:article': { req: void; res: ClippedArticle }

  // --- recording -----------------------------------------------------------
  'record:start': { req: { source: RecordSource; audio: boolean }; res: RecordingState }
  'record:stop': { req: void; res: RecordingMeta | null }
  'record:pause': { req: void; res: RecordingState }
  'record:resume': { req: void; res: RecordingState }
  'record:state': { req: void; res: RecordingState }
  /** Sent by the on-page countdown when the user backs out. */
  'record:cancel': { req: void; res: void }

  /**
   * Worker to offscreen document, which owns the MediaRecorder.
   *
   * Opening the stream and starting the recorder are separate so a countdown can
   * run in between: the stream is live, but nothing is written until `begin`, so
   * the countdown never appears in the recording and cancelling costs nothing.
   */
  'offscreen:open': {
    /** `streamId` is present for tab capture only; screen capture opens its own. */
    req: { id: string; streamId?: string; source: RecordSource; audio: boolean }
    /** `hasAudio` reports what was actually captured, which may be less than asked for. */
    res: { mimeType: string; hasAudio: boolean }
  }
  'offscreen:begin': { req: void; res: void }
  'offscreen:discard': { req: void; res: void }
  'offscreen:stop': { req: void; res: { bytes: number; durationMs: number } | null }
  'offscreen:pause': { req: void; res: void }
  'offscreen:resume': { req: void; res: void }

  /** Worker to the recorded tab, which shows the floating control. */
  'control:show': { req: { state: RecordingState }; res: void }
  'control:hide': { req: void; res: void }
  'countdown:show': { req: { seconds: number }; res: void }
  'countdown:hide': { req: void; res: void }

  // --- misc ----------------------------------------------------------------
  'sys:openEditor': { req: { shotId: string }; res: void }
  'sys:activeTab': { req: void; res: { id: number; url: string; title: string } }
}

export type MessageName = keyof Protocol
export type Req<K extends MessageName> = Protocol[K]['req']
export type Res<K extends MessageName> = Protocol[K]['res']

interface Envelope<K extends MessageName = MessageName> {
  __aio: true
  name: K
  payload: Req<K>
}

type Reply<T> = { ok: true; value: T } | { ok: false; error: string }

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && (value as Envelope).__aio === true
}

/** Send to the service worker (or to any listener that is not tab-scoped). */
export async function send<K extends MessageName>(name: K, payload: Req<K>): Promise<Res<K>> {
  const reply = (await chrome.runtime.sendMessage({ __aio: true, name, payload })) as Reply<Res<K>>
  if (!reply) throw new Error(`No listener responded to "${name}"`)
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

/** Send to the content script running in a specific tab. */
export async function sendToTab<K extends MessageName>(
  tabId: number,
  name: K,
  payload: Req<K>,
): Promise<Res<K>> {
  const reply = (await chrome.tabs.sendMessage(tabId, {
    __aio: true,
    name,
    payload,
  })) as Reply<Res<K>>
  if (!reply) throw new Error(`Tab ${tabId} did not respond to "${name}"`)
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

type Handler<K extends MessageName> = (
  payload: Req<K>,
  sender: chrome.runtime.MessageSender,
) => Res<K> | Promise<Res<K>>

export type Handlers = { [K in MessageName]?: Handler<K> }

/**
 * Install a message router. Only the names present in `handlers` are answered,
 * so several routers (worker, content script) can share one channel without
 * stealing each other's messages.
 */
export function listen(handlers: Handlers): () => void {
  const onMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (reply: Reply<unknown>) => void,
  ) => {
    if (!isEnvelope(message)) return
    const handler = handlers[message.name] as Handler<MessageName> | undefined
    if (!handler) return

    Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then((value) => respond({ ok: true, value }))
      .catch((error: unknown) => {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    return true // keep the channel open for the async reply
  }

  chrome.runtime.onMessage.addListener(onMessage)
  return () => chrome.runtime.onMessage.removeListener(onMessage)
}
