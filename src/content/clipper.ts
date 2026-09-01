/**
 * Article clipping.
 *
 * Readability strips the navigation, ads and boilerplate down to the article
 * body; Turndown turns that into Markdown. Both run in the content script
 * because they need the live DOM - a page's markup is often assembled by script
 * and would not survive being re-fetched.
 */

import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import type { ClippedArticle, Handlers } from '@/lib/protocol'

function makeTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    linkStyle: 'inlined',
  })
  // Tables, strikethrough and task lists.
  service.use(gfm)

  // Readability leaves these behind; they carry no meaning in Markdown.
  service.remove(['script', 'style', 'noscript', 'iframe'])

  // Keep figure captions, which Turndown would otherwise flatten into the image
  // line and make unreadable.
  service.addRule('figure', {
    filter: 'figure',
    replacement: (_content, node) => {
      const element = node as HTMLElement
      const image = element.querySelector('img')
      const caption = element.querySelector('figcaption')?.textContent?.trim()
      const alt = image?.getAttribute('alt') ?? ''
      const source = image?.getAttribute('src')
      if (!source) return caption ? `\n\n*${caption}*\n\n` : ''
      return `\n\n![${alt}](${source})${caption ? `\n\n*${caption}*` : ''}\n\n`
    },
  })

  return service
}

/**
 * Resolve every URL against the page before serialising, so links and images in
 * the Markdown still work once the file lives somewhere else.
 */
function absolutise(root: HTMLElement): void {
  for (const image of root.querySelectorAll('img')) {
    const source = image.getAttribute('src')
    // Assigning through the property resolves against the document's base URL.
    if (source) image.src = source
    image.removeAttribute('srcset')
  }
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href')
    if (href) link.href = href
  }
}

function clipArticle(): ClippedArticle {
  // Readability mutates what it parses, so give it a copy of the document.
  const article = new Readability(document.cloneNode(true) as Document).parse()
  if (!article?.content) {
    throw new Error('No article could be extracted from this page')
  }

  const holder = document.createElement('div')
  holder.innerHTML = article.content
  absolutise(holder)

  const markdown = makeTurndown().turndown(holder).replace(/\n{3,}/g, '\n\n').trim()
  const text = article.textContent ?? ''

  return {
    title: article.title ?? document.title,
    byline: article.byline ?? null,
    siteName: article.siteName ?? null,
    excerpt: article.excerpt ?? null,
    url: location.href,
    markdown,
    html: holder.innerHTML,
    wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
  }
}

export const clipperHandlers: Handlers = {
  'clip:article': () => clipArticle(),
}
