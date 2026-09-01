/**
 * Media discovery.
 *
 * Rather than reverse-engineering each site's private API, we watch what the
 * page itself downloads. `chrome.webRequest` sees every video request the tab
 * makes, which keeps working when a site reshuffles its GraphQL endpoints.
 *
 * The registry lives in `chrome.storage.session` because an MV3 service worker
 * is evicted aggressively; an in-memory map would be empty again by the time the
 * user opened the side panel.
 */

import type { MediaItem } from '@/lib/protocol'

const MAX_PER_TAB = 60
const KEY = (tabId: number) => `media:${tabId}`

/** HLS/DASH pieces are noise - we want the playlist that describes them. */
const SEGMENT = /\.(ts|m4s)(\?|$)/i
const PLAYLIST = /\.(m3u8|mpd)(\?|$)/i
const VIDEO_FILE = /\.(mp4|webm|mov|m4v)(\?|$)/i
const AUDIO_FILE = /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i

function classify(url: string, mimeType?: string): MediaItem['kind'] | undefined {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls'
  if (/\.mpd(\?|$)/i.test(url)) return 'dash'
  if (SEGMENT.test(url)) return undefined
  if (VIDEO_FILE.test(url)) return 'mp4'
  if (AUDIO_FILE.test(url)) return 'audio'

  if (mimeType?.startsWith('video/')) {
    return mimeType.includes('mpegurl') ? 'hls' : 'mp4'
  }
  if (mimeType?.includes('mpegurl')) return 'hls'
  if (mimeType?.startsWith('audio/')) return 'audio'
  return undefined
}

/**
 * Serialise writes per tab. Several media requests can land in the same tick and
 * a naive read-modify-write would drop all but the last.
 */
const queues = new Map<number, Promise<unknown>>()

function enqueue<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(tabId) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(
    tabId,
    next.catch(() => undefined),
  )
  return next
}

async function readTab(tabId: number): Promise<MediaItem[]> {
  const stored = await chrome.storage.session.get(KEY(tabId))
  return (stored[KEY(tabId)] as MediaItem[] | undefined) ?? []
}

async function record(tabId: number, item: MediaItem): Promise<void> {
  await enqueue(tabId, async () => {
    const items = await readTab(tabId)
    const existing = items.findIndex((candidate) => candidate.url === item.url)
    if (existing >= 0) {
      // Keep whichever record knows more; headers arrive after the request.
      items[existing] = { ...items[existing]!, ...item }
    } else {
      items.push(item)
    }
    const trimmed = items.slice(-MAX_PER_TAB)
    await chrome.storage.session.set({ [KEY(tabId)]: trimmed })
  })
}

export async function listMedia(tabId: number): Promise<MediaItem[]> {
  const items = await readTab(tabId)
  return items.sort((a, b) => b.foundAt - a.foundAt)
}

export async function clearMedia(tabId: number): Promise<void> {
  await enqueue(tabId, () => chrome.storage.session.remove(KEY(tabId)))
}

/**
 * Range parameters vary per request, so the same file appears under dozens of
 * URLs. Dropping them collapses those back to one entry - and the stripped URL
 * still resolves to the complete file.
 */
const RANGE_PARAMS = ['bytestart', 'byteend']

export function normaliseMediaUrl(raw: string): string {
  try {
    const url = new URL(raw)
    let changed = false
    for (const param of RANGE_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param)
        changed = true
      }
    }
    return changed ? url.toString() : raw
  } catch {
    return raw
  }
}

/**
 * Read enough of an MP4 header to tell whether it carries picture, sound, or
 * both. The handler atoms `vide` and `soun` appear in the moov, which sits at
 * the front of these files.
 */
export async function classifyTrack(url: string): Promise<{
  track?: MediaItem['track']
  bytes?: number
}> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-8191' } })
    if (!response.ok) return {}

    const total = response.headers.get('content-range')?.split('/')[1]
    const header = new Uint8Array(await response.arrayBuffer())
    const text = String.fromCharCode(...header)
    const hasVideo = text.includes('vide')
    const hasAudio = text.includes('soun')

    return {
      bytes: total && Number.isFinite(Number(total)) ? Number(total) : undefined,
      track: hasVideo && hasAudio ? 'both' : hasVideo ? 'video' : hasAudio ? 'audio' : undefined,
    }
  } catch {
    return {}
  }
}

function noteRequest(details: {
  url: string
  tabId: number
  mimeType?: string
  bytes?: number
}): void {
  if (details.tabId < 0) return
  if (!/^https?:/i.test(details.url)) return

  const kind = classify(details.url, details.mimeType)
  if (!kind) return

  const url = normaliseMediaUrl(details.url)
  void record(details.tabId, {
    id: `${details.tabId}:${url}`,
    url,
    kind,
    mimeType: details.mimeType,
    bytes: details.bytes,
    tabId: details.tabId,
    foundAt: Date.now(),
  })
}

