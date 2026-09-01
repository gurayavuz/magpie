/**
 * Recording orchestration.
 *
 * The worker owns no media itself: it obtains a stream id, hands it to the
 * offscreen document, and tracks state. State lives in `chrome.storage.session`
 * because the worker is evicted while idle and a recording easily outlives it.
 */

import {
  listen,
  send,
  sendToTab,
  type RecordingMeta,
  type RecordingState,
  type RecordSource,
} from '@/lib/protocol'
import { putRecording, pruneOrphans } from '@/lib/recording-store'
import { ensureContentScript } from './capture'

const STATE_KEY = 'magpie:recording'
const IDLE: RecordingState = { active: false, paused: false }

async function readState(): Promise<RecordingState> {
  const stored = await chrome.storage.session.get(STATE_KEY)
  return (stored[STATE_KEY] as RecordingState | undefined) ?? IDLE
}

async function writeState(state: RecordingState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state })
  await chrome.action.setBadgeText({ text: state.active ? 'REC' : '' })
  if (state.active) {
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
  }
}

/** The offscreen document is created on demand and closed when idle. */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (existing.length > 0) return

  await chrome.offscreen.createDocument({
    url: 'src/offscreen/index.html',
    // Both are declared because the same document serves tab and screen capture.
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
    justification: 'Records the tab or screen; MediaRecorder cannot run in a service worker.',
  })
}

async function closeOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (existing.length > 0) await chrome.offscreen.closeDocument().catch(() => undefined)
}

/** Tabs currently showing the control, so every one can be cleared on stop. */
const CONTROL_TABS_KEY = 'magpie:recording:controlTabs'

async function markControlShown(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(CONTROL_TABS_KEY)
  const tabs = new Set((stored[CONTROL_TABS_KEY] as number[] | undefined) ?? [])
  tabs.add(tabId)
  await chrome.storage.session.set({ [CONTROL_TABS_KEY]: [...tabs] })
}

async function showControl(tabId: number, state: RecordingState): Promise<void> {
  try {
    await ensureContentScript(tabId)
    await sendToTab(tabId, 'control:show', { state })
    await markControlShown(tabId)
  } catch {
    // A page that refuses injection still records; it just has no on-page control.
  }
}

async function hideAllControls(): Promise<void> {
  const stored = await chrome.storage.session.get(CONTROL_TABS_KEY)
  const tabs = (stored[CONTROL_TABS_KEY] as number[] | undefined) ?? []
  await Promise.all(
    tabs.map((tabId) => sendToTab(tabId, 'control:hide', undefined).catch(() => undefined)),
  )
  await chrome.storage.session.remove(CONTROL_TABS_KEY)
}

/**
 * Whether this tab should be showing the control.
 *
 * Recording a single tab pins the control to that tab. Recording the whole
 * screen has no such anchor — the controls need to be wherever the user is, so
 * they follow the active tab.
 */
function controlBelongsIn(state: RecordingState, tabId: number): boolean {
  if (!state.active) return false
  return state.source === 'screen' || state.tabId === tabId
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const COUNTDOWN_KEY = 'magpie:record:countdown'
const CANCEL_KEY = 'magpie:recording:cancelled'

async function countdownSeconds(): Promise<number> {
  const stored = await chrome.storage.local.get(COUNTDOWN_KEY)
  const value = stored[COUNTDOWN_KEY]
  return typeof value === 'number' ? value : 3
}

/**
 * Show the countdown and wait it out.
 *
 * Polled rather than a single sleep so a cancel takes effect when it is pressed
 * rather than whenever the countdown happens to end.
 */
async function runCountdown(tabId: number, seconds: number): Promise<boolean> {
  await chrome.storage.session.remove(CANCEL_KEY)

  let shown = false
  try {
    await ensureContentScript(tabId)
    await sendToTab(tabId, 'countdown:show', { seconds })
    shown = true
  } catch {
    // A page that refuses injection just gets no visible countdown.
  }

  const deadline = Date.now() + seconds * 1000
  let cancelled = false
  while (Date.now() < deadline) {
    await delay(120)
    const stored = await chrome.storage.session.get(CANCEL_KEY)
    if (stored[CANCEL_KEY]) {
      cancelled = true
      break
    }
  }

  if (shown) await sendToTab(tabId, 'countdown:hide', undefined).catch(() => undefined)
  await chrome.storage.session.remove(CANCEL_KEY)
  return !cancelled
}

export async function startRecording(options: {
  source: RecordSource
  audio: boolean
}): Promise<RecordingState> {
  if ((await readState()).active) throw new Error('A recording is already running')

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error('No active tab')

  if (options.source === 'tab' && tab.url && /^(chrome|edge|about|devtools):|chromewebstore/i.test(tab.url)) {
    throw new Error('Chrome does not allow recording its own pages. Try an ordinary web page.')
  }

  // Chrome refuses a second capture request for a tab that already has one, and
  // reports it only as "Error starting tab capture". A request outlives a failed
  // attempt and is released when the tab navigates or closes, so an earlier
  // failure leaves the tab stuck until it is reloaded. Detect that up front and
  // say so, rather than relaying a message that explains nothing.
  if (options.source === 'tab') {
    const captured = await chrome.tabCapture.getCapturedTabs().catch(() => [])
    if (captured.some((entry) => entry.tabId === tab.id && entry.status !== 'stopped')) {
      throw new Error(
        'This tab already has a capture in progress, which Chrome will not release until the tab reloads. Reload the tab, then start the recording again.',
      )
    }
  }

  // The consumer must exist before a tab stream id is issued: ids are single-use
  // and expire within seconds, and building the document takes long enough to
  // lose one.
  await closeOffscreen()
  await ensureOffscreen()

  let streamId: string | undefined
  if (options.source === 'tab') {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id })
    } catch (error) {
      await closeOffscreen()
      // Tab capture needs activeTab, which Chrome only grants when the extension
      // is invoked *on that tab* - the toolbar button, a context menu entry or a
      // shortcut. A click inside the side panel does not count, so say what will.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        /not been invoked|activeTab/i.test(message)
          ? 'Chrome only allows tab recording when started from the toolbar. Click the Magpie icon and choose "Record this tab", or right-click the page and choose it there. "Screen…" works from here.'
          : /already/i.test(message)
            ? 'That tab is already being captured. Stop the other capture, or reload the tab.'
            : `${message} A tab can only have one capture at a time and Chrome keeps the old one until the tab reloads, so reload this tab and try again.`,
      )
    }
  } else {
    // Screen capture raises its own picker inside the offscreen document, so
    // there is no stream id to hand over.
    streamId = undefined
  }

  const id = crypto.randomUUID()

  let mimeType: string
  let hasAudio: boolean
  try {
    // Opens the stream but records nothing yet.
    const opened = await send('offscreen:open', {
      id,
      streamId,
      source: options.source,
      audio: options.audio,
    })
    mimeType = opened.mimeType
    hasAudio = opened.hasAudio
  } catch (error) {
    await closeOffscreen()
    throw error
  }

  // Count down with the stream already live, so the countdown itself is never
  // captured and backing out costs nothing.
  const seconds = await countdownSeconds()
  if (seconds > 0) {
    const wentAhead = await runCountdown(tab.id, seconds)
    if (!wentAhead) {
      await send('offscreen:discard', undefined).catch(() => undefined)
      await closeOffscreen()
      return IDLE
    }
  }

  try {
    await send('offscreen:begin', undefined)
  } catch (error) {
    await send('offscreen:discard', undefined).catch(() => undefined)
    await closeOffscreen()
    throw error
  }

  const state: RecordingState = {
    active: true,
    paused: false,
    startedAt: Date.now(),
    pausedMs: 0,
    source: options.source,
    tabId: tab.id,
  }
  await writeState(state)
  // Everything stop() needs, recorded now while it is still known.
  await chrome.storage.session.set({
    'magpie:recording:pending': {
      id,
      mimeType,
      audio: hasAudio,
      tab: { title: tab.title, url: tab.url },
    },
  })
  await showControl(tab.id, state)
  return state
}

