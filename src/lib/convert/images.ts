/**
 * Image conversion and resizing, via canvas. Browser-only: needs
 * `createImageBitmap` and a canvas to re-encode through.
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface ConvertOptions {
  format: ImageFormat
  quality?: number
  /** Cap the longest edge, preserving aspect ratio. Omit to keep full size. */
  maxEdge?: number
}

export interface ConvertedImage {
  blob: Blob
  width: number
  height: number
}

function isSvg(source: Blob): boolean {
  return /^image\/svg\+xml/i.test(source.type) || /\.svg$/i.test((source as File).name ?? '')
}

/**
 * Whether the markup declares its own size.
 *
 * A `viewBox`-only SVG reports 300x150 through an `<img>`, but that is the
 * browser's default placeholder rather than anything the author chose, so it is
 * a poor basis for the output size.
 */
function declaresSize(markup: string): boolean {
  const openTag = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? ''
  return /\swidth\s*=/i.test(openTag) && /\sheight\s*=/i.test(openTag)
}

/**
 * Rasterise vector art.
 *
 * `createImageBitmap` refuses SVG outright in Chrome ("the source image could
 * not be decoded"), so the only route is an `<img>`, which needs a document -
 * fine in the panel, unavailable in the worker.
 */
async function rasteriseSvg(source: Blob, maxEdge?: number): Promise<HTMLCanvasElement> {
  if (typeof document === 'undefined') {
    throw new Error('SVG conversion needs a page context')
  }

  const markup = await source.text()
  const url = URL.createObjectURL(source)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('That SVG could not be rendered'))
      image.src = url
    })

    const naturalWidth = image.naturalWidth || 300
    const naturalHeight = image.naturalHeight || 150
    const longest = Math.max(naturalWidth, naturalHeight)

    // Vector art has no native resolution, so scaling *up* is legitimate here -
    // unlike raster, where it only inflates the file. Honour an explicit size if
    // the author set one; otherwise render at something usable.
    const target = maxEdge && maxEdge > 0 ? maxEdge : declaresSize(markup) ? longest : 1024
    const scale = target / longest

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a canvas to render into')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function convertImage(source: Blob, options: ConvertOptions): Promise<ConvertedImage> {
  if (isSvg(source)) {
    const canvas = await rasteriseSvg(source, options.maxEdge)
    if (options.format === 'jpeg') {
      // JPEG has no alpha, and SVG backgrounds are usually transparent.
      const ctx = canvas.getContext('2d')!
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, `image/${options.format}`, options.quality ?? 0.92),
    )
    if (!blob) throw new Error('Could not encode the rendered SVG')
    return { blob, width: canvas.width, height: canvas.height }
  }

  const bitmap = await createImageBitmap(source)
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    // Only ever scale down; upscaling adds no detail and multiplies file size.
    const scale = options.maxEdge && longest > options.maxEdge ? options.maxEdge / longest : 1

    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create a canvas to convert through')

    // JPEG has no alpha; without a matte, transparent areas turn black.
    if (options.format === 'jpeg') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)

    const blob = await canvas.convertToBlob({
      type: `image/${options.format}`,
      quality: options.quality ?? 0.92,
    })
    return { blob, width, height }
  } finally {
    bitmap.close()
  }
}

/**
 * Coerce any image into something `imagesToPdf` can embed, since PDF only
 * accepts PNG and JPEG.
 */
export async function toPdfEmbeddable(
  source: Blob,
): Promise<{ bytes: ArrayBuffer; type: 'image/png' | 'image/jpeg' }> {
  if (source.type === 'image/png' || source.type === 'image/jpeg') {
    return { bytes: await source.arrayBuffer(), type: source.type }
  }
  const { blob } = await convertImage(source, { format: 'png' })
  return { bytes: await blob.arrayBuffer(), type: 'image/png' }
}
