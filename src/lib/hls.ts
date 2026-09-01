/**
 * Minimal HLS assembly.
 *
 * An `.m3u8` is a playlist, not a file: the video lives in hundreds of separate
 * segments. To save it we resolve the playlist, fetch every segment and join
 * them back together.
 *
 * Modern streams (X included) ship fragmented MP4 segments with an `EXT-X-MAP`
 * initialisation segment. Concatenating that init segment with its fragments
 * produces a valid fragmented `.mp4` with no transcoding at all. Older streams
 * use MPEG-TS, which concatenates into a playable `.ts` but would need a real
 * remuxer to become an `.mp4`.
 */

export interface HlsVariant {
  url: string
  bandwidth: number
  resolution?: string
}

export interface HlsMedia {
  /** `EXT-X-MAP` initialisation segment, present for fragmented MP4 streams. */
  initUrl?: string
  segmentUrls: string[]
  isFragmentedMp4: boolean
}

function resolve(reference: string, base: string): string {
  return new URL(reference, base).toString()
}

function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Values may be quoted and contain commas, so split on commas outside quotes.
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    const [, key, raw] = match
    if (key) out[key] = (raw ?? '').replace(/^"|"$/g, '')
  }
  return out
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF')
}

/** Parse a master playlist's variant list, best quality first. */
export function parseMaster(text: string, baseUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/)
  const variants: HlsVariant[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line?.startsWith('#EXT-X-STREAM-INF')) continue

    // The URI is the next non-comment line.
    let uri: string | undefined
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]?.trim()
      if (candidate && !candidate.startsWith('#')) {
        uri = candidate
        break
      }
    }
    if (!uri) continue

    const attrs = attributes(line)
    variants.push({
      url: resolve(uri, baseUrl),
      bandwidth: Number(attrs.BANDWIDTH ?? attrs['AVERAGE-BANDWIDTH'] ?? 0),
      resolution: attrs.RESOLUTION,
    })
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth)
}

export function parseMedia(text: string, baseUrl: string): HlsMedia {
  const lines = text.split(/\r?\n/)
  const segmentUrls: string[] = []
  let initUrl: string | undefined

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#EXT-X-MAP')) {
      const uri = attributes(line).URI
      if (uri) initUrl = resolve(uri, baseUrl)
      continue
    }
    if (line.startsWith('#')) continue
    segmentUrls.push(resolve(line, baseUrl))
  }

  const first = segmentUrls[0] ?? ''
  const isFragmentedMp4 = Boolean(initUrl) || /\.(m4s|mp4)(\?|$)/i.test(first)
  return { initUrl, segmentUrls, isFragmentedMp4 }
}

export interface AssembledStream {
  blob: Blob
  extension: 'mp4' | 'ts'
  segmentCount: number
  /** True when the output is MPEG-TS, which most players handle but some do not. */
  needsRemux: boolean
}

/**
 * Fetch a playlist and join its segments into a single file.
 *
 * Segments are fetched with bounded concurrency but written in playlist order,
 * because concatenating them out of order produces a corrupt file.
 */
export async function assembleStream(
  playlistUrl: string,
  options: {
    concurrency?: number
    onProgress?: (done: number, total: number) => void
    signal?: AbortSignal
  } = {},
): Promise<AssembledStream> {
  const concurrency = options.concurrency ?? 6

  const fetchText = async (url: string) => {
    const response = await fetch(url, { signal: options.signal, credentials: 'include' })
    if (!response.ok) throw new Error(`Playlist request failed (${response.status})`)
    return response.text()
  }

  let text = await fetchText(playlistUrl)
  let mediaUrl = playlistUrl

  // Fail with something the user can act on. An MPD is XML and would otherwise
  // parse as a playlist with zero segments, which explains nothing.
  if (!text.includes('#EXTM3U')) {
    throw new Error(
      /<MPD|urn:mpeg:dash/i.test(text)
        ? 'This is a DASH stream, which cannot be assembled yet. Look for an MP4 on the page.'
        : 'That link is not an HLS playlist',
    )
  }

  if (isMasterPlaylist(text)) {
    const best = parseMaster(text, playlistUrl)[0]
    if (!best) throw new Error('The master playlist listed no streams')
    mediaUrl = best.url
    text = await fetchText(mediaUrl)
  }

  const media = parseMedia(text, mediaUrl)
  if (media.segmentUrls.length === 0) throw new Error('The playlist listed no segments')

  const urls = media.initUrl ? [media.initUrl, ...media.segmentUrls] : media.segmentUrls
  const parts = new Array<ArrayBuffer>(urls.length)
  let done = 0
  let next = 0

  const worker = async () => {
    while (next < urls.length) {
      const index = next++
      const url = urls[index]!
      const response = await fetch(url, { signal: options.signal, credentials: 'include' })
      if (!response.ok) throw new Error(`Segment ${index + 1} failed (${response.status})`)
      parts[index] = await response.arrayBuffer()
      options.onProgress?.(++done, urls.length)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))

  return {
    blob: new Blob(parts as BlobPart[], {
      type: media.isFragmentedMp4 ? 'video/mp4' : 'video/mp2t',
    }),
    extension: media.isFragmentedMp4 ? 'mp4' : 'ts',
    segmentCount: media.segmentUrls.length,
    needsRemux: !media.isFragmentedMp4,
  }
}
