/**
 * Reading PDFs: text out, or pages as images.
 *
 * pdf-lib (used for merge/split/rotate) only rearranges pages — it cannot
 * interpret their contents. Anything that needs to *understand* a page needs a
 * renderer, which is what pdf.js is.
 */

import * as pdfjs from 'pdfjs-dist'
// Bundled by Vite and served from the extension; remote script is forbidden here.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Returns the loading task, not just the document: `destroy` lives on the task,
 * and it is what tears down the worker.
 *
 * No eval opt-out is needed — pdf.js v6 dropped eval entirely, which is why it
 * runs under the extension's CSP unchanged.
 */
function open(file: ArrayBuffer) {
  return pdfjs.getDocument({ data: new Uint8Array(file) })
}

/**
 * Extract the text layer.
 *
 * This reads what the PDF *says* it contains. A scanned document is a picture of
 * text with no text layer, and comes back empty — that needs OCR, which is a far
 * heavier proposition.
 */
export async function pdfToText(file: ArrayBuffer): Promise<string> {
  const task = open(file)
  const document = await task.promise
  const pages: string[] = []

  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number)
    const content = await page.getTextContent()

    // Items carry position, not line structure; a new line is inferred from a
    // vertical jump between successive items.
    let text = ''
    let lastY: number | undefined
    for (const item of content.items) {
      if (!('str' in item)) continue
      const y = item.transform[5] as number
      if (lastY !== undefined && Math.abs(y - lastY) > 2) text += '\n'
      else if (text && !text.endsWith(' ')) text += ' '
      text += item.str
      lastY = y
    }
    pages.push(text.trim())
    page.cleanup()
  }

  await task.destroy()
  return pages.join('\n\n---\n\n')
}

export interface RenderedPage {
  page: number
  blob: Blob
  width: number
  height: number
}

/** Render each page to a PNG. `scale` 2 is roughly 144dpi. */
export async function pdfToImages(
  file: ArrayBuffer,
  scale = 2,
  onPage?: (page: number, total: number) => void,
): Promise<RenderedPage[]> {
  if (typeof document === 'undefined') throw new Error('Rendering pages needs a page context')

  const task = open(file)
  const pdf = await task.promise
  const out: RenderedPage[] = []

  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a canvas to render into')

    // PDF pages are transparent; without a white ground the PNG looks empty.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)

    await page.render({ canvas, canvasContext: context, viewport }).promise
    page.cleanup()

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error(`Could not encode page ${number}`)
    out.push({ page: number, blob, width: canvas.width, height: canvas.height })
    onPage?.(number, pdf.numPages)
  }

  await task.destroy()
  return out
}
