/**
 * Hand-off between the popup and the side panel.
 *
 * The popup closes the moment the panel takes focus, so it cannot run anything
 * itself that needs to report progress. Instead it records what the user asked
 * for and the panel picks it up — reading it on mount, and also watching for a
 * later write, since which of the two happens first is a race.
 */

export type PanelSection = 'shots' | 'record' | 'media' | 'clip' | 'convert'

/** Work the panel should start as soon as it opens. */
export type PanelAction =
  | 'capture-full'
  | 'capture-visible'
  | 'record-tab'
  | 'record-screen'
  | 'clip'

export interface PanelIntent {
  section: PanelSection
  action?: PanelAction
  at: number
}

const INTENT_KEY = 'magpie:intent'
const SECTION_KEY = 'magpie:section'

/** Ignore anything stale, so reopening the panel later does not re-fire an action. */
const MAX_AGE_MS = 15_000

export async function setIntent(section: PanelSection, action?: PanelAction): Promise<void> {
  await chrome.storage.local.set({
    [INTENT_KEY]: { section, action, at: Date.now() } satisfies PanelIntent,
  })
}

function fresh(value: unknown): PanelIntent | undefined {
  const intent = value as PanelIntent | undefined
  if (!intent?.section) return undefined
  return Date.now() - intent.at < MAX_AGE_MS ? intent : undefined
}

/** Read and clear the pending intent, so it only ever runs once. */
export async function takeIntent(): Promise<PanelIntent | undefined> {
  const stored = await chrome.storage.local.get(INTENT_KEY)
  const intent = fresh(stored[INTENT_KEY])
  if (stored[INTENT_KEY]) await chrome.storage.local.remove(INTENT_KEY)
  return intent
}

/**
 * Watch for an intent written after the panel already mounted. Returns an
 * unsubscribe function.
 */
export function onIntent(handler: (intent: PanelIntent) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local') return
    const intent = fresh(changes[INTENT_KEY]?.newValue)
    if (!intent) return
    void chrome.storage.local.remove(INTENT_KEY)
    handler(intent)
  }

  chrome.storage.onChanged.addListener(listener)
  return () => chrome.storage.onChanged.removeListener(listener)
}

export async function rememberSection(section: PanelSection): Promise<void> {
  await chrome.storage.local.set({ [SECTION_KEY]: section })
}

export async function lastSection(): Promise<PanelSection | undefined> {
  const stored = await chrome.storage.local.get(SECTION_KEY)
  return stored[SECTION_KEY] as PanelSection | undefined
}
