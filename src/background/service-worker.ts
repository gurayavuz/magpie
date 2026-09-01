import { listen } from '@/lib/protocol'
import { extensionFor, mediaName } from '@/lib/filename'
import { pruneShots } from '@/lib/shot-store'
import { runCapture } from './capture'
import { installRecordingHandlers, startRecording } from './recording'
import { installMediaWatcher, resolveLink } from './media'

chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the popup; the popup opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'aio-capture-full',
      title: 'Capture full page',
      contexts: ['page'],
    })
    // A context-menu click counts as invoking the extension on the tab, which is
    // what grants the activeTab permission that tab recording requires.
    chrome.contextMenus.create({
      id: 'aio-record-tab',
      title: 'Record this tab',
      contexts: ['page'],
    })
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'aio-capture-full' && tab?.id) {
    void runCapture({ tabId: tab.id, mode: 'full' })
  }
  if (info.menuItemId === 'aio-record-tab' && tab?.id) {
    void chrome.storage.local
      .get('magpie:record:audio')
      .then((stored) =>
        startRecording({ source: 'tab', audio: stored['magpie:record:audio'] !== false }),
      )
  }
})

// Keep the shot store from growing without bound across sessions.
chrome.runtime.onStartup.addListener(() => {
  void pruneShots()
})

installMediaWatcher()
installRecordingHandlers()

listen({
  'capture:run': (options) => runCapture(options),

  'media:resolveLink': ({ url }) => resolveLink(url),

  'media:download': async ({ item, filename }) => {
    // Playlists are assembled in the side panel, which can hold an object URL
    // and survive longer than an evictable service worker.
    if (item.kind === 'hls' || item.kind === 'dash') {
      throw new Error('Streams are assembled in the panel, not downloaded directly')
    }
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename:
        filename ??
        mediaName({
          title: item.pageTitle,
          pageUrl: item.pageUrl,
          mediaUrl: item.url,
          extension: extensionFor(item.url, item.kind === 'audio' ? 'mp3' : 'mp4'),
        }),
      saveAs: false,
    })
    return { downloadId }
  },

  'sys:activeTab': async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab?.id) throw new Error('No active tab')
    return { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' }
  },
})
