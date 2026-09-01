import { useCallback, useEffect, useRef, useState } from 'react'
import { send, sendToTab, type ClippedArticle } from '@/lib/protocol'
import { sanitize, timestamp } from '@/lib/filename'
import { Button, Card, Empty, Message, PanelHeader } from './ui'
import { ClipIcon, CopyIcon, DownloadIcon } from './icons'

async function saveText(text: string, filename: string, type: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type }))
  try {
    await chrome.downloads.download({ url, filename, saveAs: false })
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/** Front matter makes the file useful in Obsidian and friends. */
function withFrontMatter(clipped: ClippedArticle): string {
  const escape = (value: string) => value.replace(/"/g, '\\"')
  return [
    '---',
    `title: "${escape(clipped.title)}"`,
    `source: "${clipped.url}"`,
    clipped.byline ? `author: "${escape(clipped.byline)}"` : null,
    clipped.siteName ? `site: "${escape(clipped.siteName)}"` : null,
    `clipped: ${new Date().toISOString()}`,
    '---',
    '',
    clipped.markdown,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

export default function ClipPanel({
  autoRun = null,
  onAutoRun,
}: { autoRun?: 'clip' | null; onAutoRun?: () => void } = {}) {
  const [article, setArticle] = useState<ClippedArticle | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(timer)
  }, [notice])

  const clip = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const { id } = await send('sys:activeTab', undefined)
      // The clipper needs the live DOM, so it runs in the page.
      setArticle(await sendToTab(id, 'clip:article', undefined))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])


  // Work handed over by the popup runs exactly once, even if props re-settle.
  const started = useRef(false)
  useEffect(() => {
    if (!autoRun || started.current) return
    started.current = true
    onAutoRun?.()
    void clip()
  }, [autoRun, onAutoRun, clip])

  const act = useCallback(async (label: string, action: () => Promise<unknown>) => {
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
      <PanelHeader
        title="Clip"
        hint="Strips navigation and adverts, then converts the article to Markdown."
      />

      <div className="space-y-2 border-b border-line px-4 pb-3">
        <Button variant="primary" className="w-full" disabled={busy} onClick={() => void clip()}>
          {busy ? 'Reading page…' : 'Clip this page'}
        </Button>
        {error && <Message tone="error">{error}</Message>}
        {notice && <Message tone="success">{notice}</Message>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!article && (
          <Empty icon={<ClipIcon size={26} />}>
            Open an article and clip it to get clean Markdown with front matter.
          </Empty>
        )}

        {article && (
          <>
            <p className="text-[12px] font-medium leading-snug text-ink">{article.title}</p>
            <p className="mt-0.5 text-[11px] text-ink-subtle">
              {[article.siteName, article.byline, `${article.wordCount} words`]
                .filter(Boolean)
                .join(' · ')}
            </p>

            <div className="mt-2.5 flex gap-1.5">
              <Button
                size="sm"
                onClick={() =>
                  void act('Copied', () => navigator.clipboard.writeText(withFrontMatter(article)))
                }
              >
                <CopyIcon size={13} /> Copy
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void act('Saved', () =>
                    saveText(
                      withFrontMatter(article),
                      `Magpie/Clips/${sanitize(article.title)} ${timestamp()}.md`,
                      'text/markdown',
                    ),
                  )
                }
              >
                <DownloadIcon size={13} /> Save .md
              </Button>
            </div>

            <Card className="mt-3">
              <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap p-2.5 text-[11px] leading-relaxed text-ink-muted">
                {article.markdown.slice(0, 4000)}
                {article.markdown.length > 4000 ? '\n\n…' : ''}
              </pre>
            </Card>
          </>
        )}
      </div>
    </>
  )
}
