/**
 * End-to-end capture tests.
 *
 * Loads the built extension into a real Chrome, captures fixture pages whose
 * geometry we know exactly, then samples the stitched image at each band's page
 * coordinate. That verifies the page-coordinate -> image-coordinate mapping
 * directly, rather than eyeballing a screenshot.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ROOT_SCRATCH = process.env.AIO_BROWSERS ?? join(ROOT, '.browsers')
// Chrome for Testing: stock Chrome disabled the --load-extension switch in M137,
// so automation needs the build that still honours it. Override with CHROME_PATH.
const CHROME =
  process.env.CHROME_PATH ??
  (() => {
    const base = join(ROOT_SCRATCH, 'chrome')
    let build
    try {
      build = readdirSync(base).find((name) => name.startsWith('mac'))
    } catch {
      build = undefined
    }
    if (!build) {
      throw new Error(
        `No Chrome for Testing under ${base}.\n` +
          `Run "npm run test:browser" once, or set CHROME_PATH / AIO_BROWSERS.`,
      )
    }
    return join(
      base,
      build,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    )
  })()
const PORT = 8731

// --- tiny PNG encoder, for the artificially delayed lazy-load images ---------

function crc32(buffer) {
  let c = ~0
  for (const byte of buffer) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function solidPng(hex, size = 64) {
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${PORT}`)

    // --- HLS fixtures: a master playlist, fMP4 and MPEG-TS variants ---------
    if (url.pathname === '/hls/master.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
          'high.m3u8',
        ].join('\n'),
      )
      return
    }
    const media = url.pathname.match(/^\/hls\/(low|high)\.m3u8$/)
    if (media) {
      const name = media[1]
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(
        [
          '#EXTM3U',
          '#EXT-X-MAP:URI="init.mp4"',
          ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:4.0,', `${name}-${i}.m4s`]),
          '#EXT-X-ENDLIST',
        ].join('\n'),
      )
      return
    }
    if (url.pathname === '/hls/ts.m3u8') {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      response.end(
        ['#EXTM3U', ...[0, 1, 2].flatMap((i) => ['#EXTINF:4.0,', `seg-${i}.ts`]), '#EXT-X-ENDLIST'].join('\n'),
      )
      return
    }
    if (url.pathname === '/hls/stream.mpd') {
      response.writeHead(200, { 'content-type': 'application/dash+xml' })
      response.end(
        '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"></MPD>',
      )
      return
    }
    if (url.pathname === '/hls/init.mp4') {
      response.writeHead(200, { 'content-type': 'video/mp4' })
      response.end(Buffer.alloc(100, 1))
      return
    }
    const segment = url.pathname.match(/^\/hls\/(?:low|high)-(\d)\.m4s$/)
    if (segment) {
      response.writeHead(200, { 'content-type': 'video/iso.segment' })
      response.end(Buffer.alloc(1000 + Number(segment[1]), 2))
      return
    }
    const tsSegment = url.pathname.match(/^\/hls\/seg-(\d)\.ts$/)
    if (tsSegment) {
      response.writeHead(200, { 'content-type': 'video/mp2t' })
      response.end(Buffer.alloc(500, 3))
      return
    }

    // --- a plain progressive file, for the request watcher -------------------
    const clip = url.pathname.match(/^\/media\/([\w-]+)\.(mp4|webm)$/)
    if (clip) {
      const body = Buffer.alloc(4096, 7)
      response.writeHead(200, {
        'content-type': clip[2] === 'mp4' ? 'video/mp4' : 'video/webm',
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
      })
      response.end(body)
      return
    }

    const image = url.pathname.match(/^\/img\/([0-9a-f]{6})\.png$/)
    if (image) {
      // Slow enough that an unprimed capture would photograph empty boxes.
      await new Promise((resolve) => setTimeout(resolve, 300))
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(solidPng(image[1]))
      return
    }

    try {
      const body = await readFile(join(HERE, 'fixtures', url.pathname.replace(/^\//, '')))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)))
}

// --- driving the extension ---------------------------------------------------

/** Ask the worker to capture, then sample the result. Runs inside an extension page. */
const captureAndSample = async ({ tabId, mode, samples, sampleXRatio }) => {
  const reply = await chrome.runtime.sendMessage({
    __aio: true,
    name: 'capture:run',
    payload: { tabId, mode, format: 'png' },
  })
  if (!reply?.ok) throw new Error(reply?.error ?? 'capture:run did not reply')
  const shots = reply.value

  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('all-in-one', 1)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const readShot = (id) =>
    new Promise((resolve, reject) => {
      const request = db.transaction('shots', 'readonly').objectStore('shots').get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

  const scale = shots[0].scale
  const first = await readShot(shots[0].id)
  const bitmap = await createImageBitmap(first.blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)

  const readings = samples.map((sample) => {
    const x = Math.round(bitmap.width * sampleXRatio)
    const y = Math.round(sample.centerY * scale)
    const [r, g, b] = ctx.getImageData(Math.min(x, bitmap.width - 1), Math.min(y, bitmap.height - 1), 1, 1).data
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
    return { index: sample.index, expected: sample.color, actual: hex, y }
  })

  return { shots, readings, width: bitmap.width, height: bitmap.height, scale }
}

/** Read each band's real offset inside whatever element scrolls. */
const readBands = () => {
  const feed = document.getElementById('feed')
  const bands = [...document.querySelectorAll('.band, img[data-color]')]
  const originY = feed ? feed.getBoundingClientRect().top - feed.scrollTop : -window.scrollY
  return {
    scrollHeight: feed ? feed.scrollHeight : document.documentElement.scrollHeight,
    dpr: window.devicePixelRatio,
    bands: bands.map((element) => {
      const rect = element.getBoundingClientRect()
      const top = rect.top - originY
      return {
        index: Number(element.dataset.index),
        color: element.dataset.color,
        centerY: top + rect.height / 2,
      }
    }),
  }
}

function near(expected, actual, tolerance = 6) {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [er, eg, eb] = parse(expected)
  const [ar, ag, ab] = parse(actual)
  return (
    Math.abs(er - ar) <= tolerance && Math.abs(eg - ag) <= tolerance && Math.abs(eb - ab) <= tolerance
  )
}

const CASES = [
  { name: 'long page', file: 'long.html', dpr: 1, sampleXRatio: 0.55 },
  { name: 'inner scroll container', file: 'inner.html', dpr: 1, sampleXRatio: 0.55 },
  { name: 'lazy-loaded images', file: 'lazy.html', dpr: 1, sampleXRatio: 0.5 },
]

/**
 * Run every fixture against one browser configuration.
 *
 * `extraArgs` lets a second pass run at a real 2x device scale, which is the
 * only way to exercise the scale maths: headless Chrome hands back unscaled
 * tiles even when the page's own devicePixelRatio is 2.
 */
async function runSuite(label, extraArgs) {
  console.log(`\n########## ${label} ##########`)
  const failures = []
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...extraArgs,
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (target) =>
        target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host

    // The driver sits in the same window as a background tab, so the fixture
    // stays the active tab and is what captureVisibleTab actually photographs.
    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    for (const testCase of CASES) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: testCase.dpr })
      await page.goto(`http://localhost:${PORT}/${testCase.file}`, { waitUntil: 'load' })
      await page.bringToFront()

      const info = await page.evaluate(readBands)
      const tabId = await driver.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url })
        return tab.id
      }, `http://localhost:${PORT}/${testCase.file}`)

      const started = Date.now()
      let outcome
      try {
        outcome = await driver.evaluate(captureAndSample, {
          tabId,
          mode: 'full',
          samples: info.bands,
          sampleXRatio: testCase.sampleXRatio,
        })
      } catch (error) {
        failures.push(`[${label}] ${testCase.name}: capture threw - ${error.message}`)
        await page.close()
        continue
      }
      const elapsed = ((Date.now() - started) / 1000).toFixed(1)

      const expectedHeight = Math.round(info.scrollHeight * outcome.scale)
      const heightOff = Math.abs(outcome.height - expectedHeight)
      const bad = outcome.readings.filter((r) => !near(r.expected, r.actual))

      console.log(`\n${testCase.name}  (${elapsed}s)`)
      console.log(
        `  image ${outcome.width}x${outcome.height}px at scale ${outcome.scale}, ` +
          `expected height ~${expectedHeight} (off by ${heightOff})`,
      )
      console.log(`  parts: ${outcome.shots.length}, bands checked: ${outcome.readings.length}`)
      if (bad.length) {
        for (const r of bad) {
          console.log(`  band ${r.index} at y=${r.y}: expected ${r.expected}, got ${r.actual}`)
        }
        failures.push(`[${label}] ${testCase.name}: ${bad.length}/${outcome.readings.length} bands wrong`)
      } else {
        console.log('  all bands landed at the right offset')
      }
      if (heightOff > 4 * outcome.scale) {
        failures.push(`[${label}] ${testCase.name}: image height off by ${heightOff}px`)
      }

      await page.close()
    }
  } finally {
    await browser.close()
  }
  return failures
}

