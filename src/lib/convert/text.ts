/**
 * Markdown and HTML conversion.
 *
 * `htmlToMarkdown` needs a DOM, so it runs in a page context rather than the
 * service worker.
 */

import { marked } from 'marked'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

export async function markdownToHtml(markdown: string): Promise<string> {
  return marked.parse(markdown, { gfm: true, breaks: false })
}

/** Wrap rendered Markdown in a readable standalone document. */
export async function markdownToHtmlDocument(markdown: string, title = 'Document'): Promise<string> {
  const body = await markdownToHtml(markdown)
  const escapedTitle = title.replace(/[<>&]/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&amp;',
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 16px/1.65 system-ui, -apple-system, sans-serif; }
  pre { overflow-x: auto; padding: 1rem; border-radius: 8px; background: #0002; }
  code { font-family: ui-monospace, monospace; font-size: 0.9em; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; }
  blockquote { margin: 1rem 0; padding-left: 1rem; border-left: 3px solid #8886; }
</style>
</head>
<body>
${body}
</body>
</html>`
}

let turndown: TurndownService | undefined

export function htmlToMarkdown(html: string): string {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
    })
    turndown.use(gfm)
    turndown.remove(['script', 'style', 'noscript'])
  }
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim()
}
