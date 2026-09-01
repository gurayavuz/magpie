/**
 * Worker entry for ffmpeg.wasm.
 *
 * The library's own worker imports sibling modules, so it has to be bundled
 * rather than copied. Re-exporting it here gives Vite something to bundle and
 * gives us a stable URL to hand to `load({ classWorkerURL })`.
 */
import '@ffmpeg/ffmpeg/worker'