// --- media -------------------------------------------------------------------

function check(failures, label, condition, detail) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition ? '' : ` - ${detail}`}`)
  if (!condition) failures.push(`[hls] ${label}: ${detail}`)
}

/**
 * Exercise the playlist parser and assembler directly in Node, against the same
 * fixture server the browser uses. Node strips the TypeScript natively.
 */
async function runHlsTests() {
  console.log(`\n########## hls assembly ##########`)
  const failures = []
  const { assembleStream, parseMaster, isMasterPlaylist } = await import('../src/lib/hls.ts')
  const base = `http://localhost:${PORT}/hls/`

  const masterText = await (await fetch(base + 'master.m3u8')).text()
  check(failures, 'master playlist is recognised', isMasterPlaylist(masterText), 'not detected')

  const variants = parseMaster(masterText, base + 'master.m3u8')
  check(
    failures,
    'variants sorted best-first',
    variants[0]?.bandwidth === 2400000 && variants[0]?.url.endsWith('high.m3u8'),
    `got ${variants[0]?.bandwidth} ${variants[0]?.url}`,
  )

  // init(100) + segments 1000+1001+1002+1003
  const fmp4 = await assembleStream(base + 'master.m3u8')
  const expectedSize = 100 + 1000 + 1001 + 1002 + 1003
  check(failures, 'fMP4 stream assembles to exact byte length',
    fmp4.blob.size === expectedSize, `expected ${expectedSize}, got ${fmp4.blob.size}`)
  check(failures, 'fMP4 stream saves as .mp4 without remuxing',
    fmp4.extension === 'mp4' && fmp4.needsRemux === false,
    `got .${fmp4.extension}, needsRemux=${fmp4.needsRemux}`)
  check(failures, 'segment count excludes the init segment',
    fmp4.segmentCount === 4, `got ${fmp4.segmentCount}`)

  // Segments must be joined in playlist order, not completion order.
  const bytes = new Uint8Array(await fmp4.blob.arrayBuffer())
  check(failures, 'init segment is written first',
    bytes[0] === 1 && bytes[99] === 1 && bytes[100] === 2, 'ordering is wrong')

  let dashError = ''
  try {
    await assembleStream(base + 'stream.mpd')
  } catch (error) {
    dashError = error.message
  }
  check(failures, 'a DASH manifest fails with an explanation, not a parse error',
    /DASH/i.test(dashError), `got ${JSON.stringify(dashError)}`)

  const ts = await assembleStream(base + 'ts.m3u8')
  check(failures, 'MPEG-TS stream assembles and flags remux',
    ts.blob.size === 1500 && ts.extension === 'ts' && ts.needsRemux === true,
    `got ${ts.blob.size} bytes, .${ts.extension}, needsRemux=${ts.needsRemux}`)

  return failures
}

/** Does the request watcher plus DOM scan actually find a page's video? */
async function runMediaSuite() {
  console.log(`\n########## media detection ##########`)
  const failures = []
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host
    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    const page = await browser.newPage()
    await page.goto(`http://localhost:${PORT}/video.html`, { waitUntil: 'load' })
    await page.bringToFront()
    // Give the video element time to actually request the file.
    await new Promise((r) => setTimeout(r, 1500))

    const tabId = await driver.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url })
      return tab.id
    }, `http://localhost:${PORT}/video.html`)

    const ask = (name, payload) =>
      driver.evaluate(async (n, p) => {
        const reply = await chrome.runtime.sendMessage({ __aio: true, name: n, payload: p })
        if (!reply?.ok) throw new Error(reply?.error ?? `no reply to ${n}`)
        return reply.value
      }, name, payload)

    // The registry has no UI message any more, so read the store directly. It
    // still matters: resolving a pasted link depends on it.
    const listMedia = (id) =>
      driver.evaluate(async (key) => {
        const stored = await chrome.storage.session.get(key)
        return stored[key] ?? []
      }, `media:${id}`)

    const watched = await listMedia(tabId)
    const clip = watched.find((item) => item.url.includes('/media/clip.mp4'))
    check(failures, 'request watcher sees the playing video',
      Boolean(clip), `saw ${watched.length} items: ${watched.map((i) => i.url).join(', ')}`)
    if (clip) {
      check(failures, 'watcher classifies it as a video',
        clip.kind === 'mp4', `got kind=${clip.kind}`)
      check(failures, 'watcher records the size from headers',
        clip.bytes === 4096, `got bytes=${clip.bytes}`)
    }



    // Navigating away must not leave the previous page's media behind.
    await page.goto(`http://localhost:${PORT}/long.html`, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 800))
    const afterNav = await listMedia(tabId)
    check(failures, 'registry clears on navigation',
      afterNav.every((i) => !i.url.includes('/media/clip.mp4')), `still had ${afterNav.length}`)
  } finally {
    await browser.close()
  }
  return failures.map((f) => (f.startsWith('[hls]') ? f.replace('[hls]', '[media]') : f))
}

/**
 * The X resolver's pure parts. The live endpoint and its token derivation are
 * confirmed separately by `node test/probe-x.mjs`; this pins the parsing against
 * the payload shape the endpoint returns.
 */
