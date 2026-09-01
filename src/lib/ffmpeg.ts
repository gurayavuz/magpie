/**
 * ffmpeg.wasm, loaded on demand.
 *
 * Every operation here is a *stream copy* — no re-encoding — so they are fast
 * even single-threaded: joining an audio and a video track, changing a container
 * from MPEG-TS to MP4, cutting a clip. That is the whole reason one dependency
 * closes three gaps at once.
 *
 * The core is ~31MB, so it is never touched until something actually needs it.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg'
// Vite bundles this and hands back a URL. The library's own worker imports
// sibling modules, so it cannot simply be copied into place.
import workerUrl from './ffmpeg-worker.ts?worker&url'

export interface Progress {
  /** 0..1, or undefined when ffmpeg cannot estimate. */
  ratio?: number
}

/**
 * Confirm WebAssembly is actually permitted before loading 31MB of it.
 *
 * The manifest grants `wasm-unsafe-eval`, but Chrome reads the manifest only
 * when the extension loads — after a rebuild that changed it, a still-running
 * instance keeps the old policy and every WASM compile fails deep inside
 * emscripten with an unreadable abort. An eight-byte module is the whole header
 * of a valid empty module, so this costs nothing and fails in the right place.
 */
function assertWasmAllowed(): void {
  try {
    new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/content security policy|wasm-eval|unsafe-eval/i.test(message)) {
      throw new Error(
        'Chrome is still running this extension under its old permissions. Open chrome://extensions and press reload on Magpie — a rebuild alone does not re-read the manifest.',
      )
    }
    throw error
  }
}

let loading: Promise<FFmpeg> | undefined

/** Load once per page and reuse; a second load would re-fetch 31MB. */
export function loadFfmpeg(onProgress?: (progress: Progress) => void): Promise<FFmpeg> {
  assertWasmAllowed()
  loading ??= (async () => {
    const ffmpeg = new FFmpeg()
    if (onProgress) {
      ffmpeg.on('progress', ({ progress }) => onProgress({ ratio: progress }))
    }
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm'),
      classWorkerURL: workerUrl,
    })
    return ffmpeg
  })()
  return loading
}

export function isFfmpegLoaded(): boolean {
  return loading !== undefined
}

