import { useCallback, useEffect, useState } from 'react'
import { send, type MediaItem } from '@/lib/protocol'
import { mediaName } from '@/lib/filename'
import { assembleStream } from '@/lib/hls'
import { Button, Card, Empty, Input, Message, PanelHeader } from './ui'
import { AlertIcon, DownloadIcon, PlayIcon } from './icons'

function formatBytes(bytes?: number): string | undefined {
  if (!bytes) return undefined
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const KIND_LABEL: Record<MediaItem['kind'], string> = {
  mp4: 'video',
  hls: 'stream',
  dash: 'stream',
  audio: 'audio',
  image: 'image',
  unknown: 'file',
}

/** Merge sources, preferring whichever record knows more about a given URL. */
function merge(...lists: MediaItem[][]): MediaItem[] {
  const byUrl = new Map<string, MediaItem>()
  for (const list of lists) {
    for (const item of list) byUrl.set(item.url, { ...byUrl.get(item.url), ...item })
  }
  return [...byUrl.values()]
}

export default function MediaPanel() {
  const [items, setItems] = useState<MediaItem[]>([])
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ id: string; done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2600)
    return () => clearTimeout(timer)
  }, [notice])



  const resolve = useCallback(async () => {
    if (!link.trim()) return
    setBusy('resolve')
    setError(null)
    try {
      const found = await send('media:resolveLink', { url: link.trim() })
      setItems((previous) => merge(previous, found))
      setNotice(found.length ? `Found ${found.length}` : 'No media found at that link')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [link])

  const save = useCallback(async (item: MediaItem) => {
    setBusy(item.id)
    setError(null)
    try {
      if (item.kind === 'hls' || item.kind === 'dash') {
        // Assembled here rather than in the worker: this page can hold an object
        // URL and will not be evicted mid-download.
        const stream = await assembleStream(item.url, {
          onProgress: (done, total) => setProgress({ id: item.id, done, total }),
        })

        // Older streams concatenate into MPEG-TS. Rewrap rather than hand over a
        // .ts file some players refuse; it is a container change, not a re-encode.
        let blob = stream.blob
        let extension = stream.extension
        if (stream.needsRemux) {
          setNotice('Converting to MP4…')
          const { remuxToMp4 } = await import('@/lib/ffmpeg')
          blob = await remuxToMp4(stream.blob)
          extension = 'mp4'
        }

        const url = URL.createObjectURL(blob)
        try {
          await chrome.downloads.download({
            url,
            filename: mediaName({
              title: item.pageTitle,
              pageUrl: item.pageUrl,
              mediaUrl: item.url,
              extension,
            }),
            saveAs: false,
          })
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
        setNotice(`Saved ${stream.segmentCount} segments as .${extension}`)
      } else {
        // Name the file after what it actually contains: a lone track is the
        // easiest thing to save by mistake and the hardest to identify later.
        const suffix =
          item.track === 'video' ? ' (no sound)' : item.track === 'audio' ? ' (sound only)' : ''
        await send('media:download', {
          item,
          filename: suffix
            ? mediaName({
                title: `${item.pageTitle ?? 'video'}${suffix}`,
                pageUrl: item.pageUrl,
                mediaUrl: item.url,
                extension: 'mp4',
              })
            : undefined,
        })
        setNotice(suffix ? `Saving${suffix}` : 'Saving')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }, [])

  /**
   * A site serving DASH gives picture and sound as separate files. When both are
   * present they can be joined, which is the only way to get a usable download.
   */
  const pair = (() => {
    const video = items.filter((item) => item.track === 'video').sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))[0]
    const audio = items.find((item) => item.track === 'audio')
    return video && audio ? { video, audio } : undefined
  })()

  const saveJoined = useCallback(async () => {
    if (!pair) return
    setBusy('join')
    setError(null)
    try {
      setNotice('Downloading both tracks…')
      const [video, audio] = await Promise.all([
        fetch(pair.video.url).then((response) => response.blob()),
        fetch(pair.audio.url).then((response) => response.blob()),
      ])

      setNotice('Joining picture and sound…')
      const { muxAudioVideo } = await import('@/lib/ffmpeg')
      const joined = await muxAudioVideo(video, audio)

      const url = URL.createObjectURL(joined)
      try {
        await chrome.downloads.download({
          url,
          filename: mediaName({
            title: pair.video.pageTitle,
            pageUrl: pair.video.pageUrl,
            mediaUrl: pair.video.url,
            extension: 'mp4',
          }),
          saveAs: false,
        })
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
      setNotice('Saved with sound')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [pair])

  return (
    <>
      <PanelHeader title="Media" hint="Paste a link to a post or video to download it." />

      <div className="space-y-2 border-b border-line px-4 pb-3">
        <div className="flex gap-1.5">
          <Input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void resolve()}
            placeholder="Paste a post link"
            className="min-w-0 flex-1"
          />
          <Button
            variant="primary"
            disabled={busy !== null || !link.trim()}
            onClick={() => void resolve()}
          >
            {busy === 'resolve' ? '…' : 'Find'}
          </Button>
        </div>

        {error && <Message tone="error">{error}</Message>}
        {notice && <Message tone="success">{notice}</Message>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {pair && (
          <Card className="mb-2.5 p-2.5">
            <p className="text-[12px] font-medium text-ink">Video with sound</p>
            <p className="mt-0.5 text-[11px] text-ink-subtle">
              {[pair.video.label, formatBytes((pair.video.bytes ?? 0) + (pair.audio.bytes ?? 0))]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-ink-muted">
              This site keeps picture and sound in separate files. This joins them into one.
            </p>
            <Button
              variant="primary"
              className="mt-2 w-full"
              disabled={busy !== null}
              onClick={() => void saveJoined()}
            >
              <DownloadIcon size={13} />
              {busy === 'join' ? 'Joining…' : 'Save with sound'}
            </Button>
          </Card>
        )}

        {/* Sites serve one file per quality rung. Listing every rung next to the
            joined download is how you end up saving a silent video by mistake. */}
        {pair && items.length > 2 && (
          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            className="mb-2 text-[11px] text-ink-subtle underline-offset-2 hover:text-ink hover:underline"
          >
            {showAll ? 'Hide' : `Show all ${items.length} separate files`}
          </button>
        )}

        {items.length === 0 && (
          <Empty icon={<PlayIcon size={26} />}>
            Paste a post or video link above to find what it holds.
          </Empty>
        )}

        <ul className="space-y-2">
          {(pair && !showAll ? [] : items).map((item) => (
            <li key={item.id}>
              <Card className="p-2.5">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                    {KIND_LABEL[item.kind]}
                  </span>
                  <span className="truncate text-[11px] text-ink-muted">
                    {[
                      item.track === 'video' ? 'no sound' : item.track === 'audio' ? 'sound only' : null,
                      item.label,
                      formatBytes(item.bytes),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>

                <p className="mt-1 truncate text-[11px] text-ink-subtle" title={item.url}>
                  {item.url}
                </p>

                {(item.track === 'video' || item.track === 'audio') && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-warning-soft px-1.5 py-1 text-[10px] leading-snug text-warning">
                    <AlertIcon size={12} />
                    <span>
                      {item.track === 'video'
                        ? 'Picture only — this site keeps sound in a separate file, so this saves silent.'
                        : 'Sound only — the picture is a separate file.'}
                    </span>
                  </p>
                )}

                {progress?.id === item.id && (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-hover">
                    <div
                      className="h-full bg-accent transition-all"
                      style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                    />
                  </div>
                )}

                {/* Offering Save on a DASH stream would promise something that
                    always fails, so say why instead. */}
                {item.kind === 'dash' ? (
                  <p className="mt-2 flex items-start gap-1.5 rounded-md bg-warning-soft px-1.5 py-1 text-[10px] leading-snug text-warning">
                    <AlertIcon size={12} />
                    <span>
                      DASH streams cannot be assembled yet. If the page also serves an MP4 or an
                      HLS stream, save that instead.
                    </span>
                  </p>
                ) : (
                  <Button
                    size="sm"
                    className="mt-2"
                    disabled={busy !== null}
                    onClick={() => void save(item)}
                  >
                    <DownloadIcon size={13} />
                    {busy === item.id
                      ? progress?.id === item.id
                        ? `${progress.done}/${progress.total}`
                        : 'Saving…'
                      : item.track === 'video'
                        ? 'Save without sound'
                        : item.track === 'audio'
                          ? 'Save sound only'
                          : 'Save'}
                  </Button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