async function runResolverTests() {
  console.log(`\n########## x resolver ##########`)
  const failures = []
  const { syndicationToken, tweetId, variantsFrom } = await import('../src/background/media.ts')

  check(failures, 'reads an id from an x.com link',
    tweetId('https://x.com/someone/status/1899999999999999999') === '1899999999999999999',
    'no match')
  check(failures, 'reads an id from a twitter.com link with a query string',
    tweetId('https://twitter.com/someone/status/1234567890?s=20&t=abc') === '1234567890',
    'no match')
  check(failures, 'ignores a profile link',
    tweetId('https://x.com/someone') === undefined, 'matched something')
  check(failures, 'token derivation is deterministic',
    syndicationToken('20') === syndicationToken('20') && syndicationToken('20').length > 0,
    'unstable or empty')

  // Shape returned by the syndication endpoint for a post carrying a video.
  const videoPayload = {
    __typename: 'Tweet',
    id_str: '1234567890123456789',
    mediaDetails: [
      {
        type: 'video',
        video_info: {
          aspect_ratio: [16, 9],
          duration_millis: 30000,
          variants: [
            { bitrate: 288000, content_type: 'video/mp4', url: 'https://video.twimg.com/a/480x270/a.mp4?tag=12' },
            { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/a/1280x720/c.mp4?tag=12' },
            { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/a/640x360/b.mp4?tag=12' },
            { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/a/d.m3u8?tag=12' },
          ],
        },
      },
    ],
  }

  const items = variantsFrom(videoPayload)
  check(failures, 'finds every variant regardless of nesting depth',
    items.length === 4, `got ${items.length}`)
  check(failures, 'puts the highest-bitrate mp4 first',
    items[0]?.url.includes('1280x720') && items[0]?.kind === 'mp4',
    `got ${items[0]?.url}`)
  check(failures, 'orders the remaining mp4s by descending bitrate',
    items[1]?.url.includes('640x360') && items[2]?.url.includes('480x270'),
    `got ${items[1]?.url}, ${items[2]?.url}`)
  check(failures, 'classifies the playlist as hls and ranks it last',
    items[3]?.kind === 'hls', `got ${items[3]?.kind}`)
  check(failures, 'labels variants with bitrate and rendition size',
    items[0]?.label === '2176 kbps - 1280x720', `got ${items[0]?.label}`)
  check(failures, 'records rendition dimensions',
    items[0]?.width === 1280 && items[0]?.height === 720,
    `got ${items[0]?.width}x${items[0]?.height}`)

  const duplicated = variantsFrom({ a: videoPayload.mediaDetails, b: videoPayload.mediaDetails })
  check(failures, 'deduplicates a variant seen twice',
    duplicated.length === 4, `got ${duplicated.length}`)

  const { normaliseMediaUrl } = await import('../src/background/media.ts')
  const ranged =
    'https://cdn.example.com/o1/v/t2/clip.mp4?_nc_ht=x&oh=abc&oe=123&bytestart=0&byteend=1023'
  check(failures, 'strips byte-range params so one file is one entry',
    normaliseMediaUrl(ranged) ===
      'https://cdn.example.com/o1/v/t2/clip.mp4?_nc_ht=x&oh=abc&oe=123',
    normaliseMediaUrl(ranged))
  check(failures, 'two ranges of one file normalise to the same url',
    normaliseMediaUrl(ranged) ===
      normaliseMediaUrl(ranged.replace('bytestart=0&byteend=1023', 'bytestart=1024&byteend=2047')),
    'ranges did not collapse')
  check(failures, 'keeps signature params a CDN needs',
    normaliseMediaUrl(ranged).includes('oh=abc') && normaliseMediaUrl(ranged).includes('oe=123'),
    'dropped a signature param')
  check(failures, 'leaves a url without range params untouched',
    normaliseMediaUrl('https://x.test/a.mp4?tag=1') === 'https://x.test/a.mp4?tag=1',
    normaliseMediaUrl('https://x.test/a.mp4?tag=1'))

  check(failures, 'a photo-only post yields nothing',
    variantsFrom({ mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/x.jpg' }] }).length === 0,
    'found variants where there are none')

  return failures.map((f) => f.replace('[hls]', '[resolver]'))
}

/** Variance of luminance over a region - a direct measure of "is this detailed?" */
const regionVariance = (ctx, x, y, w, h) => {
  const { data } = ctx.getImageData(x, y, w, h)
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    sum += lum
    sumSq += lum * lum
    n++
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

/**
 * Drive the real annotation editor: capture a high-detail page, drag the blur
 * tool over part of it, and measure that the region actually lost its detail
 * while the rest of the image did not.
 */
async function runEditorSuite() {
  console.log(`\n########## annotation editor ##########`)
  const failures = []
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host
    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(`http://localhost:${PORT}/detail.html`, { waitUntil: 'load' })
    await page.bringToFront()

    const tabId = await driver.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url })
      return tab.id
    }, `http://localhost:${PORT}/detail.html`)

    const shots = await driver.evaluate(async (id) => {
      const reply = await chrome.runtime.sendMessage({
        __aio: true,
        name: 'capture:run',
        payload: { tabId: id, mode: 'full', format: 'png' },
      })
      if (!reply?.ok) throw new Error(reply?.error ?? 'capture failed')
      return reply.value
    }, tabId)
    check(failures, 'captured the detail page', shots.length === 1, `got ${shots.length} parts`)

    const editor = await browser.newPage()
    // The variance helper lives in Node; inject it before the page runs.
    await editor.evaluateOnNewDocument((source) => {
      window.__variance = new Function(`return (${source})`)()
    }, regionVariance.toString())
    await editor.goto(`chrome-extension://${extensionId}/src/editor/index.html?id=${shots[0].id}`)
    await editor.bringToFront()
    await editor.waitForFunction(() => {
      const canvas = document.querySelector('canvas')
      return canvas && canvas.width > 0
    }, { timeout: 15000 })
    check(failures, 'editor loaded the capture', true, '')

    // Baseline detail before any annotation.
    const before = await editor.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      return {
        width: canvas.width,
        height: canvas.height,
        inside: window.__variance(ctx, 60, 60, 120, 120),
        outside: window.__variance(ctx, canvas.width - 180, canvas.height - 180, 120, 120),
      }
    })
    check(failures, 'capture has fine detail to begin with',
      before.inside > 1000, `variance was only ${before.inside.toFixed(0)}`)

    // Select Blur, then drag a box over the top-left of the image.
    await editor.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Blur')
      button.click()
    })
    const box = await editor.evaluate(() => {
      const rect = document.querySelector('canvas').getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    })
    const canvasBox = await editor.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const rect = canvas.getBoundingClientRect()
      return { cssToCanvas: canvas.width / rect.width }
    })
    // Cover canvas pixels roughly (40,40)-(260,260) with the drag.
    const startX = box.left + 40 / canvasBox.cssToCanvas
    const startY = box.top + 40 / canvasBox.cssToCanvas
    const endX = box.left + 260 / canvasBox.cssToCanvas
    const endY = box.top + 260 / canvasBox.cssToCanvas

    await editor.mouse.move(startX, startY)
    await editor.mouse.down()
    await editor.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 6 })
    await editor.mouse.move(endX, endY, { steps: 6 })
    await editor.mouse.up()
    await new Promise((r) => setTimeout(r, 300))

    const after = await editor.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      return {
        inside: window.__variance(ctx, 60, 60, 120, 120),
        outside: window.__variance(ctx, canvas.width - 180, canvas.height - 180, 120, 120),
      }
    })

    // Deliberately strict: a mosaic built by scaling a canvas down and back up
    // only reaches ~0.5 here, because the downscale point-samples instead of
    // averaging and each block keeps one original pixel. True block averaging
    // lands near zero, so this threshold is what separates real redaction from
    // one that leaves high-contrast text readable.
    check(failures, 'blur destroys detail inside the region',
      after.inside < before.inside * 0.05,
      `variance ${before.inside.toFixed(0)} -> ${after.inside.toFixed(0)}`)
    check(failures, 'blur leaves the rest of the image untouched',
      Math.abs(after.outside - before.outside) < before.outside * 0.05,
      `variance ${before.outside.toFixed(0)} -> ${after.outside.toFixed(0)}`)

    // Undo should put the detail back.
    await editor.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Undo')
      button.click()
    })
    await new Promise((r) => setTimeout(r, 300))
    const undone = await editor.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      return window.__variance(ctx, 60, 60, 120, 120)
    })
    check(failures, 'undo restores the redacted detail',
      undone > before.inside * 0.9, `variance came back as ${undone.toFixed(0)}`)

    return failures.map((f) => f.replace('[hls]', '[editor]'))
  } finally {
    await browser.close()
  }
}

