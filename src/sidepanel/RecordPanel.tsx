import { useCallback, useEffect, useRef, useState } from 'react'
import { send, type RecordingMeta, type RecordingState } from '@/lib/protocol'
import { mediaName } from '@/lib/filename'
import { assembleRecording, deleteRecording, listRecordings } from '@/lib/recording-store'
import { Button, Card, Empty, Field, Input, Message, PanelHeader, Select } from './ui'
import { AlertIcon, DownloadIcon, PauseIcon, RecordIcon, StopIcon, TrashIcon } from './icons'

const AUDIO_KEY = 'magpie:record:audio'
const COUNTDOWN_KEY = 'magpie:record:countdown'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

export default function RecordPanel({
  autoRun = null,
  onAutoRun,
}: { autoRun?: 'record-tab' | 'record-screen' | null; onAutoRun?: () => void } = {}) {
  const [state, setState] = useState<RecordingState>({ active: false, paused: false })
  const [recordings, setRecordings] = useState<RecordingMeta[]>([])
  const [audio, setAudio] = useState(true)
  const [countdown, setCountdown] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Which recording has its trim controls open, and the chosen range. */
  const [trimming, setTrimming] = useState<{ id: string; start: number; end: number } | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [, forceTick] = useState(0)

  const refresh = useCallback(async () => setRecordings(await listRecordings()), [])

  useEffect(() => {
    void chrome.storage.local.get([AUDIO_KEY, COUNTDOWN_KEY]).then((stored) => {
      if (typeof stored[AUDIO_KEY] === 'boolean') setAudio(stored[AUDIO_KEY])
      if (typeof stored[COUNTDOWN_KEY] === 'number') setCountdown(stored[COUNTDOWN_KEY])
    })
    void send('record:state', undefined).then(setState).catch(() => undefined)
    void refresh()
  }, [refresh])

  // The worker owns recording state, so mirror it rather than duplicating it.
  useEffect(() => {
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || !changes['magpie:recording']) return
      const next = changes['magpie:recording'].newValue as RecordingState | undefined
      setState(next ?? { active: false, paused: false })
      if (!next?.active) void refresh()
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [refresh])

  // Re-render once a second purely so the elapsed clock advances.
  useEffect(() => {
    if (!state.active || state.paused) return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [state.active, state.paused])

  const start = useCallback(
    async (source: 'tab' | 'screen') => {
      setBusy(true)
      setError(null)
      try {
        // Screen capture raises Chrome's own share picker from inside the
        // offscreen document, so nothing is chosen here.
        const next = await send('record:start', { source, audio })
        setState(next)
        if (!next.active) setNotice('Recording cancelled.')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [audio],
  )

  const started = useRef(false)
  useEffect(() => {
    if (!autoRun || started.current) return
    started.current = true
    onAutoRun?.()
    void start(autoRun === 'record-tab' ? 'tab' : 'screen')
  }, [autoRun, onAutoRun, start])

  const stop = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await send('record:stop', undefined)
      setState({ active: false, paused: false })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const save = useCallback(async (meta: RecordingMeta) => {
    setError(null)
    try {
      const blob = await assembleRecording(meta.id)
      const url = URL.createObjectURL(blob)
      try {
        await chrome.downloads.download({
          url,
          filename: mediaName({
            title: meta.title,
            pageUrl: meta.url,
            mediaUrl: meta.url,
            extension: meta.extension,
          }),
          saveAs: false,
        })
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 120_000)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const saveTrimmed = useCallback(async () => {
    if (!trimming) return
    setWorking(trimming.id)
    setError(null)
    try {
      const meta = recordings.find((entry) => entry.id === trimming.id)
      if (!meta) throw new Error('That recording is no longer available')

      setNotice('Trimming…')
      const source = await assembleRecording(trimming.id)
      // A copy cut, so it lands on the nearest keyframe rather than re-encoding.
      const { trim } = await import('@/lib/ffmpeg')
      const clip = await trim(source, trimming.start, trimming.end)

      const url = URL.createObjectURL(clip)
      try {
        await chrome.downloads.download({
          url,
          filename: mediaName({
            title: `${meta.title} clip`,
            pageUrl: meta.url,
            mediaUrl: meta.url,
            extension: meta.extension,
          }),
          saveAs: false,
        })
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 120_000)
      }
      setNotice('Saved the trimmed clip')
      setTrimming(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorking(null)
    }
  }, [recordings, trimming])

  const elapsed = state.startedAt
    ? formatDuration(Date.now() - state.startedAt - (state.pausedMs ?? 0))
    : '0:00'

  return (
    <>
      <PanelHeader title="Record" hint="Capture this tab, or any screen or window." />

      <div className="space-y-2.5 border-b border-line px-4 pb-3">
        {state.active ? (
          <Card className="p-2.5">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 flex-none rounded-full ${
                  state.paused ? 'bg-ink-subtle' : 'animate-pulse bg-danger'
                }`}
              />
              <span className="text-[12px] font-medium tabular-nums text-ink">{elapsed}</span>
              <span className="text-[11px] text-ink-subtle">
                {state.source === 'screen' ? 'screen' : 'this tab'}
                {state.paused && ' · paused'}
              </span>
            </div>
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void send(state.paused ? 'record:resume' : 'record:pause', undefined)
                }
              >
                <PauseIcon size={13} /> {state.paused ? 'Resume' : 'Pause'}
              </Button>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void stop()}>
                <StopIcon size={13} /> Stop
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void start('tab')}>
                <RecordIcon size={14} /> This tab
              </Button>
              <Button disabled={busy} onClick={() => void start('screen')}>
                Screen…
              </Button>
            </div>

            <label className="flex items-center gap-2 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={audio}
                onChange={(event) => {
                  setAudio(event.target.checked)
                  void chrome.storage.local.set({ [AUDIO_KEY]: event.target.checked })
                }}
              />
              Include audio
            </label>

            <Field label="Countdown">
              <Select
                value={String(countdown)}
                onChange={(event) => {
                  const seconds = Number(event.target.value)
                  setCountdown(seconds)
                  void chrome.storage.local.set({ [COUNTDOWN_KEY]: seconds })
                }}
              >
                <option value="0">Off</option>
                <option value="3">3 seconds</option>
                <option value="5">5 seconds</option>
              </Select>
            </Field>
            <p className="text-[10px] leading-snug text-ink-subtle">
              Tab audio stays audible while recording. Recording this tab captures the on-page
              control too — collapse it with the “–” button first.
            </p>
          </>
        )}

        {notice && <Message tone="warning">{notice}</Message>}
        {error && <Message tone="error">{error}</Message>}
        {error && /reload/i.test(error) && (
          <Button
            size="sm"
            onClick={() => {
              setError(null)
              void chrome.tabs
                .query({ active: true, lastFocusedWindow: true })
                .then(([tab]) => {
                  if (tab?.id !== undefined) void chrome.tabs.reload(tab.id)
                })
            }}
          >
            Reload this tab
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {recordings.length === 0 && (
          <Empty icon={<RecordIcon size={26} />}>
            No recordings yet. They are saved as MP4 where Chrome supports it.
          </Empty>
        )}

        <ul className="space-y-2">
          {recordings.map((meta) => (
            <li key={meta.id}>
              <Card className="p-2.5">
                <p className="truncate text-[12px] font-medium text-ink" title={meta.title}>
                  {meta.title || 'Recording'}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-subtle">
                  {formatDuration(meta.durationMs)} · {formatBytes(meta.bytes)} ·{' '}
                  {meta.extension.toUpperCase()}
                  {!meta.hasAudio && ' · silent'}
                </p>

                {meta.extension === 'webm' && (
                  <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-warning-soft px-1.5 py-1 text-[10px] leading-snug text-warning">
                    <AlertIcon size={12} />
                    <span>Saved as WebM — this Chrome could not record MP4.</span>
                  </p>
                )}

                <div className="mt-2 flex items-center gap-1">
                  <Button size="sm" onClick={() => void save(meta)}>
                    <DownloadIcon size={13} /> Save
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      setTrimming((current) =>
                        current?.id === meta.id
                          ? null
                          : { id: meta.id, start: 0, end: Math.max(1, meta.durationMs / 1000) },
                      )
                    }
                  >
                    Trim
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label="Delete"
                    className="ml-auto"
                    onClick={() => void deleteRecording(meta.id).then(refresh)}
                  >
                    <TrashIcon size={13} />
                  </Button>
                </div>

                {trimming?.id === meta.id && (
                  <div className="mt-2 border-t border-line pt-2">
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={0}
                        step={0.1}
                        value={trimming.start}
                        onChange={(event) =>
                          setTrimming({ ...trimming, start: Number(event.target.value) })
                        }
                        className="w-16"
                        aria-label="Start seconds"
                      />
                      <span className="text-[11px] text-ink-subtle">to</span>
                      <Input
                        type="number"
                        min={0}
                        step={0.1}
                        value={trimming.end}
                        onChange={(event) =>
                          setTrimming({ ...trimming, end: Number(event.target.value) })
                        }
                        className="w-16"
                        aria-label="End seconds"
                      />
                      <span className="text-[11px] text-ink-subtle">sec</span>
                      <Button
                        size="sm"
                        variant="primary"
                        className="ml-auto"
                        disabled={working === meta.id || trimming.end <= trimming.start}
                        onClick={() => void saveTrimmed()}
                      >
                        {working === meta.id ? 'Working…' : 'Save clip'}
                      </Button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-snug text-ink-subtle">
                      Cuts without re-encoding, so the start lands on the nearest keyframe.
                    </p>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
