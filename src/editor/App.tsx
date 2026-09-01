import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  exportScene,
  normaliseBox,
  renderScene,
  type Shape,
  type ShapeKind,
} from '@/lib/annotate'
import { screenshotName } from '@/lib/filename'
import { getShot } from '@/lib/shot-store'
import type { CaptureResult } from '@/lib/protocol'

/** Very tall captures are previewed scaled down; export always runs at full size. */
const MAX_PREVIEW_EDGE = 2400

const TOOLS: { kind: ShapeKind; label: string; hint: string }[] = [
  { kind: 'blur', label: 'Blur', hint: 'Mosaic a region to redact it' },
  { kind: 'rect', label: 'Box', hint: 'Outline a region' },
  { kind: 'arrow', label: 'Arrow', hint: 'Point at something' },
  { kind: 'highlight', label: 'Highlight', hint: 'Tint a region' },
  { kind: 'text', label: 'Text', hint: 'Click to place a label' },
]

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#0f172a']

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [base, setBase] = useState<ImageBitmap | null>(null)
  const [meta, setMeta] = useState<CaptureResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [tool, setTool] = useState<ShapeKind>('blur')
  const [color, setColor] = useState(COLORS[0]!)
  const [strokeWidth, setStrokeWidth] = useState(4)

  const [shapes, setShapes] = useState<Shape[]>([])
  const [redoStack, setRedoStack] = useState<Shape[][]>([])
  const [draft, setDraft] = useState<Shape | null>(null)
  const [pendingText, setPendingText] = useState<{ x: number; y: number; value: string } | null>(
    null,
  )

  const shotId = useMemo(() => new URLSearchParams(location.search).get('id'), [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    let cancelled = false
    let bitmap: ImageBitmap | undefined

    void (async () => {
      if (!shotId) {
        setError('No capture was specified')
        return
      }
      try {
        const stored = await getShot(shotId)
        if (!stored) throw new Error('That capture is no longer in the library')
        bitmap = await createImageBitmap(stored.blob)
        if (cancelled) {
          bitmap.close()
          return
        }
        setBase(bitmap)
        setMeta(stored.meta)
        document.title = `Editing - ${stored.meta.title || 'capture'}`
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()

    return () => {
      cancelled = true
      bitmap?.close()
    }
  }, [shotId])

  const previewScale = useMemo(() => {
    if (!base) return 1
    return Math.min(1, MAX_PREVIEW_EDGE / Math.max(base.width, base.height))
  }, [base])

  // Redraw whenever the scene changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !base) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(previewScale, 0, 0, previewScale, 0, 0)
    renderScene(ctx, base, draft ? [...shapes, draft] : shapes, {
      width: base.width,
      height: base.height,
    })
  }, [base, shapes, draft, previewScale])

  /** Pointer position in image coordinates, not screen coordinates. */
  const toImageCoords = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    }
  }, [])

  const commit = useCallback((shape: Shape) => {
    setShapes((previous) => [...previous, shape])
    setRedoStack([])
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!base) return
      const at = toImageCoords(event)
      // The canvas is CSS-scaled, so convert back out of preview space.
      const point = { x: at.x / previewScale, y: at.y / previewScale }

      if (tool === 'text') {
        setPendingText({ ...point, value: '' })
        return
      }

      event.currentTarget.setPointerCapture(event.pointerId)
      const id = crypto.randomUUID()
      setDraft(
        tool === 'arrow'
          ? { id, kind: 'arrow', color, strokeWidth, x1: point.x, y1: point.y, x2: point.x, y2: point.y }
          : { id, kind: tool, color, strokeWidth, x: point.x, y: point.y, width: 0, height: 0 },
      )
    },
    [base, color, previewScale, strokeWidth, tool, toImageCoords],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!draft) return
      const at = toImageCoords(event)
      const point = { x: at.x / previewScale, y: at.y / previewScale }

      setDraft((current) => {
        if (!current) return current
        if (current.kind === 'arrow') return { ...current, x2: point.x, y2: point.y }
        if (current.kind === 'text') return current
        return { ...current, width: point.x - current.x, height: point.y - current.y }
      })
    },
    [draft, previewScale, toImageCoords],
  )

  const onPointerUp = useCallback(() => {
    if (!draft) return
    // Discard accidental clicks that produced nothing meaningful.
    const meaningful =
      draft.kind === 'arrow'
        ? Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 8
        : draft.kind === 'text' || Math.abs(draft.width) > 6 || Math.abs(draft.height) > 6

    if (meaningful) {
      commit(draft.kind === 'arrow' || draft.kind === 'text' ? draft : { ...draft, ...normaliseBox(draft) })
    }
    setDraft(null)
  }, [commit, draft])

  const undo = useCallback(() => {
    setShapes((previous) => {
      if (previous.length === 0) return previous
      const last = previous[previous.length - 1]!
      setRedoStack((stack) => [...stack, [last]])
      return previous.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      const last = stack[stack.length - 1]
      if (!last) return stack
      setShapes((previous) => [...previous, ...last])
      return stack.slice(0, -1)
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (pendingText) return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingText, redo, undo])

  const withExport = useCallback(
    async (action: (blob: Blob) => Promise<void>, done: string) => {
      if (!base) return
      setError(null)
      try {
        const blob = await exportScene(base, shapes, { width: base.width, height: base.height })
        await action(blob)
        setNotice(done)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [base, shapes],
  )

  const download = useCallback(
    () =>
      withExport(async (blob) => {
        const url = URL.createObjectURL(blob)
        try {
          await chrome.downloads.download({
            url,
            filename: screenshotName({
              title: meta?.title ?? 'annotated',
              url: meta?.url ?? '',
              extension: 'png',
            }),
            saveAs: false,
          })
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
      }, 'Saved'),
    [meta, withExport],
  )

  const copy = useCallback(
    () =>
      withExport(
        (blob) => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]),
        'Copied',
      ),
    [withExport],
  )

  if (error && !base) {
    return <div className="p-6 text-sm text-danger">{error}</div>
  }

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="flex gap-1">
          {TOOLS.map(({ kind, label, hint }) => (
            <button
              key={kind}
              type="button"
              title={hint}
              onClick={() => setTool(kind)}
              className={`rounded px-2.5 py-1.5 text-xs transition ${
                tool === kind ? 'bg-accent font-medium text-accent-fg' : 'bg-surface border border-line hover:bg-surface-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-2 flex gap-1">
          {COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={`Colour ${swatch}`}
              onClick={() => setColor(swatch)}
              style={{ background: swatch }}
              className={`h-6 w-6 rounded-full border-2 transition ${
                color === swatch ? 'border-white' : 'border-transparent'
              }`}
            />
          ))}
        </div>

        <label className="ml-2 flex items-center gap-1.5 text-xs text-ink-muted">
          Size
          <input
            type="range"
            min={2}
            max={16}
            value={strokeWidth}
            onChange={(event) => setStrokeWidth(Number(event.target.value))}
            className="w-24"
          />
        </label>

        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            onClick={undo}
            disabled={shapes.length === 0}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs transition-colors hover:bg-surface-hover disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.length === 0}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs transition-colors hover:bg-surface-hover disabled:opacity-40"
          >
            Redo
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs transition-colors hover:bg-surface-hover"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={() => void download()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Save
          </button>
        </div>
      </header>

      {(error || notice) && (
        <div className="px-4 py-1.5 text-xs">
          {error && <span className="text-danger">{error}</span>}
          {notice && <span className="text-success">{notice}</span>}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto bg-surface-sunken p-4">
        {!base && <p className="text-xs text-ink-subtle">Loading capture...</p>}
        <canvas
          ref={canvasRef}
          width={base ? Math.round(base.width * previewScale) : 0}
          height={base ? Math.round(base.height * previewScale) : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="mx-auto block max-w-full cursor-crosshair shadow-lg"
          style={{ touchAction: 'none' }}
        />

        {pendingText && base && (
          <div
            className="absolute"
            style={{
              left: pendingText.x * previewScale + 16,
              top: pendingText.y * previewScale + 16,
            }}
          >
            <input
              autoFocus
              value={pendingText.value}
              placeholder="Type, then Enter"
              onChange={(event) =>
                setPendingText((current) =>
                  current ? { ...current, value: event.target.value } : current,
                )
              }
              onKeyDown={(event) => {
                if (event.key === 'Escape') setPendingText(null)
                if (event.key !== 'Enter') return
                const value = pendingText.value.trim()
                if (value) {
                  commit({
                    id: crypto.randomUUID(),
                    kind: 'text',
                    color,
                    strokeWidth,
                    x: pendingText.x,
                    y: pendingText.y,
                    text: value,
                    fontSize: Math.max(16, strokeWidth * 6),
                  })
                }
                setPendingText(null)
              }}
              className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink"
            />
          </div>
        )}
      </div>
    </div>
  )
}