/** CSV/JSON and PDF conversion are pure enough to exercise directly in Node. */
async function runConverterTests() {
  console.log(`\n########## converters ##########`)
  const failures = []
  const { parseCsv, csvToJson, jsonToCsv, csvToMarkdown } = await import(
    '../src/lib/convert/tabular.ts'
  )

  // The cases a naive split(',') gets wrong.
  const tricky = 'name,note,size\r\n"Smith, Alice","said ""hi""",3\r\n"multi\nline",plain,4\r\n'
  const rows = parseCsv(tricky)
  check(failures, 'parses a quoted field containing a comma',
    rows[1]?.[0] === 'Smith, Alice', `got ${JSON.stringify(rows[1]?.[0])}`)
  check(failures, 'unescapes doubled quotes',
    rows[1]?.[1] === 'said "hi"', `got ${JSON.stringify(rows[1]?.[1])}`)
  check(failures, 'keeps a newline inside a quoted field',
    rows[2]?.[0] === 'multi\nline', `got ${JSON.stringify(rows[2]?.[0])}`)
  check(failures, 'handles CRLF endings and no trailing blank row',
    rows.length === 3, `got ${rows.length} rows`)

  check(failures, 'strips a UTF-8 BOM',
    parseCsv('\uFEFFa,b\n1,2')[0]?.[0] === 'a', 'BOM leaked into the first header')

  const objects = csvToJson(tricky)
  check(failures, 'csv to json keys rows by header',
    objects[0]?.name === 'Smith, Alice' && objects[0]?.size === '3',
    JSON.stringify(objects[0]))

  // Round-tripping must survive the delimiters and quotes it just parsed.
  const roundTripped = parseCsv(jsonToCsv(objects))
  check(failures, 'json to csv round-trips a tricky field',
    roundTripped[1]?.[0] === 'Smith, Alice' && roundTripped[1]?.[1] === 'said "hi"',
    JSON.stringify(roundTripped[1]))

  check(failures, 'json to csv unions keys across ragged rows',
    jsonToCsv([{ a: 1 }, { b: 2 }]).split('\n')[0] === 'a,b',
    jsonToCsv([{ a: 1 }, { b: 2 }]).split('\n')[0])
  check(failures, 'json to csv handles a list of primitives',
    jsonToCsv([1, 2]).startsWith('value'), jsonToCsv([1, 2]))

  const table = csvToMarkdown('a,b\n1,2')
  check(failures, 'csv to markdown emits a header separator',
    table.split('\n')[1] === '| --- | --- |', JSON.stringify(table.split('\n')[1]))
  check(failures, 'csv to markdown escapes pipes',
    csvToMarkdown('a\n"x|y"').includes('x\\|y'), csvToMarkdown('a\n"x|y"'))

  const { sniffDelimiter } = await import('../src/lib/convert/tabular.ts')

  check(failures, 'detects tab-separated data',
    sniffDelimiter('a\tb\tc\n1\t2\t3') === '\t', 'did not pick tab')
  check(failures, 'detects semicolon-separated data',
    sniffDelimiter('a;b;c\n1;2;3') === ';', 'did not pick semicolon')
  check(failures, 'still detects commas',
    sniffDelimiter('a,b,c\n1,2,3') === ',', 'did not pick comma')
  check(failures, 'a comma inside a quoted field does not outvote real tabs',
    sniffDelimiter('name\tnote\n"Smith, Alice"\thello') === '\t', 'quoted comma won')

  const tsv = csvToJson('name\tnote\tsize\nAlice\thello\t3')
  check(failures, 'a TSV file parses into real columns',
    tsv[0]?.name === 'Alice' && tsv[0]?.size === '3', JSON.stringify(tsv[0]))
  const semi = csvToJson('name;note\nAlice;hello')
  check(failures, 'a semicolon CSV parses into real columns',
    semi[0]?.name === 'Alice' && semi[0]?.note === 'hello', JSON.stringify(semi[0]))
  check(failures, 'an explicit delimiter still overrides sniffing',
    csvToJson('a;b\n1;2', ',')['0']?.['a;b'] === '1;2', 'override ignored')

  // --- PDF -------------------------------------------------------------------
  const { PDFDocument } = await import('pdf-lib')
  const { mergePdfs, extractPages, rotatePdf, burstPdf, parsePageRanges, pageCount } = await import(
    '../src/lib/convert/pdf.ts'
  )

  const makePdf = async (pages) => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) doc.addPage([200, 200])
    return doc.save()
  }

  check(failures, 'page ranges parse mixed lists',
    JSON.stringify(parsePageRanges('1-3, 5', 10)) === JSON.stringify([0, 1, 2, 4]),
    JSON.stringify(parsePageRanges('1-3, 5', 10)))
  check(failures, 'an open-ended range runs to the last page',
    JSON.stringify(parsePageRanges('8-', 10)) === JSON.stringify([7, 8, 9]),
    JSON.stringify(parsePageRanges('8-', 10)))
  check(failures, 'an empty selection means every page',
    parsePageRanges('', 4).length === 4, 'did not select all')
  check(failures, 'out-of-range pages are ignored',
    JSON.stringify(parsePageRanges('3, 99', 4)) === JSON.stringify([2]),
    JSON.stringify(parsePageRanges('3, 99', 4)))

  const merged = await mergePdfs([await makePdf(2), await makePdf(3)])
  check(failures, 'merge concatenates page counts',
    (await pageCount(merged)) === 5, `got ${await pageCount(merged)}`)

  const extracted = await extractPages(await makePdf(6), '2-3, 6')
  check(failures, 'extract keeps only the selected pages',
    (await pageCount(extracted)) === 3, `got ${await pageCount(extracted)}`)

  const burst = await burstPdf(await makePdf(4))
  check(failures, 'burst produces one file per page',
    burst.length === 4, `got ${burst.length}`)

  const rotated = await rotatePdf(await makePdf(2), 90, '1')
  const rotatedDoc = await PDFDocument.load(rotated)
  check(failures, 'rotate turns only the selected page',
    rotatedDoc.getPage(0).getRotation().angle === 90 &&
      rotatedDoc.getPage(1).getRotation().angle === 0,
    `got ${rotatedDoc.getPage(0).getRotation().angle} and ${rotatedDoc.getPage(1).getRotation().angle}`)

  const twice = await PDFDocument.load(await rotatePdf(rotated, 90, '1'))
  check(failures, 'rotation accumulates rather than resetting',
    twice.getPage(0).getRotation().angle === 180, `got ${twice.getPage(0).getRotation().angle}`)

  // --- XLSX ------------------------------------------------------------------
  const { rowsToXlsx } = await import('../src/lib/convert/xlsx.ts')
  const { unzipSync, strFromU8 } = await import('fflate')

  const book = rowsToXlsx([['name', 'qty', 'code'], ['Smith, Alice', '42', '007']], 'People')
  const bytes = new Uint8Array(await book.arrayBuffer())
  check(failures, 'xlsx is a zip', bytes[0] === 0x50 && bytes[1] === 0x4b,
    `starts ${bytes[0]},${bytes[1]}`)

  const entries = unzipSync(bytes)
  const required = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']
  check(failures, 'xlsx contains every part a reader needs',
    required.every((name) => name in entries), Object.keys(entries).join(', '))

  const sheet = strFromU8(entries['xl/worksheets/sheet1.xml'])
  check(failures, 'a number becomes a numeric cell', sheet.includes('<v>42</v>'), sheet.slice(0, 200))
  check(failures, 'text stays an inline string',
    sheet.includes('Smith, Alice') && sheet.includes('inlineStr'), 'not inline')
  // Turning "007" into 7 would silently destroy an identifier.
  check(failures, 'a leading zero is kept as text',
    sheet.includes('>007<') && !sheet.includes('<v>007</v>'), 'leading zero was coerced')
  check(failures, 'the sheet name carries through',
    strFromU8(entries['xl/workbook.xml']).includes('People'), 'sheet name missing')

  return failures.map((f) => f.replace('[hls]', '[convert]'))
}

/** Clip a page with deliberate boilerplate and check what survives. */
async function runClipperSuite() {
  console.log(`\n########## article clipper ##########`)
  const failures = []
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host
    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    const page = await browser.newPage()
    const articleUrl = `http://localhost:${PORT}/article.html`
    await page.goto(articleUrl, { waitUntil: 'load' })

    const tabId = await driver.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url })
      return tab.id
    }, articleUrl)

    const article = await driver.evaluate(async (id) => {
      const reply = await chrome.tabs.sendMessage(id, {
        __aio: true,
        name: 'clip:article',
        payload: undefined,
      })
      if (!reply?.ok) throw new Error(reply?.error ?? 'no reply from clipper')
      return reply.value
    }, tabId)

    const md = article.markdown
    check(failures, 'extracts the title',
      article.title === 'Tidal Patterns in Coastal Estuaries', `got ${JSON.stringify(article.title)}`)
    check(failures, 'counts the words', article.wordCount > 100, `got ${article.wordCount}`)

    for (const [what, marker] of [
      ['navigation', 'NAVMARKERALPHA'],
      ['adverts', 'SPONSORMARKERGAMMA'],
      ['the footer', 'FOOTERMARKERETA'],
    ]) {
      check(failures, `strips ${what}`, !md.includes(marker), `${marker} survived the clip`)
    }

    check(failures, 'keeps the article body',
      md.includes('UNIQUEHEADINGDELTA'), 'heading missing')
    check(failures, 'renders headings as atx',
      /^## UNIQUEHEADINGDELTA$/m.test(md), 'heading was not "## ..."')
    // Turndown pads the marker to four columns ("-   item"), which is valid
    // CommonMark, so match any run of whitespace after the bullet.
    check(failures, 'renders bullet lists',
      /^-\s+Surface readings/m.test(md), 'list item missing')
    check(failures, 'renders tables as pipe tables',
      md.includes('| Station |') && /\|\s*---\s*\|/.test(md), 'table missing or not a pipe table')
    check(failures, 'resolves relative links to absolute',
      md.includes(`http://localhost:${PORT}/methods`), 'link left relative')
    check(failures, 'resolves relative image sources to absolute',
      md.includes(`http://localhost:${PORT}/img/2563eb.png`), 'image left relative')
    check(failures, 'keeps figure captions',
      md.includes('CAPTIONMARKERZETA'), 'caption dropped')

    return failures.map((f) => f.replace('[hls]', '[clipper]'))
  } finally {
    await browser.close()
  }
}

/**
 * The popup closes as soon as the panel opens, so it hands work over through
 * storage. Which of the two lands first is a race, so the panel must cope with
 * an intent that arrives before *and* after it mounts.
 */
