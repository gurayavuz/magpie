/** Screenshot the panel in both themes so the design can actually be reviewed. */
import puppeteer from 'puppeteer-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const B = process.env.AIO_BROWSERS ?? join(ROOT, '.browsers')
const build = readdirSync(join(B, 'chrome')).find((n) => n.startsWith('mac'))
const CHROME = process.env.CHROME_PATH ?? join(B, 'chrome', build, 'chrome-mac-arm64',
  'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
const PORT = 8788

const server = createServer(async (req, res) => {
  const body = await readFile(join(ROOT, 'test', 'fixtures', req.url.replace(/^\//, ''))).catch(() => null)
  if (!body) return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'text/html' }).end(body)
})
await new Promise((r) => server.listen(PORT, r))

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${join(ROOT,'dist')}`, `--load-extension=${join(ROOT,'dist')}`, '--no-first-run'],
})
const sw = await browser.waitForTarget(t => t.type()==='service_worker' && t.url().startsWith('chrome-extension://'), {timeout:15000})
const id = new URL(sw.url()).host

// Populate the library so cards render with real content, not empty states.
const driver = await browser.newPage()
await driver.goto(`chrome-extension://${id}/src/popup/index.html`)
const fixture = await browser.newPage()
await fixture.setViewport({ width: 1100, height: 800 })
await fixture.goto(`http://localhost:${PORT}/article.html`, { waitUntil: 'load' })
await fixture.bringToFront()
const tabId = await driver.evaluate(async (u) => (await chrome.tabs.query({url:u}))[0].id, `http://localhost:${PORT}/article.html`)
await driver.evaluate(async (t) => {
  const r = await chrome.runtime.sendMessage({__aio:true,name:'capture:run',payload:{tabId:t,mode:'full',format:'png'}})
  if(!r?.ok) throw new Error(r?.error)
}, tabId)

const shots = {}
for (const scheme of ['light', 'dark']) {
  for (const [name, path] of [['panel', 'src/sidepanel/index.html'], ['popup', 'src/popup/index.html']]) {
    const page = await browser.newPage()
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }])
    await page.setViewport({ width: name === 'popup' ? 248 : 360, height: name === 'popup' ? 340 : 640 })
    await page.goto(`chrome-extension://${id}/${path}`)
    await new Promise(r => setTimeout(r, 900))
    if (name === 'popup') {
      const height = await page.evaluate(() => document.body.scrollHeight)
      console.log(`  popup natural height (${scheme}): ${height}px${height > 600 ? '  <-- over Chrome max' : ''}`)
    }
    shots[`${scheme}-${name}`] = Buffer.from(
      await page.screenshot({ type: 'png', fullPage: name === 'popup' }),
    ).toString('base64')
    await page.close()
  }
}

const sheet = await browser.newPage()
await sheet.setViewport({ width: 1360, height: 780, deviceScaleFactor: 2 })
const img = (k, w) => `<img src="data:image/png;base64,${shots[k]}" width="${w}">`
await sheet.setContent(`
<style>
 body{margin:0;font:12px system-ui;background:#e9e9ec;padding:24px;display:flex;gap:34px;align-items:flex-start}
 figure{margin:0;text-align:center} img{display:block;border-radius:8px;box-shadow:0 4px 18px #0002;margin-bottom:8px}
 figcaption{font-weight:600;color:#444}
 .col{display:flex;gap:18px;align-items:flex-start}
</style>
<div class="col">
 <figure>${img('light-panel', 360)}<figcaption>Panel — light</figcaption></figure>
 <figure>${img('light-popup', 248)}<figcaption>Popup — light</figcaption></figure>
</div>
<div class="col">
 <figure>${img('dark-panel', 360)}<figcaption>Panel — dark</figcaption></figure>
 <figure>${img('dark-popup', 248)}<figcaption>Popup — dark</figcaption></figure>
</div>`)
writeFileSync(join(ROOT, 'brand', 'ui-preview.png'), await sheet.screenshot({ type: 'png' }))
console.log('brand/ui-preview.png')
await browser.close(); server.close()
