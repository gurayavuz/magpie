/**
 * Rasterise the brand SVG into the PNG sizes the manifest needs.
 * Rendering through Chrome keeps the output identical to what a browser shows.
 */
import puppeteer from 'puppeteer-core'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BROWSERS = process.env.AIO_BROWSERS ?? join(ROOT, '.browsers')

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = join(BROWSERS, 'chrome')
  const build = readdirSync(base).find((n) => n.startsWith('mac'))
  return join(base, build, 'chrome-mac-arm64',
    'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
}

// Two masters. Fine detail that only turns to mush at 16px is removed in the
// small variant rather than shrunk, which is what the manifest's per-size icon
// map exists for.
const detailed = readFileSync(join(ROOT, 'brand', 'magpie.svg'), 'utf8')
const simplified = readFileSync(join(ROOT, 'brand', 'magpie-small.svg'), 'utf8')
const sourceFor = (size) => (size <= 32 ? simplified : detailed)
const sizes = [16, 32, 48, 128, 512]

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true })
const page = await browser.newPage()
mkdirSync(join(ROOT, 'public', 'icons'), { recursive: true })

for (const size of sizes) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>` +
      sourceFor(size).replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`),
  )
  const buffer = await page.screenshot({ omitBackground: true, type: 'png' })
  const out = size === 512
    ? join(ROOT, 'brand', 'icon-512.png')
    : join(ROOT, 'public', 'icons', `icon-${size}.png`)
  writeFileSync(out, buffer)
  console.log(`  ${out.replace(ROOT + '/', '')}  ${buffer.length} bytes`)
}

// Contact sheet: the real small renders, magnified with nearest-neighbour, so
// legibility at 16px can actually be judged instead of guessed at from 512.
const shots = {}
for (const size of [16, 32, 48]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>` +
      sourceFor(size).replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`),
  )
  shots[size] = Buffer.from(await page.screenshot({ omitBackground: true, type: 'png' })).toString('base64')
}

await page.setViewport({ width: 720, height: 300, deviceScaleFactor: 2 })
await page.setContent(`
  <style>
    body { margin:0; font:12px system-ui; background:#f5f5f5; display:flex; gap:28px;
           align-items:flex-end; padding:24px; }
    figure { margin:0; text-align:center; }
    img { image-rendering: pixelated; display:block; margin-bottom:8px; }
    .dark { background:#1b1b1b; padding:10px; border-radius:8px; }
  </style>
  <figure><img src="data:image/png;base64,${shots[16]}" width="128"><figcaption>16px @8x</figcaption></figure>
  <figure><img src="data:image/png;base64,${shots[32]}" width="128"><figcaption>32px @4x</figcaption></figure>
  <figure><img src="data:image/png;base64,${shots[48]}" width="128"><figcaption>48px</figcaption></figure>
  <figure class="dark"><img src="data:image/png;base64,${shots[16]}" width="64"><figcaption style="color:#eee">16px on dark</figcaption></figure>
  <figure><img src="data:image/png;base64,${shots[16]}" width="16"><figcaption>16px actual</figcaption></figure>
`)
writeFileSync(join(ROOT, 'brand', 'contact-sheet.png'), await page.screenshot({ type: 'png' }))
console.log('  brand/contact-sheet.png')

await browser.close()