async function runIntentSuite() {
  console.log(`\n########## popup handoff ##########`)
  const failures = []
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host
    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)

    const setStorage = (value) =>
      driver.evaluate((v) => chrome.storage.local.set(v), value)

    const headingOf = async (page) =>
      page.evaluate(() => document.querySelector('main h2')?.textContent ?? '')

    const openPanel = async () => {
      const page = await browser.newPage()
      await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`)
      await new Promise((r) => setTimeout(r, 700))
      return page
    }

    // The popup lists every section, not just capture.
    const popupActions = await driver.evaluate(() =>
      [...document.querySelectorAll('button')].map((b) => b.textContent ?? ''),
    )
    check(failures, 'popup offers every section',
      ['Full page', 'Visible area', 'Record this tab', 'Record screen', 'Download media',
       'Clip article', 'Convert files']
        .every((label) => popupActions.some((text) => text.includes(label))),
      `saw: ${popupActions.map((t) => t.split('\n')[0]).join(' | ')}`)

    // An intent written before the panel opens.
    await setStorage({ 'magpie:intent': { section: 'clip', at: Date.now() } })
    let panel = await openPanel()
    check(failures, 'opens on the section the popup asked for',
      (await headingOf(panel)) === 'Clip', `heading was ${await headingOf(panel)}`)
    await panel.close()

    // Consumed, so the next open falls back rather than repeating.
    await setStorage({ 'magpie:section': 'convert' })
    panel = await openPanel()
    check(failures, 'an intent is consumed and does not fire twice',
      (await headingOf(panel)) === 'Convert', `heading was ${await headingOf(panel)}`)
    await panel.close()

    // A stale intent must not hijack a later, unrelated open.
    await setStorage({
      'magpie:intent': { section: 'media', at: Date.now() - 60_000 },
      'magpie:section': 'convert',
    })
    panel = await openPanel()
    check(failures, 'a stale intent is ignored',
      (await headingOf(panel)) === 'Convert', `heading was ${await headingOf(panel)}`)
    await panel.close()

    // The race: intent arrives after the panel is already up.
    await driver.evaluate(() => chrome.storage.local.remove('magpie:intent'))
    await setStorage({ 'magpie:section': 'shots' })
    panel = await openPanel()
    check(failures, 'panel starts on the remembered section',
      (await headingOf(panel)) === 'Screenshots', `heading was ${await headingOf(panel)}`)

    await setStorage({ 'magpie:intent': { section: 'media', at: Date.now() } })
    await new Promise((r) => setTimeout(r, 600))
    check(failures, 'an intent arriving after mount still switches the panel',
      (await headingOf(panel)) === 'Media', `heading was ${await headingOf(panel)}`)
    await panel.close()

    return failures.map((f) => f.replace('[hls]', '[handoff]'))
  } finally {
    await browser.close()
  }
}

/**
 * SVG through the real Convert panel.
 *
 * `createImageBitmap` refuses SVG in Chrome, so this is the path that used to
 * fail with an unexplained decode error. Driving the actual UI also exercises
 * file selection and the download call, not just the conversion function.
 */
async function runSvgSuite() {
  console.log(`\n########## svg conversion ##########`)
  const failures = []
  const downloads = mkdtempSync(join(tmpdir(), 'magpie-dl-'))
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host

    const cdp = await browser.target().createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
      eventsEnabled: true,
    })

    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await driver.evaluate(() =>
      chrome.storage.local.set({ 'magpie:intent': { section: 'convert', at: Date.now() } }),
    )

    const panel = await browser.newPage()
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`)
    await new Promise((r) => setTimeout(r, 700))

    const convert = async (file, label) => {
      const input = await panel.$('input[type=file]')
      await input.uploadFile(join(HERE, 'fixtures', file))
      await new Promise((r) => setTimeout(r, 400))

      const clicked = await panel.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === 'Convert',
        )
        if (!button) return false
        button.click()
        return true
      })
      check(failures, `${label}: the Convert action is offered`, clicked, 'no Convert button')
      if (!clicked) return null

      await new Promise((r) => setTimeout(r, 1800))
      return panel.evaluate(() => {
        const text = document.body.innerText
        return {
          converted: /Converted \d+ image/.test(text),
          decodeError: /could not be decoded/i.test(text),
          body: text.slice(0, 300),
        }
      })
    }

    const sized = await convert('vector-sized.svg', 'sized SVG')
    if (sized) {
      check(failures, 'an SVG with width/height converts without a decode error',
        sized.converted && !sized.decodeError, sized.body.replace(/\n/g, ' | '))
    }

    // Clear the selection, then try one that only has a viewBox.
    await panel.evaluate(() => {
      const input = document.querySelector('input[type=file]')
      input.value = ''
    })
    const viewbox = await convert('vector-viewbox.svg', 'viewBox-only SVG')
    if (viewbox) {
      check(failures, 'an SVG with only a viewBox converts too',
        viewbox.converted && !viewbox.decodeError, viewbox.body.replace(/\n/g, ' | '))
    }

    // Whatever landed on disk should be a real PNG of a sensible size.
    await new Promise((r) => setTimeout(r, 1200))
    const files = readdirSync(downloads).filter((f) => f.endsWith('.png'))
    check(failures, 'converted files are written to disk', files.length >= 1,
      `found ${JSON.stringify(readdirSync(downloads))}`)

    for (const name of files) {
      const bytes = readFileSync(join(downloads, name))
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      // PNG stores dimensions big-endian at offsets 16 and 20 of the IHDR.
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)
      console.log(`       ${name} -> ${width}x${height}`)
      check(failures, `${name} is a valid PNG`, isPng, 'bad signature')
      // 120x60 keeps its declared size; the viewBox-only one renders at 1024 wide.
      check(failures, `${name} has sensible dimensions`,
        (width === 120 && height === 60) || (width === 1024 && height === 512),
        `got ${width}x${height}`)
    }

    return failures.map((f) => f.replace('[hls]', '[svg]'))
  } finally {
    await browser.close()
    rmSync(downloads, { recursive: true, force: true })
  }
}

/**
 * Recording, minus the capture itself.
 *
 * Neither capture path can run here: tab capture requires activeTab, which only
 * a real toolbar or context-menu click grants, and the screen picker needs a
 * display that headless does not have. So this covers everything around the
 * MediaRecorder — the guidance when activeTab is missing, the chunk store, and
 * the on-page control. The capture itself needs manual testing.
 */
async function runRecordingSuite() {
  console.log(`\n########## recording ##########`)
  const failures = []
  const mark = (label) => console.log(`       · ${label}`)
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 25000,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host

    const page = await browser.newPage()
    await page.goto(`http://localhost:${PORT}/long.html`, { waitUntil: 'load' })
    await page.bringToFront()

    const driver = await browser.newPage()
    await driver.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await page.bringToFront()

    const ask = (name, payload) =>
      driver.evaluate(
        async (n, p) => chrome.runtime.sendMessage({ __aio: true, name: n, payload: p }),
        name,
        payload,
      )

    // Without activeTab Chrome refuses. The message must tell the user what to do.
    const refused = await ask('record:start', { source: 'tab', audio: false })
    check(failures, 'tab capture without activeTab is refused',
      refused?.ok === false, JSON.stringify(refused))
    check(failures, 'the refusal explains how to start a tab recording',
      /toolbar/i.test(refused?.error ?? '') && !/has not been invoked/i.test(refused?.error ?? ''),
      `got ${JSON.stringify(refused?.error)}`)

    const state = await ask('record:state', undefined)
    check(failures, 'a failed start leaves no recording running',
      state?.value?.active === false, JSON.stringify(state))

    const badge = await driver.evaluate(() => chrome.action.getBadgeText({}))
    check(failures, 'a failed start leaves no REC badge', badge === '', `badge was ${JSON.stringify(badge)}`)

    // The offscreen document is now created before the stream id is issued, so a
    // failed start must tear it down rather than leaking one.
    const leaked = await driver.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      return contexts.length
    })
    check(failures, 'a failed start leaves no offscreen document behind',
      leaked === 0, `${leaked} still open`)

    // Screen capture is deliberately not started here. getDisplayMedia now waits
    // for the user to choose a source, which is correct but means the call never
    // settles without a display - it hangs rather than failing.

    // Chrome refuses to capture its own pages; say so rather than relaying a
    // bare failure.
    const onChromePage = await browser.newPage()
    await onChromePage.goto('chrome://version')
    await onChromePage.bringToFront()
    const refusedChrome = await ask('record:start', { source: 'tab', audio: false })
    check(failures, 'recording a browser page is refused with a reason',
      refusedChrome?.ok === false && /does not allow recording its own pages/i.test(refusedChrome.error ?? ''),
      JSON.stringify(refusedChrome))
    await onChromePage.close()
    await page.bringToFront()

    // --- the chunk store, which is what a long recording depends on ----------
    const result = await driver.evaluate(async () => {
      const open = () =>
        new Promise((res, rej) => {
          const q = indexedDB.open('magpie-recordings', 1)
          q.onupgradeneeded = () => {
            const db = q.result
            if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' })
            if (!db.objectStoreNames.contains('chunks'))
              db.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] })
          }
          q.onsuccess = () => res(q.result)
          q.onerror = () => rej(q.error)
        })
      const db = await open()
      const put = (store, value) =>
        new Promise((res, rej) => {
          const q = db.transaction(store, 'readwrite').objectStore(store).put(value)
          q.onsuccess = () => res()
          q.onerror = () => rej(q.error)
        })

      // Written deliberately out of order: order must come from the index.
      await put('recordings', { id: 'r1', mimeType: 'video/mp4', startedAt: Date.now() })
      await put('chunks', { recordingId: 'r1', index: 2, blob: new Blob(['ccc']) })
      await put('chunks', { recordingId: 'r1', index: 0, blob: new Blob(['a']) })
      await put('chunks', { recordingId: 'r1', index: 1, blob: new Blob(['bb']) })
      // An orphan from an interrupted capture.
      await put('chunks', { recordingId: 'gone', index: 0, blob: new Blob(['x']) })

      const rows = await new Promise((res, rej) => {
        const q = db
          .transaction('chunks', 'readonly')
          .objectStore('chunks')
          .getAll(IDBKeyRange.bound(['r1', -Infinity], ['r1', Infinity]))
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
      })
      const text = await new Blob(
        rows.sort((a, b) => a.index - b.index).map((r) => r.blob),
      ).text()

      const allKeys = await new Promise((res, rej) => {
        const q = db.transaction('chunks', 'readonly').objectStore('chunks').getAllKeys()
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
      })
      return { text, count: rows.length, orphans: allKeys.filter((k) => k[0] === 'gone').length }
    })

    check(failures, 'chunks reassemble in capture order, not write order',
      result.text === 'abbccc', `got ${JSON.stringify(result.text)}`)
    check(failures, 'a range query returns only that recording\'s chunks',
      result.count === 3, `got ${result.count}`)
    check(failures, 'orphaned chunks are identifiable for pruning',
      result.orphans === 1, `got ${result.orphans}`)

    // --- the on-page control -------------------------------------------------
    const tabId = await driver.evaluate(
      async (url) => (await chrome.tabs.query({ url }))[0].id,
      `http://localhost:${PORT}/long.html`,
    )
    await driver.evaluate(
      (id) =>
        chrome.tabs.sendMessage(id, {
          __aio: true,
          name: 'control:show',
          payload: { state: { active: true, paused: false, startedAt: Date.now() } },
        }),
      tabId,
    )
    await new Promise((r) => setTimeout(r, 400))

    const shown = await page.evaluate(() => {
      const host = document.getElementById('magpie-recorder-control')
      return { present: Boolean(host), fixed: host?.style.position === 'fixed' }
    })
    check(failures, 'the on-page control appears while recording', shown.present, 'no control')
    check(failures, 'the control is fixed-position so it stays put', shown.fixed, 'not fixed')

    await driver.evaluate(
      (id) => chrome.tabs.sendMessage(id, { __aio: true, name: 'control:hide', payload: undefined }),
      tabId,
    )
    await new Promise((r) => setTimeout(r, 300))
    const hidden = await page.evaluate(() => !document.getElementById('magpie-recorder-control'))
    check(failures, 'the control is removed when recording stops', hidden, 'control still present')

    // --- the pre-roll countdown ---------------------------------------------
    // Driven directly: neither capture path can open a stream here, so the
    // countdown never runs as part of a real start.
    await driver.evaluate(
      (id) =>
        chrome.tabs.sendMessage(id, {
          __aio: true,
          name: 'countdown:show',
          payload: { seconds: 3 },
        }),
      tabId,
    )
    await new Promise((r) => setTimeout(r, 300))

    const readCount = () =>
      page.evaluate(() => {
        const host = document.getElementById('magpie-countdown')
        return host?.shadowRoot?.querySelector('.count')?.textContent ?? null
      })

    check(failures, 'the countdown appears and starts at 3', (await readCount()) === '3',
      `showed ${JSON.stringify(await readCount())}`)

    await new Promise((r) => setTimeout(r, 1100))
    check(failures, 'the countdown ticks down', (await readCount()) === '2',
      `showed ${JSON.stringify(await readCount())}`)

    // Cancelling must both dismiss the overlay and tell the worker.
    await driver.evaluate(() => chrome.storage.session.remove('magpie:recording:cancelled'))
    await page.evaluate(() => {
      const host = document.getElementById('magpie-countdown')
      host?.shadowRoot?.querySelector('button')?.click()
    })
    await new Promise((r) => setTimeout(r, 500))

    check(failures, 'cancelling dismisses the countdown',
      await page.evaluate(() => !document.getElementById('magpie-countdown')), 'overlay still there')

    const cancelFlag = await driver.evaluate(async () => {
      const stored = await chrome.storage.session.get('magpie:recording:cancelled')
      return stored['magpie:recording:cancelled'] === true
    })
    check(failures, 'cancelling tells the worker to abandon the recording', cancelFlag,
      'no cancel flag was set')

    // --- controls during a screen recording ---------------------------------
    // A screen recording has no anchor tab, so the control must follow the user.
    // The state is seeded directly because no capture can run here.
    const second = await browser.newPage()
    await second.goto(`http://localhost:${PORT}/article.html`, { waitUntil: 'load' })
    // newPage already activated it, so switch away first — otherwise the later
    // bringToFront is a no-op and onActivated never fires.
    await page.bringToFront()
    await new Promise((r) => setTimeout(r, 200))

    await driver.evaluate(() =>
      chrome.storage.session.set({
        'magpie:recording': {
          active: true,
          paused: false,
          startedAt: Date.now(),
          pausedMs: 0,
          source: 'screen',
        },
      }),
    )
    mark('seeded screen state')
    await second.bringToFront()
    await new Promise((r) => setTimeout(r, 900))

    const onSecond = await second.evaluate(() =>
      Boolean(document.getElementById('magpie-recorder-control')),
    )
    check(failures, 'the control follows the active tab during a screen recording',
      onSecond, 'no control on the newly activated tab')

    mark('checked second tab')
    // Switching back must show it there too, not move it.
    await page.bringToFront()
    await new Promise((r) => setTimeout(r, 900))
    const onFirst = await page.evaluate(() =>
      Boolean(document.getElementById('magpie-recorder-control')),
    )
    check(failures, 'the control appears on each tab the user visits', onFirst, 'no control on the first tab')

    mark('checked first tab')
    // Stopping must clear every control, not just the last one.
    await ask('record:stop', undefined)
    mark('sent record:stop')
    await new Promise((r) => setTimeout(r, 700))
    const cleared = await Promise.all([
      page.evaluate(() => !document.getElementById('magpie-recorder-control')),
      second.evaluate(() => !document.getElementById('magpie-recorder-control')),
    ])
    check(failures, 'stopping removes the control from every tab it appeared on',
      cleared.every(Boolean), `remaining: ${JSON.stringify(cleared)}`)
    await second.close()

    return failures.map((f) => f.replace('[hls]', '[recording]'))
  } finally {
    await browser.close()
  }
}