async function run(
  inputs: { name: string; blob: Blob }[],
  args: string[],
  output: string,
  outputType: string,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  const ffmpeg = await loadFfmpeg(onProgress)
  if (onProgress) {
    ffmpeg.on('progress', ({ progress }) => onProgress({ ratio: progress }))
  }

  for (const input of inputs) {
    await ffmpeg.writeFile(input.name, new Uint8Array(await input.blob.arrayBuffer()))
  }

  const code = await ffmpeg.exec(args)
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`)

  const data = await ffmpeg.readFile(output)
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))

  // The virtual filesystem persists between runs, so clean up after each one.
  for (const input of inputs) await ffmpeg.deleteFile(input.name).catch(() => undefined)
  await ffmpeg.deleteFile(output).catch(() => undefined)

  return new Blob([bytes as BlobPart], { type: outputType })
}

/**
 * Join a video-only and an audio-only file into one.
 *
 * Sites that stream DASH — Instagram among them — serve the picture and the
 * sound as separate files. `-c copy` puts them in one container without
 * re-encoding either.
 */
export function muxAudioVideo(
  video: Blob,
  audio: Blob,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  return run(
    [
      { name: 'video.mp4', blob: video },
      { name: 'audio.mp4', blob: audio },
    ],
    [
      '-i', 'video.mp4',
      '-i', 'audio.mp4',
      '-c', 'copy',
      // Take picture from the first input and sound from the second, ignoring
      // any stray tracks either file happens to carry.
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      // Move the index to the front, so players can start without reading the
      // whole file first.
      '-movflags', '+faststart',
      'output.mp4',
    ],
    'output.mp4',
    'video/mp4',
    onProgress,
  )
}

/** Rewrap MPEG-TS as MP4. Older HLS streams concatenate into `.ts`. */
export function remuxToMp4(
  source: Blob,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  return run(
    [{ name: 'input.ts', blob: source }],
    ['-i', 'input.ts', '-c', 'copy', '-movflags', '+faststart', 'output.mp4'],
    'output.mp4',
    'video/mp4',
    onProgress,
  )
}

/**
 * Cut a clip out of a recording.
 *
 * `-ss` before `-i` seeks to the nearest keyframe, which is what makes a copy
 * cut fast. The trade is that the cut lands on that keyframe rather than exactly
 * on the requested second.
 */
export function trim(
  source: Blob,
  startSeconds: number,
  endSeconds: number,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  if (endSeconds <= startSeconds) throw new Error('The end must come after the start')

  const extension = source.type.includes('webm') ? 'webm' : 'mp4'
  return run(
    [{ name: `input.${extension}`, blob: source }],
    [
      '-ss', startSeconds.toFixed(3),
      '-to', endSeconds.toFixed(3),
      '-i', `input.${extension}`,
      '-c', 'copy',
      `output.${extension}`,
    ],
    `output.${extension}`,
    source.type || `video/${extension}`,
    onProgress,
  )
}

export type VideoFormat = 'mp4' | 'webm'
export type AudioFormat = 'mp3' | 'm4a' | 'wav'

function sourceName(source: Blob, fallback = 'mp4'): string {
  if (source.type.includes('webm')) return 'input.webm'
  if (source.type.includes('matroska')) return 'input.mkv'
  if (source.type.includes('quicktime')) return 'input.mov'
  if (source.type.includes('gif')) return 'input.gif'
  return `input.${fallback}`
}

/**
 * Re-encode a video into another format.
 *
 * Unlike everything above this is a real transcode, so it is slow — roughly
 * real-time or worse single-threaded. `veryfast`/CRF 23 keeps it tolerable at
 * a quality nobody will complain about.
 */
export function convertVideo(
  source: Blob,
  format: VideoFormat,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  const codec =
    format === 'mp4'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']
      : ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1',
         '-c:a', 'libopus', '-b:a', '128k']

  const input = sourceName(source)
  return run(
    [{ name: input, blob: source }],
    ['-i', input, ...codec, `output.${format}`],
    `output.${format}`,
    `video/${format}`,
    onProgress,
  )
}

/** Pull the sound out of a video, or convert one audio format to another. */
export function extractAudio(
  source: Blob,
  format: AudioFormat,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  const codec =
    format === 'mp3'
      ? ['-c:a', 'libmp3lame', '-q:a', '2']
      : format === 'm4a'
        ? ['-c:a', 'aac', '-b:a', '192k']
        : ['-c:a', 'pcm_s16le']

  const input = sourceName(source)
  const mime = format === 'mp3' ? 'audio/mpeg' : format === 'm4a' ? 'audio/mp4' : 'audio/wav'
  return run(
    [{ name: input, blob: source }],
    // -vn drops the picture, including any cover art the container carries.
    ['-i', input, '-vn', ...codec, `output.${format}`],
    `output.${format}`,
    mime,
    onProgress,
  )
}

/**
 * Video to animated GIF.
 *
 * Two passes: the first works out an optimal 256-colour palette for this clip,
 * the second renders using it. A single pass uses a generic web palette and the
 * result bands badly on anything with gradients.
 */
export async function videoToGif(
  source: Blob,
  options: { fps?: number; width?: number } = {},
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  const fps = options.fps ?? 12
  const width = options.width ?? 480
  const ffmpeg = await loadFfmpeg(onProgress)
  const input = sourceName(source)
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`

  await ffmpeg.writeFile(input, new Uint8Array(await source.arrayBuffer()))
  try {
    if ((await ffmpeg.exec(['-i', input, '-vf', `${filters},palettegen`, 'palette.png'])) !== 0) {
      throw new Error('Could not work out a colour palette for this video')
    }
    const code = await ffmpeg.exec([
      '-i', input, '-i', 'palette.png',
      '-lavfi', `${filters} [x]; [x][1:v] paletteuse`,
      '-loop', '0',
      'output.gif',
    ])
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`)

    const data = await ffmpeg.readFile('output.gif')
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    return new Blob([bytes as BlobPart], { type: 'image/gif' })
  } finally {
    for (const file of [input, 'palette.png', 'output.gif']) {
      await ffmpeg.deleteFile(file).catch(() => undefined)
    }
  }
}

/** Animated GIF to MP4 — far smaller, and every frame rather than just the first. */
export function gifToVideo(
  source: Blob,
  onProgress?: (progress: Progress) => void,
): Promise<Blob> {
  return run(
    [{ name: 'input.gif', blob: source }],
    ['-i', 'input.gif', '-movflags', '+faststart',
     // GIF dimensions are often odd numbers, which H.264 rejects outright.
     '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
     'output.mp4'],
    'output.mp4',
    'video/mp4',
    onProgress,
  )
}
