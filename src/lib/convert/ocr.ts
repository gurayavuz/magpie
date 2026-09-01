/**
 * Optical character recognition.
 *
 * Everything else in the converters reads structure that is already there. OCR
 * is the opposite: it looks at a picture of words and guesses what they say. It
 * is therefore the one converter whose output should be proofread — names,
 * numbers and unusual spellings are where it slips.
 *
 * The engine, its WebAssembly core and the language model are all served from
 * the extension; tesseract.js would otherwise fetch them from a CDN, which an
 * extension page is not allowed to do.
 */

import { createWorker, type Worker } from 'tesseract.js'

export interface OcrProgress {
  /** 0..1 through the current image. */
  ratio: number
  /** Which page is being read, when reading a document. */
  page?: number
  pages?: number
}

let workerPromise: Promise<Worker> | undefined

/**
 * One worker, reused. Starting it loads about 6MB of engine and model, so a
 * fresh worker per image would dominate the actual recognition time.
 */
function getWorker(onProgress?: (progress: OcrProgress) => void): Promise<Worker> {
  workerPromise ??= createWorker('eng', 1, {
    workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
    corePath: chrome.runtime.getURL('tesseract/tesseract-core-simd-lstm.wasm.js'),
    langPath: chrome.runtime.getURL('tesseract'),
    gzip: true,
    // tesseract wraps its worker in a blob by default. A blob worker has an
    // opaque origin and cannot importScripts an extension URL — it fails as
    // ERR_FILE_NOT_FOUND even though the file is right there. Loading the
    // worker straight from its path keeps it on the extension's own origin.
    workerBlobURL: false,
    logger: (message) => {
      if (message.status === 'recognizing text') onProgress?.({ ratio: message.progress })
    },
  })
  return workerPromise
}

/** Release the engine and its memory. */
export async function releaseOcr(): Promise<void> {
  if (!workerPromise) return
  const worker = await workerPromise
  workerPromise = undefined
  await worker.terminate()
}

export async function readImage(
  source: Blob,
  onProgress?: (progress: OcrProgress) => void,
): Promise<string> {
  const worker = await getWorker(onProgress)
  const { data } = await worker.recognize(source)
  return data.text.trim()
}

/**
 * Read a scanned PDF.
 *
 * Each page is rendered to an image first, because a scan has no text layer to
 * extract — the page *is* a picture. Rendered at 2x so the characters are large
 * enough for the engine to resolve.
 */
export async function readPdf(
  file: ArrayBuffer,
  onProgress?: (progress: OcrProgress) => void,
): Promise<string> {
  const { pdfToImages } = await import('./pdf-read')
  const pages = await pdfToImages(file, 2)

  const worker = await getWorker()
  const out: string[] = []
  for (const [index, page] of pages.entries()) {
    onProgress?.({ ratio: index / pages.length, page: index + 1, pages: pages.length })
    const { data } = await worker.recognize(page.blob)
    out.push(data.text.trim())
  }
  onProgress?.({ ratio: 1, page: pages.length, pages: pages.length })

  return out.join('\n\n---\n\n')
}