export async function stopRecording(): Promise<RecordingMeta | null> {
  const state = await readState()
  if (!state.active) return null

  const result = await send('offscreen:stop', undefined).catch(() => null)
  await closeOffscreen()

  const stored = await chrome.storage.session.get('magpie:recording:pending')
  const pending = stored['magpie:recording:pending'] as
    | { id: string; mimeType: string; audio: boolean; tab: { title?: string; url?: string } }
    | undefined

  await writeState(IDLE)
  await chrome.storage.session.remove('magpie:recording:pending')
  await hideAllControls()

  if (!result || !pending || result.bytes === 0) return null

  // MediaRecorder reported the container it actually produced, so trust that
  // rather than assuming MP4 was available.
  const meta: RecordingMeta = {
    id: pending.id,
    source: state.source ?? 'tab',
    mimeType: pending.mimeType,
    extension: pending.mimeType.includes('mp4') ? 'mp4' : 'webm',
    bytes: result.bytes,
    durationMs: result.durationMs,
    startedAt: state.startedAt ?? Date.now(),
    hasAudio: pending.audio,
    title: pending.tab.title ?? '',
    url: pending.tab.url ?? '',
  }
  await putRecording(meta)
  void pruneOrphans()
  return meta
}

async function setPaused(paused: boolean): Promise<RecordingState> {
  const state = await readState()
  if (!state.active) return state

  await send(paused ? 'offscreen:pause' : 'offscreen:resume', undefined).catch(() => undefined)
  const next: RecordingState = { ...state, paused }
  await writeState(next)

  // Every visible control must reflect the new state, not just the first one.
  const stored = await chrome.storage.session.get(CONTROL_TABS_KEY)
  const tabs = (stored[CONTROL_TABS_KEY] as number[] | undefined) ?? []
  await Promise.all(
    tabs.map((tabId) =>
      sendToTab(tabId, 'control:show', { state: next }).catch(() => undefined),
    ),
  )
  return next
}

export function installRecordingHandlers(): void {
  // A recorded tab that closes or navigates away should not leave a stuck badge.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void readState().then((state) => {
      if (state.active && state.source === 'tab' && state.tabId === tabId) void stopRecording()
    })
  })

  // During a screen recording the controls follow the user between tabs, and a
  // navigation destroys the injected control, so it is put back on load.
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void readState().then((state) => {
      if (controlBelongsIn(state, tabId)) void showControl(tabId, state)
    })
  })

  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete') return
    void readState().then((state) => {
      if (controlBelongsIn(state, tabId)) void showControl(tabId, state)
    })
  })

  listen({
    'record:start': (options) => startRecording(options),
    'record:stop': () => stopRecording(),
    'record:pause': () => setPaused(true),
    'record:resume': () => setPaused(false),
    'record:state': () => readState(),
    'record:cancel': async () => {
      await chrome.storage.session.set({ [CANCEL_KEY]: true })
    },
  })
}