/**
 * ffmpeg-backed editing, driven through the real panel.
 *
 * A clip is recorded in-page with MediaRecorder and seeded into the recording
 * store, because no capture path can run headlessly. From there the trim goes
 * through the actual UI and the actual ffmpeg build.
 */
async function runFfmpegSuite() {
  console.log(`\n########## ffmpeg editing ##########`)
  const failures = []
  const downloads = mkdtempSync(join(tmpdir(), 'magpie-clip-'))
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180000,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host

    const cdp = await browser.target().createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloads,
      eventsEnabled: true,
    })

    const panel = await browser.newPage()
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`)
    await new Promise((r) => setTimeout(r, 700))

    // Record a real clip and seed it as if a capture had produced it.
    const seeded = await panel.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 120
      const ctx = canvas.getContext('2d')
      let frame = 0
      const draw = setInterval(() => {
        ctx.fillStyle = ['#e11d48', '#2563eb', '#16a34a'][frame++ % 3]
        ctx.fillRect(0, 0, 160, 120)
      }, 60)

      const stream = canvas.captureStream(25)
      const type = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
        ? 'video/mp4;codecs=avc1'
        : 'video/webm'
      const recorder = new MediaRecorder(stream, { mimeType: type })
      const chunks = []
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data)
      recorder.start(200)
      await new Promise((r) => setTimeout(r, 2200))
      await new Promise((done) => {
        recorder.addEventListener('stop', () => done(), { once: true })
        recorder.stop()
      })
      clearInterval(draw)
      stream.getTracks().forEach((t) => t.stop())

      const blob = new Blob(chunks, { type })
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open('magpie-recordings', 1)
        q.onupgradeneeded = () => {
          const d = q.result
          if (!d.objectStoreNames.contains('recordings')) d.createObjectStore('recordings', { keyPath: 'id' })
          if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] })
        }
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
      })
      const put = (store, value) =>
        new Promise((res, rej) => {
          const q = db.transaction(store, 'readwrite').objectStore(store).put(value)
          q.onsuccess = () => res()
          q.onerror = () => rej(q.error)
        })
      await put('recordings', {
        id: 'clip-test', source: 'tab', mimeType: type,
        extension: type.includes('mp4') ? 'mp4' : 'webm',
        bytes: blob.size, durationMs: 2200, startedAt: Date.now(),
        hasAudio: false, title: 'Trim fixture', url: 'https://example.test/',
      })
      await put('chunks', { recordingId: 'clip-test', index: 0, blob })
      return { bytes: blob.size, type }
    })

    check(failures, 'a source clip was recorded to trim',
      seeded.bytes > 0, `got ${seeded.bytes} bytes`)

    // Reload so the panel picks up the seeded recording, then use the real UI.
    await panel.reload()
    await new Promise((r) => setTimeout(r, 800))
    await panel.evaluate(() => {
      document.querySelector('nav button[aria-label="Record"]')?.click()
    })
    await new Promise((r) => setTimeout(r, 600))

    const listed = await panel.evaluate(() => document.body.innerText.includes('Trim fixture'))
    check(failures, 'the recording appears in the library', listed, 'not listed')

    await panel.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Trim')
      button?.click()
    })
    await new Promise((r) => setTimeout(r, 300))

    // React controls these inputs, so set through the native setter.
    const rangeSet = await panel.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type=number]')]
      if (inputs.length < 2) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inputs[0], '0.3')
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
      setter.call(inputs[1], '1.2')
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })
    check(failures, 'trim controls open with a start and end', rangeSet, 'inputs not found')

    await panel.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Save clip'),
      )
      button?.click()
    })

    // Loading and running ffmpeg takes a moment.
    let files = []
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 1000))
      files = readdirSync(downloads).filter((f) => !f.endsWith('.crdownload'))
      if (files.length > 0) break
    }
    check(failures, 'trimming produces a downloaded clip', files.length > 0,
      `panel said: ${(await panel.evaluate(() => document.body.innerText)).slice(0, 200)}`)

    if (files[0]) {
      const bytes = readFileSync(join(downloads, files[0]))
      const box = bytes.subarray(4, 8).toString('latin1')
      console.log(`       ${files[0]} -> ${bytes.length} bytes (source ${seeded.bytes})`)
      check(failures, 'the clip is a valid container',
        box === 'ftyp' || bytes[0] === 0x1a, `first box ${JSON.stringify(box)}`)
      check(failures, 'the clip is shorter than the source it came from',
        bytes.length < seeded.bytes, `${bytes.length} vs ${seeded.bytes}`)
    }

    return failures.map((f) => f.replace('[hls]', '[ffmpeg]'))
  } finally {
    await browser.close()
    rmSync(downloads, { recursive: true, force: true })
  }
}

/**
 * Video and audio conversion, driven through the Convert panel.
 *
 * The clip is produced in-page with MediaRecorder — canvas for picture, an
 * oscillator for sound — then handed to the panel's file input as a real File,
 * so the whole path runs: file selection, dynamic ffmpeg import, encode, save.
 */
async function runMediaConvertSuite() {
  console.log(`\n########## media conversion ##########`)
  const failures = []
  const downloads = mkdtempSync(join(tmpdir(), 'magpie-conv-'))
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 240000,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host
    const cdp = await browser.target().createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: downloads, eventsEnabled: true,
    })

    const panel = await browser.newPage()
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`)
    await new Promise((r) => setTimeout(r, 700))
    await panel.evaluate(() => document.querySelector('nav button[aria-label="Convert"]')?.click())
    await new Promise((r) => setTimeout(r, 400))

    const made = await panel.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 120
      const ctx = canvas.getContext('2d')
      let frame = 0
      const draw = setInterval(() => {
        ctx.fillStyle = ['#e11d48', '#2563eb', '#16a34a'][frame++ % 3]
        ctx.fillRect(0, 0, 160, 120)
      }, 60)

      // A tone, so the file genuinely has sound to extract.
      const audioCtx = new AudioContext()
      const osc = audioCtx.createOscillator()
      const dest = audioCtx.createMediaStreamDestination()
      osc.frequency.value = 440
      osc.connect(dest)
      osc.start()

      const stream = canvas.captureStream(25)
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
      const type = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')
        ? 'video/mp4;codecs=avc1,mp4a.40.2'
        : 'video/webm'
      const recorder = new MediaRecorder(stream, { mimeType: type })
      const chunks = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      recorder.start(200)
      await new Promise((r) => setTimeout(r, 2000))
      await new Promise((done) => {
        recorder.addEventListener('stop', () => done(), { once: true })
        recorder.stop()
      })
      clearInterval(draw)
      osc.stop()
      await audioCtx.close()
      stream.getTracks().forEach((t) => t.stop())

      const blob = new Blob(chunks, { type })
      const name = type.includes('mp4') ? 'clip.mp4' : 'clip.webm'
      const input = document.querySelector('input[type=file]')
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], name, { type: blob.type }))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { bytes: blob.size, name }
    })

    check(failures, 'a clip with picture and sound was produced', made.bytes > 0, `${made.bytes} bytes`)
    await new Promise((r) => setTimeout(r, 500))

    const sawVideoSection = await panel.evaluate(() =>
      /video\s*·/i.test(document.body.innerText),
    )
    check(failures, 'the panel offers video actions for a video file', sawVideoSection,
      (await panel.evaluate(() => document.body.innerText)).slice(0, 160))

    const clickAction = (label) =>
      panel.evaluate((text) => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === text,
        )
        button?.click()
        return Boolean(button)
      }, label)

    const waitForFile = async (extension) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((r) => setTimeout(r, 1000))
        const hit = readdirSync(downloads).find(
          (f) => f.endsWith(extension) && !f.endsWith('.crdownload'),
        )
        if (hit) return hit
      }
      return undefined
    }

    check(failures, 'the GIF action is offered', await clickAction('To GIF'), 'no button')
    const gif = await waitForFile('.gif')
    if (gif) {
      const bytes = readFileSync(join(downloads, gif))
      console.log(`       ${gif} -> ${bytes.length} bytes`)
      check(failures, 'the GIF has a real GIF header',
        bytes.subarray(0, 6).toString('latin1').startsWith('GIF8'),
        bytes.subarray(0, 6).toString('latin1'))
    } else {
      check(failures, 'video converts to GIF', false,
        (await panel.evaluate(() => document.body.innerText)).slice(0, 200))
    }

    check(failures, 'the MP3 action is offered', await clickAction('Audio · MP3'), 'no button')
    const mp3 = await waitForFile('.mp3')
    if (mp3) {
      const bytes = readFileSync(join(downloads, mp3))
      console.log(`       ${mp3} -> ${bytes.length} bytes`)
      // MP3 starts with an ID3 tag or a frame sync.
      const head = bytes.subarray(0, 3)
      check(failures, 'the MP3 has a real MP3 header',
        head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0),
        [...head].map((b) => b.toString(16)).join(' '))
      check(failures, 'the extracted audio holds real samples', bytes.length > 1024,
        `only ${bytes.length} bytes`)
    } else {
      check(failures, 'video converts to MP3', false,
        (await panel.evaluate(() => document.body.innerText)).slice(0, 200))
    }

    return failures.map((f) => f.replace('[hls]', '[convert-media]'))
  } finally {
    await browser.close()
    rmSync(downloads, { recursive: true, force: true })
  }
}

/**
 * PDF reading, ICO and Excel export, driven through the Convert panel.
 *
 * The PDF is generated here with pdf-lib so the text going in is known, which
 * makes the extraction assertion meaningful rather than "something came out".
 */
async function runTier2Suite() {
  console.log(`\n########## pdf, ico, excel ##########`)
  const failures = []
  const downloads = mkdtempSync(join(tmpdir(), 'magpie-t2-'))

  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([300, 200])
  page.drawText('MAGPIEPDFMARKER', { x: 24, y: 120, size: 20, font })
  doc.addPage([300, 200]).drawText('SECONDPAGEMARKER', { x: 24, y: 120, size: 20, font })
  const pdfBase64 = Buffer.from(await doc.save()).toString('base64')

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 240000,
    args: [
      `--disable-extensions-except=${join(ROOT, 'dist')}`,
      `--load-extension=${join(ROOT, 'dist')}`,
      '--no-first-run', '--no-default-browser-check',
    ],
  })

  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
      { timeout: 15000 },
    )
    const extensionId = new URL(swTarget.url()).host
    const cdp = await browser.target().createCDPSession()
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: downloads, eventsEnabled: true,
    })

    const panel = await browser.newPage()
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`)
    await new Promise((r) => setTimeout(r, 700))
    await panel.evaluate(() => document.querySelector('nav button[aria-label="Convert"]')?.click())
    await new Promise((r) => setTimeout(r, 400))

    /** Put a file on the panel's input as if it had been chosen. */
    const choose = (name, type, base64, text) =>
      panel.evaluate(
        (n, t, b64, plain) => {
          const bytes = plain
            ? new TextEncoder().encode(plain)
            : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const input = document.querySelector('input[type=file]')
          const transfer = new DataTransfer()
          transfer.items.add(new File([bytes], n, { type: t }))
          input.files = transfer.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        },
        name, type, base64 ?? '', text ?? '',
      )

    const click = (label) =>
      panel.evaluate((text) => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === text,
        )
        button?.click()
        return Boolean(button)
      }, label)

    const waitFor = async (extension, attempts = 90, seen = new Set()) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        await new Promise((r) => setTimeout(r, 1000))
        const hit = readdirSync(downloads).find(
          (f) => f.endsWith(extension) && !f.endsWith('.crdownload') && !seen.has(f),
        )
        if (hit) return hit
      }
      return undefined
    }

    // --- PDF to text --------------------------------------------------------
    await choose('doc.pdf', 'application/pdf', pdfBase64)
    await new Promise((r) => setTimeout(r, 400))
    check(failures, 'the PDF text action is offered', await click('To text'), 'no button')

    const txt = await waitFor('.txt')
    if (txt) {
      const text = readFileSync(join(downloads, txt), 'utf8')
      check(failures, 'extracted text matches what went in',
        text.includes('MAGPIEPDFMARKER'), JSON.stringify(text.slice(0, 120)))
      check(failures, 'every page is extracted, not just the first',
        text.includes('SECONDPAGEMARKER'), JSON.stringify(text.slice(0, 200)))
    } else {
      check(failures, 'PDF converts to text', false,
        (await panel.evaluate(() => document.body.innerText)).slice(0, 200))
    }

    // --- PDF pages to PNG ---------------------------------------------------
    check(failures, 'the page-render action is offered', await click('Pages to PNG'), 'no button')
    const png = await waitFor('.png')
    if (png) {
      const bytes = readFileSync(join(downloads, png))
      check(failures, 'a rendered page is a real PNG',
        bytes.subarray(1, 4).toString('latin1') === 'PNG', 'bad signature')
      console.log(`       ${png} -> ${bytes.length} bytes`)
    } else {
      check(failures, 'PDF pages render to PNG', false, 'no png appeared')
    }

    // --- image to ICO -------------------------------------------------------
    const pngBase64 = await panel.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 120
      canvas.height = 90
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#2563eb'
      ctx.fillRect(0, 0, 120, 90)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (const b of buf) s += String.fromCharCode(b)
      return btoa(s)
    })
    await choose('logo.png', 'image/png', pngBase64)
    await new Promise((r) => setTimeout(r, 400))
    check(failures, 'the ICO action is offered', await click('To ICO'), 'no button')

    const ico = await waitFor('.ico')
    if (ico) {
      const bytes = readFileSync(join(downloads, ico))
      const count = bytes.readUInt16LE(4)
      check(failures, 'the ICO has a valid header',
        bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && count > 0,
        `reserved=${bytes.readUInt16LE(0)} type=${bytes.readUInt16LE(2)} count=${count}`)
      // Read each directory entry's width rather than assume a count: a 120px
      // source should yield 16/32/48/64 and never be blown up to 128 or 256.
      const widths = Array.from({ length: count }, (_, i) => bytes[6 + i * 16] || 256)
      check(failures, 'no icon size exceeds the source image',
        widths.every((w) => w <= 120), `sizes ${widths.join(', ')}`)
      check(failures, 'the usual small sizes are all present',
        [16, 32, 48].every((w) => widths.includes(w)), `sizes ${widths.join(', ')}`)
      console.log(`       ${ico} -> ${bytes.length} bytes, sizes ${widths.join('/')}`)
    } else {
      check(failures, 'an image converts to ICO', false, 'no ico appeared')
    }

    // --- CSV to Excel -------------------------------------------------------
    await choose('table.csv', 'text/csv', undefined, 'name,qty\nAlice,42\n')
    await new Promise((r) => setTimeout(r, 400))
    check(failures, 'the Excel action is offered', await click('CSV to Excel'), 'no button')

    const xlsx = await waitFor('.xlsx')
    if (xlsx) {
      const bytes = readFileSync(join(downloads, xlsx))
      check(failures, 'the workbook is a real zip',
        bytes[0] === 0x50 && bytes[1] === 0x4b, 'bad signature')
      console.log(`       ${xlsx} -> ${bytes.length} bytes`)
    } else {
      check(failures, 'CSV converts to Excel', false, 'no xlsx appeared')
    }

    // --- OCR ----------------------------------------------------------------
    // Text drawn here, so what it should read is known exactly.
    const before = new Set(readdirSync(downloads))
    const textImage = await panel.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 200
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000000'
      ctx.font = '64px Helvetica, Arial, sans-serif'
      ctx.textBaseline = 'middle'
      ctx.fillText('MAGPIE OCR TEST', 30, 100)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let out = ''
      for (const b of buf) out += String.fromCharCode(b)
      return btoa(out)
    })

    await choose('scan.png', 'image/png', textImage)
    await new Promise((r) => setTimeout(r, 400))
    check(failures, 'the OCR action is offered', await click('Read text (OCR)'), 'no button')

    // Loading ~6MB of engine and model takes a while on first use.
    const read = await waitFor('.txt', 180, before)
    if (read) {
      const text = readFileSync(join(downloads, read), 'utf8')
      const flat = text.toUpperCase().replace(/[^A-Z ]/g, '')
      console.log(`       OCR read: ${JSON.stringify(text.trim().slice(0, 60))}`)
      check(failures, 'OCR reads the words that were drawn',
        ['MAGPIE', 'OCR', 'TEST'].every((word) => flat.includes(word)), JSON.stringify(flat))
    } else {
      check(failures, 'an image converts to text via OCR', false,
        (await panel.evaluate(() => document.body.innerText)).slice(0, 200))
    }

    return failures.map((f) => f.replace('[hls]', '[tier2]'))
  } finally {
    await browser.close()
    rmSync(downloads, { recursive: true, force: true })
  }
}

async function main() {
  // Each suite launches its own browser and the capture tests are bound by
  // Chrome's two-per-second screenshot limit, so the full run is minutes.
  // `--only <name>` runs a single section while iterating.
  const onlyArg = process.argv.indexOf('--only')
  const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : undefined
  const wanted = (name) => !only || name.includes(only)

  const server = await startServer()
  let failures = []

  /** One suite blowing up should not hide the results of all the others. */
  const attempt = async (name, suite) => {
    if (!wanted(name)) return []
    try {
      return await suite()
    } catch (error) {
      console.log(`\n${name} crashed: ${error.message.split('\n')[0]}`)
      return [`[${name}] suite crashed: ${error.message.split('\n')[0]}`]
    }
  }

  try {
    failures = failures.concat(await attempt('capture@1x', () => runSuite('device scale 1', [])))
    failures = failures.concat(
      await attempt('capture@2x', () => runSuite('device scale 2', ['--force-device-scale-factor=2'])),
    )
    failures = failures.concat(await attempt('hls', runHlsTests))
    failures = failures.concat(await attempt('resolver', runResolverTests))
    failures = failures.concat(await attempt('media', runMediaSuite))
    failures = failures.concat(await attempt('editor', runEditorSuite))
    failures = failures.concat(await attempt('converters', runConverterTests))
    failures = failures.concat(await attempt('clipper', runClipperSuite))
    failures = failures.concat(await attempt('handoff', runIntentSuite))
    failures = failures.concat(await attempt('svg', runSvgSuite))
    failures = failures.concat(await attempt('recording', runRecordingSuite))
    failures = failures.concat(await attempt('ffmpeg', runFfmpegSuite))
    failures = failures.concat(await attempt('convert-media', runMediaConvertSuite))
    failures = failures.concat(await attempt('tier2', runTier2Suite))
  } finally {
    server.close()
  }

  console.log('\n' + '-'.repeat(60))
  if (failures.length) {
    console.log('FAILURES:')
    for (const failure of failures) console.log('  ' + failure)
    process.exitCode = 1
  } else {
    console.log('All tests passed.')
  }
}

await main()
