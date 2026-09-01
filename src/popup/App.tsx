import { useCallback, useState } from 'react'
import { send } from '@/lib/protocol'
import { setIntent, type PanelAction, type PanelSection } from '@/lib/intent'
import {
  CameraIcon,
  ClipIcon,
  ConvertIcon,
  PlayIcon,
  RecordIcon,
  SearchIcon,
} from '@/sidepanel/icons'

interface Entry {
  label: string
  hint: string
  icon: React.ReactNode
  section: PanelSection
  action?: PanelAction
}

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Capture',
    entries: [
      {
        label: 'Full page',
        hint: 'Scroll and stitch the whole page',
        icon: <CameraIcon size={16} />,
        section: 'shots',
        action: 'capture-full',
      },
      {
        label: 'Visible area',
        hint: 'Just what is on screen',
        icon: <CameraIcon size={16} />,
        section: 'shots',
        action: 'capture-visible',
      },
    ],
  },
  {
    title: 'Record',
    entries: [
      {
        label: 'Record this tab',
        hint: 'Starts straight away, no dialog',
        icon: <RecordIcon size={16} />,
        section: 'record',
        action: 'record-tab',
      },
      {
        label: 'Record screen',
        hint: 'Pick a screen, window or tab',
        icon: <RecordIcon size={16} />,
        section: 'record',
        action: 'record-screen',
      },
    ],
  },
  {
    title: 'Collect',
    entries: [
      {
        label: 'Download media',
        hint: 'Paste a post or video link',
        icon: <PlayIcon size={16} />,
        section: 'media',
      },
      {
        label: 'Clip article',
        hint: 'Save the page as Markdown',
        icon: <ClipIcon size={16} />,
        section: 'clip',
        action: 'clip',
      },
    ],
  },
  {
    title: 'Files',
    entries: [
      {
        label: 'Convert files',
        hint: 'Images, PDF, CSV, DOCX',
        icon: <ConvertIcon size={16} />,
        section: 'convert',
      },
      {
        label: 'Browse captures',
        hint: 'Everything saved so far',
        icon: <SearchIcon size={16} />,
        section: 'shots',
      },
    ],
  },
]

export default function App() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const launch = useCallback(async (entry: Entry) => {
    setBusy(true)
    setError(null)
    try {
      // Recording needs no panel: the screen picker is raised by the offscreen
      // document and the floating control is the stop button, so opening the
      // side panel would just put a surface on screen nobody asked for.
      if (entry.action === 'record-tab' || entry.action === 'record-screen') {
        const stored = await chrome.storage.local.get('magpie:record:audio')
        await send('record:start', {
          source: entry.action === 'record-tab' ? 'tab' : 'screen',
          audio: stored['magpie:record:audio'] !== false,
        })
        window.close()
        return
      }

      // Record first: the panel may mount before this resolves, which is why it
      // also listens for a later write.
      await setIntent(entry.section, entry.action)

      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (!tab?.windowId) throw new Error('No active window')
      await chrome.sidePanel.open({ windowId: tab.windowId })
      window.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }, [])

  return (
    <div className="w-[248px] bg-bg pb-1.5">
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <img
          src={chrome.runtime.getURL('icons/icon-32.png')}
          alt=""
          className="h-5 w-5 rounded-[5px]"
        />
        <span className="text-[12px] font-semibold tracking-tight text-ink">Magpie</span>
      </div>

      {GROUPS.map((group) => (
        <div key={group.title} className="px-1.5 pt-1.5">
          <h2 className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
            {group.title}
          </h2>
          {group.entries.map((entry) => (
            <button
              key={entry.label}
              type="button"
              disabled={busy}
              onClick={() => void launch(entry)}
              className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <span className="text-ink-muted">{entry.icon}</span>
              <span className="min-w-0">
                <span className="block text-[12px] font-medium leading-tight text-ink">
                  {entry.label}
                </span>
                <span className="block truncate text-[11px] leading-tight text-ink-subtle">
                  {entry.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}

      {error && <p className="px-3 pt-2 text-[11px] text-danger">{error}</p>}
    </div>
  )
}
