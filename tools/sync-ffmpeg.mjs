/**
 * Copy the ffmpeg core into public/ so it ships with the extension.
 *
 * It cannot be fetched from a CDN: extension pages forbid remote script, and the
 * core is ~31MB of WebAssembly, so it is generated rather than committed.
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(ROOT, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm')
const to = join(ROOT, 'public', 'ffmpeg')

mkdirSync(to, { recursive: true })
for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copyFileSync(join(from, file), join(to, file))
  const size = (statSync(join(to, file)).size / 1024 / 1024).toFixed(1)
  console.log(`  public/ffmpeg/${file}  ${size} MB`)
}
