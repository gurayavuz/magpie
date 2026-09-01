import { useCallback, useEffect, useState } from 'react'
import ScreenshotsPanel from './ScreenshotsPanel'
import MediaPanel from './MediaPanel'
import ClipPanel from './ClipPanel'
import ConvertPanel from './ConvertPanel'
import RecordPanel from './RecordPanel'
import { CameraIcon, ClipIcon, ConvertIcon, PlayIcon, RecordIcon } from './icons'
import {
  lastSection,
  onIntent,
  rememberSection,
  takeIntent,
  type PanelAction,
  type PanelSection,
} from '@/lib/intent'

const SECTIONS = [
  { id: 'shots', label: 'Screenshots', Icon: CameraIcon },
  { id: 'record', label: 'Record', Icon: RecordIcon },
  { id: 'media', label: 'Media', Icon: PlayIcon },
  { id: 'clip', label: 'Clip', Icon: ClipIcon },
  { id: 'convert', label: 'Convert', Icon: ConvertIcon },
] as const satisfies readonly { id: PanelSection; label: string; Icon: unknown }[]

export default function App() {
  const [section, setSection] = useState<PanelSection>('shots')
  /** Work handed over by the popup, cleared once the panel has started it. */
  const [pending, setPending] = useState<PanelAction | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      // An intent from the popup wins over whatever section was last open.
      const intent = await takeIntent()
      if (cancelled) return

      if (intent) {
        setSection(intent.section)
        setPending(intent.action ?? null)
        return
      }
      const saved = await lastSection()
      if (!cancelled && saved && SECTIONS.some((entry) => entry.id === saved)) setSection(saved)
    })()

    // The popup may write its intent after this panel has already mounted, so
    // reading once on mount is not enough.
    const stop = onIntent((intent) => {
      setSection(intent.section)
      setPending(intent.action ?? null)
    })

    return () => {
      cancelled = true
      stop()
    }
  }, [])

  const choose = (id: PanelSection) => {
    setSection(id)
    setPending(null)
    void rememberSection(id)
  }

  /** Panels call this once they have picked up their handed-over action. */
  const consume = useCallback(() => setPending(null), [])

  return (
    <div className="flex h-full bg-bg text-ink">
      <nav
        aria-label="Sections"
        className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-sunken py-2"
      >
        <img
          src={chrome.runtime.getURL('icons/icon-32.png')}
          alt="Magpie"
          className="mb-1.5 h-6 w-6 rounded-[6px]"
        />

        {SECTIONS.map(({ id, label, Icon }) => {
          const active = section === id
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              onClick={() => choose(id)}
              className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                active
                  ? 'bg-accent-soft text-accent'
                  : 'text-ink-subtle hover:bg-surface-hover hover:text-ink'
              }`}
            >
              {/* Colour alone should not carry the active state. */}
              {active && <span className="absolute -left-1 h-5 w-[3px] rounded-r-full bg-accent" />}
              <Icon size={18} />
            </button>
          )
        })}
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {section === 'shots' && (
          <ScreenshotsPanel
            autoRun={pending === 'capture-full' || pending === 'capture-visible' ? pending : null}
            onAutoRun={consume}
          />
        )}
        {section === 'record' && (
          <RecordPanel
            autoRun={pending === 'record-tab' || pending === 'record-screen' ? pending : null}
            onAutoRun={consume}
          />
        )}
        {section === 'media' && <MediaPanel />}
        {section === 'clip' && (
          <ClipPanel autoRun={pending === 'clip' ? pending : null} onAutoRun={consume} />
        )}
        {section === 'convert' && <ConvertPanel />}
      </main>
    </div>
  )
}
