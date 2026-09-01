/**
 * Annotation model and renderer.
 *
 * Shapes are stored in image coordinates, never screen coordinates, so the
 * editor can display a scaled-down preview while still exporting at full
 * resolution. Rendering is a pure function of (base image, shapes), which keeps
 * undo/redo to a plain array and makes export identical to what is on screen.
 */

export type ShapeKind = 'rect' | 'arrow' | 'text' | 'blur' | 'highlight'

export interface BaseShape {
  id: string
  kind: ShapeKind
  color: string
  strokeWidth: number
}

export interface BoxShape extends BaseShape {
  kind: 'rect' | 'blur' | 'highlight'
  x: number
  y: number
  width: number
  height: number
}

export interface ArrowShape extends BaseShape {
  kind: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface TextShape extends BaseShape {
  kind: 'text'
  x: number
  y: number
  text: string
  fontSize: number
}

export type Shape = BoxShape | ArrowShape | TextShape

export type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
export type ImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas

/** Normalise a drag into a positive-size box, whichever way it was dragged. */
export function normaliseBox(box: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  return {
    x: box.width < 0 ? box.x + box.width : box.x,
    y: box.height < 0 ? box.y + box.height : box.y,
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  }
}

function scratch(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
}

/**
 * Redact a region by mosaicing it.
 *
 * Deliberately not a Gaussian blur: a blur is a reversible-ish convolution and
 * leaves enough signal that text can sometimes be recovered. Downsampling to
 * blocks and scaling back with smoothing off genuinely discards the pixels.
 */
export function pixelate(
  ctx: AnyContext,
  source: ImageSource,
  box: { x: number; y: number; width: number; height: number },
  blockSize: number,
): void {
  const { x, y, width, height } = normaliseBox(box)
  const w = Math.round(width)
  const h = Math.round(height)
  if (w < 1 || h < 1) return

  // Block means are computed from pixel data rather than by drawing the region
  // into a small canvas and scaling it back up. A large one-step downscale can
  // take a point-sampling fast path instead of averaging, which leaves one
  // original pixel per block - enough for high-contrast text to stay legible
  // through the "redaction". Averaging explicitly is the only way to be sure
  // the pixels are actually gone.
  const region = scratch(w, h)
  const regionCtx = region.getContext('2d')
  if (!regionCtx) return
  regionCtx.drawImage(source as CanvasImageSource, x, y, w, h, 0, 0, w, h)

  const { data } = regionCtx.getImageData(0, 0, w, h)
  const block = Math.max(2, Math.round(blockSize))

  ctx.save()
  for (let by = 0; by < h; by += block) {
    const blockHeight = Math.min(block, h - by)
    for (let bx = 0; bx < w; bx += block) {
      const blockWidth = Math.min(block, w - bx)

      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let row = 0; row < blockHeight; row++) {
        let offset = ((by + row) * w + bx) * 4
        for (let column = 0; column < blockWidth; column++) {
          r += data[offset]!
          g += data[offset + 1]!
          b += data[offset + 2]!
          offset += 4
          count++
        }
      }

      ctx.fillStyle = `rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)})`
      ctx.fillRect(x + bx, y + by, blockWidth, blockHeight)
    }
  }
  ctx.restore()
}

function drawArrow(ctx: AnyContext, shape: ArrowShape): void {
  const { x1, y1, x2, y2, strokeWidth } = shape
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = Math.max(10, strokeWidth * 4)

  ctx.save()
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  ctx.lineWidth = strokeWidth
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Stop the shaft short of the tip so the head has a clean point.
  const shaftEndX = x2 - Math.cos(angle) * head * 0.6
  const shaftEndY = y2 - Math.sin(angle) * head * 0.6
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(shaftEndX, shaftEndY)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - Math.cos(angle - Math.PI / 7) * head, y2 - Math.sin(angle - Math.PI / 7) * head)
  ctx.lineTo(x2 - Math.cos(angle + Math.PI / 7) * head, y2 - Math.sin(angle + Math.PI / 7) * head)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function drawText(ctx: AnyContext, shape: TextShape): void {
  ctx.save()
  ctx.font = `600 ${shape.fontSize}px system-ui, -apple-system, sans-serif`
  ctx.textBaseline = 'top'
  // A dark halo keeps light text legible over arbitrary page content.
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.lineWidth = Math.max(2, shape.fontSize / 8)
  ctx.lineJoin = 'round'
  ctx.strokeText(shape.text, shape.x, shape.y)
  ctx.fillStyle = shape.color
  ctx.fillText(shape.text, shape.x, shape.y)
  ctx.restore()
}

/** Draw the base image and every annotation, in order, at full image scale. */
export function renderScene(
  ctx: AnyContext,
  base: ImageSource,
  shapes: Shape[],
  size: { width: number; height: number },
): void {
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.drawImage(base as CanvasImageSource, 0, 0)

  for (const shape of shapes) {
    switch (shape.kind) {
      case 'blur':
        // Sampled from the untouched base, so overlapping redactions cannot
        // progressively smear earlier annotations into the mosaic.
        pixelate(ctx, base, shape, Math.max(4, shape.strokeWidth * 4))
        break

      case 'highlight': {
        const box = normaliseBox(shape)
        ctx.save()
        ctx.globalAlpha = 0.32
        ctx.fillStyle = shape.color
        ctx.fillRect(box.x, box.y, box.width, box.height)
        ctx.restore()
        break
      }

      case 'rect': {
        const box = normaliseBox(shape)
        ctx.save()
        ctx.strokeStyle = shape.color
        ctx.lineWidth = shape.strokeWidth
        ctx.lineJoin = 'round'
        ctx.strokeRect(box.x, box.y, box.width, box.height)
        ctx.restore()
        break
      }

      case 'arrow':
        drawArrow(ctx, shape)
        break

      case 'text':
        drawText(ctx, shape)
        break
    }
  }
}

/** Render the annotated image at full resolution and encode it. */
export async function exportScene(
  base: ImageSource,
  shapes: Shape[],
  size: { width: number; height: number },
  format: 'png' | 'jpeg' = 'png',
): Promise<Blob> {
  const canvas = scratch(size.width, size.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a canvas to export into')
  renderScene(ctx, base, shapes, size)
  return canvas.convertToBlob({ type: `image/${format}`, quality: 0.92 })
}
