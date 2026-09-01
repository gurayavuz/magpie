/**
 * Live probe for the general link resolver - the path used by anything without
 * a public resolver (Instagram, TikTok, most sites). Loads the built extension
 * into Chrome and asks it to resolve a URL exactly as the side panel would.
 *
 *   node test/probe-link.mjs <url> [--headed]
 *
 * Prints structure only: kinds, hosts, sizes. Never page content.
 */

import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdirSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const BROWSERS = process.env.AIO_BROWSERS ?? join(ROOT, '.browsers')

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(BROWSERS, 'chrome')
  const build = readdirSync(base).find((name) => name.startsWith('mac'))
  if (!build) throw new Error(`No Chrome for Testing under ${base}`)
  return join(
    base,
    build,
    'chrome-mac-arm64',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing',
  )
}

const target = process.argv[2]
const headed = process.argv.includes('--headed')
if (!target) {
  console.log('usage: node test/probe-link.mjs <url> [--headed]')
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: !headed,
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

  console.log(`resolving: ${target}`)
  const started = Date.now()

  const items = await driver.evaluate(async (url) => {
    const reply = await chrome.runtime.sendMessage({
      __aio: true,
      name: 'media:resolveLink',
      payload: { url },
    })
    if (!reply?.ok) throw new Error(reply?.error ?? 'no reply from resolver')
    return reply.value
  }, target)

  console.log(`took ${((Date.now() - started) / 1000).toFixed(1)}s, found ${items.length}\n`)
  for (const item of items) {
    const host = (() => {
      try {
        return new URL(item.url).host
      } catch {
        return '?'
      }
    })()
    const size = item.bytes ? `${(item.bytes / 1024 / 1024).toFixed(2)} MB` : ''
    const track = item.track ? `[${item.track}]` : '[?]'
    console.log(
      `  ${item.kind.padEnd(5)} ${track.padEnd(9)} ${String(item.label ?? '').padEnd(12)} ${size.padEnd(10)} ${host}`,
    )
    if (process.env.SHOW_PARAMS) {
      try {
        const params = [...new URL(item.url).searchParams.keys()]
        console.log(`        path=${new URL(item.url).pathname.slice(0, 60)}`)
        console.log(`        params=${params.join(',')}`)
      } catch {
        console.log(`        ${item.url.slice(0, 130)}`)
      }
    } else {
      console.log(`        ${item.url.slice(0, 130)}`)
    }
  }

  // What did the page actually look like? A login wall explains an empty result.
  const page = await browser.newPage()
  await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 3000))
  const state = await page.evaluate(() => ({
    title: document.title,
    videos: document.querySelectorAll('video').length,
    blobVideos: [...document.querySelectorAll('video')].filter((v) =>
      (v.currentSrc || v.src || '').startsWith('blob:'),
    ).length,
    loginWall: /log in|sign up/i.test(document.body?.innerText?.slice(0, 400) ?? ''),
  }))
  console.log(`\n  page title : ${state.title}`)
  console.log(`  <video>    : ${state.videos} (${state.blobVideos} using blob: sources)`)
  console.log(`  login wall : ${state.loginWall}`)
} finally {
  await browser.close()
}
