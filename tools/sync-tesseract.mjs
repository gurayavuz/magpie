/**
 * Copy the OCR engine into public/ so it ships with the extension.
 *
 * tesseract.js fetches its worker, core and language data from a CDN by
 * default, which an extension cannot do — remote script is forbidden. Only the
 * pieces actually used are copied: the LSTM-only core (the modern engine; the
 * legacy one is dead weight) and the integer-quantised English model, which is
 * 2.8MB against 10MB for the full one at very similar accuracy.
 *
 * No non-SIMD fallback: the manifest already requires Chrome 116 and WASM SIMD
 * landed in Chrome 91, so it could never be reached — it would just be 6.4MB of
 * dead weight.
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const to = join(ROOT, 'public', 'tesseract')
mkdirSync(to, { recursive: true })

const files = [
  [join(ROOT, 'node_modules/tesseract.js/dist/worker.min.js'), 'worker.min.js'],
  [join(ROOT, 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [join(ROOT, 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm'), 'tesseract-core-simd-lstm.wasm'],
  [join(ROOT, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), 'eng.traineddata.gz'],
]

let total = 0
for (const [from, name] of files) {
  copyFileSync(from, join(to, name))
  const size = statSync(join(to, name)).size
  total += size
  console.log(`  public/tesseract/${name}  ${(size / 1024 / 1024).toFixed(1)} MB`)
}
console.log(`  total ${(total / 1024 / 1024).toFixed(1)} MB`)
