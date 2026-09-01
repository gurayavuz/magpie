/**
 * DOCX import.
 *
 * Input only. Reading a .docx is a matter of unzipping and mapping styles, which
 * mammoth does in ~200KB; *writing* one well needs a much heavier dependency, so
 * the export path here is Markdown, HTML or PDF instead.
 */

import { htmlToMarkdown } from './text'

export interface DocxResult {
  html: string
  markdown: string
  /** Anything mammoth could not map cleanly, worth surfacing to the user. */
  warnings: string[]
}

export async function convertDocx(file: ArrayBuffer): Promise<DocxResult> {
  // Loaded on demand: this is the heaviest converter and most sessions never
  // touch it.
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToHtml(
    { arrayBuffer: file },
    {
      // Inline images so the output is a single self-contained file.
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.read('base64')
        return { src: `data:${image.contentType};base64,${base64}` }
      }),
    },
  )

  return {
    html: result.value,
    markdown: htmlToMarkdown(result.value),
    warnings: result.messages.map((message) => message.message),
  }
}
