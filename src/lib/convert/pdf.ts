/**
 * PDF operations, all client-side via pdf-lib.
 *
 * Everything here takes and returns raw bytes so the same functions work in the
 * side panel, a worker, or a test in Node.
 */

import { PDFDocument, degrees } from 'pdf-lib'

export type Bytes = Uint8Array | ArrayBuffer

function asUint8(bytes: Bytes): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

/**
 * Parse a page selection like `1-3, 5, 8-` into zero-based page indices.
 *
 * Accepts 1-based input because that is what page numbers mean to a reader, and
 * an open-ended range (`8-`) runs to the last page.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const trimmed = input.trim()
  if (!trimmed) return Array.from({ length: pageCount }, (_, index) => index)

  const selected = new Set<number>()
  for (const part of trimmed.split(',')) {
    const piece = part.trim()
    if (!piece) continue

    const range = /^(\d+)?\s*-\s*(\d+)?$/.exec(piece)
    if (range) {
      const from = range[1] ? Number(range[1]) : 1
      const to = range[2] ? Number(range[2]) : pageCount
      for (let page = Math.min(from, to); page <= Math.max(from, to); page++) {
        if (page >= 1 && page <= pageCount) selected.add(page - 1)
      }
      continue
    }

    const single = Number(piece)
    if (Number.isInteger(single) && single >= 1 && single <= pageCount) {
      selected.add(single - 1)
    }
  }

  return [...selected].sort((a, b) => a - b)
}

export async function pageCount(file: Bytes): Promise<number> {
  const document = await PDFDocument.load(asUint8(file))
  return document.getPageCount()
}

/** Join several PDFs end to end, in the order given. */
export async function mergePdfs(files: Bytes[]): Promise<Uint8Array> {
  if (files.length === 0) throw new Error('Choose at least one PDF to merge')

  const merged = await PDFDocument.create()
  for (const file of files) {
    const source = await PDFDocument.load(asUint8(file))
    const pages = await merged.copyPages(source, source.getPageIndices())
    for (const page of pages) merged.addPage(page)
  }
  return merged.save()
}

/** Keep only the selected pages, in the order selected. */
export async function extractPages(file: Bytes, selection: string): Promise<Uint8Array> {
  const source = await PDFDocument.load(asUint8(file))
  const indices = parsePageRanges(selection, source.getPageCount())
  if (indices.length === 0) throw new Error('That selection matched no pages')

  const output = await PDFDocument.create()
  const pages = await output.copyPages(source, indices)
  for (const page of pages) output.addPage(page)
  return output.save()
}

/** Split into one document per range, e.g. `1-3, 4-6` gives two files. */
export async function splitPdf(file: Bytes, selections: string[]): Promise<Uint8Array[]> {
  return Promise.all(selections.map((selection) => extractPages(file, selection)))
}

/** Split into one document per page. */
export async function burstPdf(file: Bytes): Promise<Uint8Array[]> {
  const count = await pageCount(file)
  return splitPdf(
    file,
    Array.from({ length: count }, (_, index) => String(index + 1)),
  )
}

export async function rotatePdf(
  file: Bytes,
  turn: number,
  selection = '',
): Promise<Uint8Array> {
  const document = await PDFDocument.load(asUint8(file))
  const indices = new Set(parsePageRanges(selection, document.getPageCount()))

  document.getPages().forEach((page, index) => {
    if (!indices.has(index)) return
    // Rotation is cumulative and PDF only allows right angles.
    const next = (((page.getRotation().angle + turn) % 360) + 360) % 360
    page.setRotation(degrees(next))
  })
  return document.save()
}

export interface ImageInput {
  bytes: Bytes
  /** Only PNG and JPEG can be embedded directly; convert others first. */
  type: 'image/png' | 'image/jpeg'
}

/**
 * Put each image on its own page, sized to the image so nothing is cropped or
 * letterboxed.
 */
export async function imagesToPdf(images: ImageInput[]): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('Choose at least one image')

  const document = await PDFDocument.create()
  for (const image of images) {
    const embedded =
      image.type === 'image/png'
        ? await document.embedPng(asUint8(image.bytes))
        : await document.embedJpg(asUint8(image.bytes))

    const page = document.addPage([embedded.width, embedded.height])
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height })
  }
  return document.save()
}
