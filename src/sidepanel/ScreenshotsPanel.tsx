import { useCallback, useEffect, useRef, useState } from 'react'
import { send, type CaptureMode, type ImageFormat } from '@/lib/protocol'
import { screenshotName } from '@/lib/filename'
import { getShot } from '@/lib/shot-store'
import { useShots, type ShotWithPreview } from './useShots'
import { Button, Card, Empty, Field, Message, PanelHeader, Select } from './ui'
import { CameraIcon, CopyIcon, DownloadIcon, PenIcon, TrashIcon } from './icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function downloadShot(shot: ShotWithPreview): Promise<void> {
  const stored = await getShot(shot.id)
  if (!stored) throw new Error('That capture is no longer available')

  const url = URL.createObjectURL(stored.blob)
  try {
    await chrome.downloads.download({
      url,
      filename: screenshotName({
        title: shot.title,
        url: shot.url,
        extension: shot.format === 'jpeg' ? 'jpg' : shot.format,
        part: shot.part,
        partCount: shot.partCount,
      }),
      saveAs: false,
    })
  } finally {
    // The download reads the blob asynchronously, so give it a moment first.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

async function copyShot(shot: ShotWithPreview): Promise<void> {
  const stored = await getShot(shot.id)
  if (!stored) throw new Error('That capture is no longer available')

  // The clipboard only accepts PNG, so re-encode anything else on the way out.
  let blob = stored.blob
  if (blob.type !== 'image/png') {
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    blob = await canvas.convertToBlob({ type: 'image/png' })
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export default function ScreenshotsPanel({
  autoRun = null,
  onAutoRun,
}: {
  autoRun?: 'capture-full' | 'capture-visible' | null
  onAutoRun?: () => void
} = {}) {
  const { shots, loading, refresh, remove } = useShots()
  const [busy, setBusy] = useState<CaptureMode | null>(null)
  const [format, setFormat] = useState<ImageFormat>('png')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2400)
    return () => clearTimeout(timer)
  }, [notice])

  const capture = useCallback(
    async (mode: CaptureMode) => {
      setBusy(mode)
      setError(null)
      try {
        const results = await send('capture:run', { mode, format })
        await refresh()
        setNotice(
          results.length > 1 ? `Captured in ${results.length} parts` : 'Captured',
        )
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(null)
      }
    },
    [format, refresh],
  )


  // Work handed over by the popup runs exactly once, even if props re-settle.
  const started = useRef(false)
  useEffect(() => {
    if (!autoRun || started.current) return
    started.current = true
    onAutoRun?.()
    void capture(autoRun === 'capture-full' ? 'full' : 'visible')
  }, [autoRun, onAutoRun, capture])

  const act = useCallback(async (label: string, action: () => Promise<void>) => {
    setError(null)
    try {
      await action()
      setNotice(label)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  return (
    <>
      <PanelHeader title="Screenshots" hint="Capture the whole page, or just what is on screen." />

      <div className="space-y-2.5 border-b border-line px-4 pb-3">
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void capture('full')}
          >
            {busy === 'full' ? 'Capturing…' : 'Full page'}
          </Button>
          <Button disabled={busy !== null} onClick={() => void capture('visible')}>
            {busy === 'visible' ? 'Capturing…' : 'Visible area'}
          </Button>
        </div>

        <Field label="Format">
          <Select value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)}>
            <option value="png">PNG · lossless</option>
            <option value="jpeg">JPEG · smaller</option>
          </Select>
        </Field>

        {busy === 'full' && (
          <Message tone="warning">
            Long pages take a while — Chrome allows only two captures per second.
          </Message>
        )}
        {error && <Message tone="error">{error}</Message>}
        {notice && <Message tone="success">{notice}</Message>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="text-[11px] text-ink-subtle">Loading…</p>}

        {!loading && shots.length === 0 && (
          <Empty icon={<CameraIcon size={26} />}>
            Nothing captured yet. Open a page and choose Full page.
          </Empty>
        )}

        <ul className="space-y-2.5">
          {shots.map((shot) => (
            <li key={shot.id}>
              <Card>
                <img
                  src={shot.previewUrl}
                  alt={shot.title}
                  className="max-h-44 w-full bg-surface-sunken object-contain"
                />
                <div className="border-t border-line p-2.5">
                  <p className="truncate text-[12px] font-medium text-ink" title={shot.title}>
                    {shot.title || 'Untitled'}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-subtle">
                    {shot.width} × {shot.height} · {formatBytes(shot.bytes)}
                    {shot.partCount > 1 && ` · part ${shot.part}/${shot.partCount}`}
                  </p>

                  <div className="mt-2 flex items-center gap-1">
                    <Button size="sm" onClick={() => void act('Saved', () => downloadShot(shot))}>
                      <DownloadIcon size={13} /> Save
                    </Button>
                    <Button size="sm" onClick={() => void act('Copied', () => copyShot(shot))}>
                      <CopyIcon size={13} /> Copy
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        void chrome.tabs.create({
                          url: chrome.runtime.getURL(`src/editor/index.html?id=${shot.id}`),
                        })
                      }
                    >
                      <PenIcon size={13} /> Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label="Delete"
                      className="ml-auto"
                      onClick={() => void act('Deleted', () => remove(shot.id))}
                    >
                      <TrashIcon size={13} />
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
