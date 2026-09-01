/**
 * ICO writer.
 *
 * An .ico is a small directory followed by image payloads. Since Windows Vista
 * those payloads may be PNGs rather than raw bitmaps, which means the whole
 * format reduces to "resize a few times, then write a 22-byte header and a
 * 16-byte record per size" — no dependency needed.
 */

const DEFAULT_SIZES = [16, 32, 48, 64, 128, 256]

async function resizeToPng(source: ImageBitmap, size: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(size, size)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create a canvas to resize into')

  // Fit the whole image inside the square without distorting it; icons are
  // square and source images usually are not.
  const scale = Math.min(size / source.width, size / source.height)
  const width = Math.round(source.width * scale)
  const height = Math.round(source.height * scale)
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, (size - width) / 2, (size - height) / 2, width, height)

  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

export async function imageToIco(source: Blob, sizes = DEFAULT_SIZES): Promise<Blob> {
  const bitmap = await createImageBitmap(source)
  try {
    // Never upscale past the source: a 32px logo blown up to 256 just looks soft.
    const longest = Math.max(bitmap.width, bitmap.height)
    const wanted = sizes.filter((size) => size <= Math.max(longest, 16))
    const chosen = wanted.length > 0 ? wanted : [Math.min(longest, 16)]

    const images = await Promise.all(chosen.map((size) => resizeToPng(bitmap, size)))

    const header = new Uint8Array(6 + images.length * 16)
    const view = new DataView(header.buffer)
    view.setUint16(0, 0, true) // reserved
    view.setUint16(2, 1, true) // 1 = icon
    view.setUint16(4, images.length, true)

    let offset = header.length
    images.forEach((png, index) => {
      const size = chosen[index]!
      const entry = 6 + index * 16
      // 256 is stored as 0, since the field is a single byte.
      header[entry] = size >= 256 ? 0 : size
      header[entry + 1] = size >= 256 ? 0 : size
      header[entry + 2] = 0 // palette size, unused for PNG payloads
      header[entry + 3] = 0 // reserved
      view.setUint16(entry + 4, 1, true) // colour planes
      view.setUint16(entry + 6, 32, true) // bits per pixel
      view.setUint32(entry + 8, png.length, true)
      view.setUint32(entry + 12, offset, true)
      offset += png.length
    })

    return new Blob([header as BlobPart, ...(images as BlobPart[])], { type: 'image/x-icon' })
  } finally {
    bitmap.close()
  }
}
