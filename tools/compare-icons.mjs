/** Render every candidate at real small sizes for side-by-side comparison. */
import puppeteer from 'puppeteer-core'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BROWSERS = process.env.AIO_BROWSERS ?? join(ROOT, '.browsers')
const build = readdirSync(join(BROWSERS, 'chrome')).find((n) => n.startsWith('mac'))
const CHROME = process.env.CHROME_PATH ?? join(BROWSERS, 'chrome', build, 'chrome-mac-arm64',
  'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')

const dir = join(ROOT, 'brand', 'candidates')
const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage()
const rows = []

for (const file of files) {
  const svg = readFileSync(join(dir, file), 'utf8')
  const shots = {}
  for (const size of [16, 24, 48, 128]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block}</style>` +
        svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`))
    shots[size] = Buffer.from(await page.screenshot({ omitBackground: true, type: 'png' })).toString('base64')
  }
  rows.push({ name: file.replace('.svg', ''), shots })
}

const cell = (b64, w) => `<img src="data:image/png;base64,${b64}" width="${w}">`
await page.setViewport({ width: 700, height: 120 + rows.length * 150, deviceScaleFactor: 2 })
await page.setContent(`
<style>
 body{margin:0;font:13px system-ui;background:#fafafa;padding:20px}
 table{border-collapse:collapse} td,th{padding:10px 14px;text-align:center;vertical-align:middle}
 th{font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
 img{image-rendering:pixelated;display:block;margin:0 auto}
 .name{text-align:left;font-weight:600}
 .dark{background:#1c1c1c;border-radius:6px}
 tr+tr td{border-top:1px solid #e5e5e5}
</style>
<table>
<tr><th></th><th>16px actual</th><th>16px @6x</th><th>24px @4x</th><th>48px @2x</th><th>on dark</th><th>128px</th></tr>
${rows.map((r) => `<tr>
  <td class="name">${r.name}</td>
  <td>${cell(r.shots[16], 16)}</td>
  <td>${cell(r.shots[16], 96)}</td>
  <td>${cell(r.shots[24], 96)}</td>
  <td>${cell(r.shots[48], 96)}</td>
  <td class="dark">${cell(r.shots[16], 32)}</td>
  <td>${cell(r.shots[128], 76)}</td>
</tr>`).join('')}
</table>`)
writeFileSync(join(ROOT, 'brand', 'candidates.png'), await page.screenshot({ type: 'png' }))
console.log('brand/candidates.png')
await browser.close()
