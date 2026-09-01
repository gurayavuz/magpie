/**
 * Offscreen document: hosts the recorder.
 *
 * An MV3 service worker cannot touch `getUserMedia` or `MediaRecorder`, and it
 * gets evicted while idle — fatal for a long capture. An offscreen document has
 * a full DOM and lives until it is closed, so the recording runs here and the
 * worker only coordinates.
 */

import { listen, type RecordSource } from '@/lib/protocol'
import { putChunk } from '@/lib/recording-store'

/**
 * H.264 in MP4 plays everywhere without conversion. Chrome only gained
 * MediaRecorder MP4 support recently, so fall back to WebM where it is missing.
 */
const PREFERRED_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

function bestMimeType(): string {
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? 'video/webm'
}

interface Session {
  id: string
  recorder: MediaRecorder
  stream: MediaStream
  audio?: AudioContext
  chunks: number
  bytes: number
  startedAt: number
  pausedAt?: number
  pausedMs: number
}

let session: Session | undefined

/**
 * Chrome's tab capture takes the audio *away* from the tab, so the page goes
 * silent while recording unless it is played back out. Routing the track through
 * an AudioContext to the speakers restores it.
 */
function keepAudible(stream: MediaStream): AudioContext | undefined {
  if (stream.getAudioTracks().length === 0) return undefined
  const context = new AudioContext()
  context.createMediaStreamSource(stream).connect(context.destination)
  return context
}

function tabConstraints(streamId: string, audio: boolean) {
  // The `mandatory` form is Chrome's legacy syntax, and still the only way to
  // hand a tabCapture stream id to getUserMedia.
  const video = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
  return {
    audio: audio ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false,
    video,
  } as unknown as MediaStreamConstraints
}

/**
 * Open the stream for a source.
 *
 * Screen capture calls `getDisplayMedia` *here*, rather than passing in an id
 * from a `desktopCapture` picker raised elsewhere. A desktopCapture stream id is
 * bound to the context that requested it, and consuming one from this document
 * fails with "Error starting tab capture" — measured, not assumed. Raising the
 * browser's own picker from the document that will consume the stream avoids the
 * hand-off entirely, which is what the DISPLAY_MEDIA offscreen reason is for.
 */
async function openStream(
  source: RecordSource,
  streamId: string | undefined,
  audio: boolean,
): Promise<MediaStream> {
  if (source === 'screen') {
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio })
  }
  if (!streamId) throw new Error('No tab stream was provided')
  return navigator.mediaDevices.getUserMedia(tabConstraints(streamId, audio))
}

async function stopSession(): Promise<{ bytes: number; durationMs: number } | null> {
  if (!session) return null
  const current = session

  await new Promise<void>((resolve) => {
    current.recorder.addEventListener('stop', () => resolve(), { once: true })
    if (current.recorder.state !== 'inactive') current.recorder.stop()
    else resolve()
  })

  for (const track of current.stream.getTracks()) track.stop()
  await current.audio?.close().catch(() => undefined)
  session = undefined

  const pausedMs = current.pausedMs + (current.pausedAt ? Date.now() - current.pausedAt : 0)
  return { bytes: current.bytes, durationMs: Date.now() - current.startedAt - pausedMs }
}

listen({
  'offscreen:open': async ({ id, streamId, source, audio }) => {
    if (session) throw new Error('A recording is already running')

    // Audio can be refused for reasons that have nothing to do with the video:
    // macOS Chrome cannot capture system audio at all, and a source the user
    // picked may simply not offer a track. Requesting it unconditionally fails
    // the whole call, so fall back to video rather than losing the recording.
    let stream: MediaStream
    let hasAudio = audio
    try {
      stream = await openStream(source, streamId, audio)
    } catch (error) {
      const first = error instanceof Error ? error : new Error(String(error))
      // Dismissing the picker is a choice, not a fault; say so plainly.
      if (source === 'screen' && first.name === 'NotAllowedError') {
        throw new Error('No screen or window was chosen')
      }
      // A cancelled picker must not be retried; only an audio refusal should be.
      if (!audio || first.name === 'NotAllowedError') {
        throw new Error(`Could not open the ${source} stream: ${first.message}`)
      }
      hasAudio = false
      try {
        stream = await openStream(source, streamId, false)
      } catch (retry) {
        throw new Error(
          `Could not open the ${source} stream: ${retry instanceof Error ? retry.message : String(retry)}`,
        )
      }
    }

    // getDisplayMedia gives whatever the user actually shared, which may include
    // no audio even when it was requested.
    hasAudio = hasAudio && stream.getAudioTracks().length > 0

    const mimeType = bestMimeType()
    const recorder = new MediaRecorder(stream, { mimeType })

    const current: Session = {
      id,
      recorder,
      stream,
      audio: hasAudio ? keepAudible(stream) : undefined,
      chunks: 0,
      bytes: 0,
      startedAt: Date.now(),
      pausedMs: 0,
    }
    session = current

    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data || event.data.size === 0) return
      current.bytes += event.data.size
      // Written as it arrives; nothing accumulates in memory.
      void putChunk(id, current.chunks++, event.data)
    })

    // If the user stops sharing from Chrome's own bar, end the recording too.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      void chrome.runtime.sendMessage({ __aio: true, name: 'record:stop', payload: undefined })
    })

    // Deliberately not started: the worker calls `begin` once any countdown has
    // finished, so nothing is captured while the user can still back out.
    return { mimeType, hasAudio }
  },

  'offscreen:begin': () => {
    if (!session) throw new Error('No stream is open')
    // A timeslice is what makes chunks arrive during the recording rather than
    // all at the end.
    if (session.recorder.state === 'inactive') session.recorder.start(3000)
    session.startedAt = Date.now()
  },

  'offscreen:discard': async () => {
    if (!session) return
    const current = session
    session = undefined
    if (current.recorder.state !== 'inactive') current.recorder.stop()
    for (const track of current.stream.getTracks()) track.stop()
    await current.audio?.close().catch(() => undefined)
  },

  'offscreen:stop': () => stopSession(),

  'offscreen:pause': () => {
    if (session && session.recorder.state === 'recording') {
      session.recorder.pause()
      session.pausedAt = Date.now()
    }
  },

  'offscreen:resume': () => {
    if (session && session.recorder.state === 'paused') {
      session.pausedMs += Date.now() - (session.pausedAt ?? Date.now())
      session.pausedAt = undefined
      session.recorder.resume()
    }
  },
})