/** Start watching every tab for media requests. */
export function installMediaWatcher(): void {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      noteRequest({ url: details.url, tabId: details.tabId })
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
  )

  // Headers tell us the real type and size, which the URL often does not.
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const header = (name: string) =>
        details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value

      const mimeType = header('content-type')?.split(';')[0]?.trim()
      // On a 206 the content-length is just this slice; the real size is the
      // figure after the slash in content-range.
      const total = header('content-range')?.split('/')[1]
      const length = Number(total ?? header('content-length') ?? '')
      noteRequest({
        url: details.url,
        tabId: details.tabId,
        mimeType,
        bytes: Number.isFinite(length) && length > 0 ? length : undefined,
      })
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
    ['responseHeaders'],
  )

  // A tab that navigates somewhere new should not keep the old page's media.
  chrome.webNavigation?.onCommitted.addListener((details) => {
    if (details.frameId === 0) void clearMedia(details.tabId)
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearMedia(tabId)
  })
}

// --- resolving a pasted link -------------------------------------------------

/**
 * X's public syndication endpoint returns a tweet's media without any login.
 * Its `token` is derived from the tweet id rather than issued by a server.
 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

export function tweetId(url: string): string | undefined {
  return /(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i.exec(url)?.[1]
}

interface Variant {
  url?: string
  bitrate?: number
  content_type?: string
}

export function variantsFrom(payload: unknown): MediaItem[] {
  const found: { item: MediaItem; bitrate: number }[] = []
  const seen = new Set<string>()

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (!node || typeof node !== 'object') return

    const record = node as Record<string, unknown>
    const variants = record.variants
    if (Array.isArray(variants)) {
      for (const variant of variants as Variant[]) {
        if (!variant.url || seen.has(variant.url)) continue
        seen.add(variant.url)

        const isHls = variant.content_type?.includes('mpegurl') || /\.m3u8/i.test(variant.url)
        const bitrate = variant.bitrate ?? 0
        // X puts the rendition size in the path, e.g. /1280x720/. Surfacing it
        // matters: bitrate alone does not tell you a clip is 422x270.
        const size = /\/(\d{2,4})x(\d{2,4})\//.exec(variant.url)
        const dimensions = size ? `${size[1]}x${size[2]}` : undefined

        found.push({
          bitrate,
          item: {
            id: variant.url,
            url: variant.url,
            kind: isHls ? 'hls' : 'mp4',
            mimeType: variant.content_type,
            width: size ? Number(size[1]) : undefined,
            height: size ? Number(size[2]) : undefined,
            label:
              [bitrate ? `${Math.round(bitrate / 1000)} kbps` : 'stream', dimensions]
                .filter(Boolean)
                .join(' - '),
            foundAt: Date.now(),
          },
        })
      }
    }
    for (const value of Object.values(record)) walk(value)
  }

  walk(payload)

  // Highest bitrate first. A plain file is preferred over a playlist at equal
  // quality because it downloads directly instead of needing segment assembly.
  return found
    .sort((a, b) => {
      if (a.item.kind !== b.item.kind) return a.item.kind === 'mp4' ? -1 : 1
      return b.bitrate - a.bitrate
    })
    .map((entry) => entry.item)
}

async function resolveTweet(url: string): Promise<MediaItem[]> {
  const id = tweetId(url)
  if (!id) return []

  const endpoint =
    `https://cdn.syndication.twimg.com/tweet-result` +
    `?id=${id}&token=${syndicationToken(id)}&lang=en`

  const response = await fetch(endpoint)
  if (!response.ok) return []

  const payload: unknown = await response.json()
  const items = variantsFrom(payload)
  for (const item of items) item.pageUrl = url
  return items
}

/**
 * Fallback for anything without a public resolver: load the page in a background
 * tab and let the request watcher see what it plays.
 */
async function resolveByWatching(url: string, waitMs = 9000): Promise<MediaItem[]> {
  const tab = await chrome.tabs.create({ url, active: false })
  if (!tab.id) return []

  try {
    const deadline = Date.now() + waitMs
    let best: MediaItem[] = []
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const found = await listMedia(tab.id)
      if (found.length > best.length) best = found
      // A direct file is all we need; playlists may still be loading variants.
      if (best.some((item) => item.kind === 'mp4')) break
    }
    return best.map((item) => ({ ...item, pageUrl: url }))
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined)
  }
}

export async function resolveLink(url: string): Promise<MediaItem[]> {
  if (!/^https?:/i.test(url)) throw new Error('That does not look like a link')

  if (tweetId(url)) {
    const direct = await resolveTweet(url).catch(() => [])
    if (direct.length > 0) return direct
  }

  const watched = await resolveByWatching(url)

  // The user is already waiting on this flow, so spend a little longer working
  // out what each file really is rather than showing them a silent "video".
  const enriched = await Promise.all(
    watched.map(async (item) => {
      if (item.kind !== 'mp4') return item
      const { track, bytes } = await classifyTrack(item.url)
      return { ...item, track: track ?? item.track, bytes: bytes ?? item.bytes }
    }),
  )

  // Biggest first: for a DASH pair that puts the video track above its audio.
  return enriched.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
}
