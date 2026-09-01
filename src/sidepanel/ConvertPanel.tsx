import { useCallback, useMemo, useRef, useState } from 'react'
import { sanitize, timestamp } from '@/lib/filename'
import { Button, Card, Empty, GroupLabel, Input, Message, PanelHeader, Select } from './ui'
import { ConvertIcon, FileIcon } from './icons'

type Group = 'image' | 'video' | 'audio' | 'pdf' | 'csv' | 'json' | 'markdown' | 'html' | 'docx' | 'other'

function groupOf(file: File): Group {
  const name = file.name.toLowerCase()
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/.test(name)) return 'video'
  if (file.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/.test(name)) return 'audio'
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv'
  if (name.endsWith('.json')) return 'json'
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown'
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  if (name.endsWith('.docx')) return 'docx'
  return 'other'
}

function stem(name: string): string {
  return sanitize(name.replace(/\.[^.]+$/, ''))
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  try {
    await chrome.downloads.download({ url, filename, saveAs: false })
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

const outputName = (name: string, extension: string) =>
  `Magpie/Converted/${stem(name)} ${timestamp()}.${extension}`

export default function ConvertPanel() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [imageFormat, setImageFormat] = useState<'png' | 'jpeg' | 'webp'>('png')
  const [maxEdge, setMaxEdge] = useState('')
  const [pageRange, setPageRange] = useState('')

  const groups = useMemo(() => {
    const map = new Map<Group, File[]>()
    for (const file of files) {
      map.set(groupOf(file), [...(map.get(groupOf(file)) ?? []), file])
    }
    return map
  }, [files])

  const run = useCallback(async (label: string, action: () => Promise<string>) => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      setNotice(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [])

  const images = groups.get('image') ?? []
  const pdfs = groups.get('pdf') ?? []
  const csvs = groups.get('csv') ?? []
  const jsons = groups.get('json') ?? []
  const markdowns = groups.get('markdown') ?? []
  const htmls = groups.get('html') ?? []
  const docxs = groups.get('docx') ?? []
  const videos = groups.get('video') ?? []
  const audios = groups.get('audio') ?? []
  const gifs = images.filter((file) => /gif/i.test(file.type) || /\.gif$/i.test(file.name))

  const Action = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <Button size="sm" disabled={busy !== null} onClick={onClick}>
      {busy === label ? 'Working…' : label}
    </Button>
  )

  return (
    <>
      <PanelHeader title="Convert" hint="Everything runs locally. Nothing is uploaded." />

      <div className="space-y-2 border-b border-line px-4 pb-3">
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={(event) => setFiles([...(event.target.files ?? [])])}
          className="hidden"
        />
        <Button variant="primary" className="w-full" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <p className="text-[11px] leading-snug text-ink-subtle">
          Images and SVG, video, audio, PDF, CSV, JSON, Markdown, HTML, DOCX.
        </p>
        {error && <Message tone="error">{error}</Message>}
        {notice && <Message tone="success">{notice}</Message>}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {files.length === 0 && (
          <Empty icon={<ConvertIcon size={26} />}>
            Choose files and the conversions available for them appear here.
          </Empty>
        )}

        {files.length > 0 && (
          <p className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
            <FileIcon size={13} />
            {files.length} file{files.length === 1 ? '' : 's'} selected
          </p>
        )}

        {images.length > 0 && (
          <Card className="p-2.5">
            <GroupLabel>Images · {images.length}</GroupLabel>
            <div className="mb-2 flex items-center gap-1.5">
              <Select
                value={imageFormat}
                onChange={(event) =>
                  setImageFormat(event.target.value as 'png' | 'jpeg' | 'webp')
                }
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </Select>
              <Input
                value={maxEdge}
                onChange={(event) => setMaxEdge(event.target.value)}
                placeholder="Max edge px"
                className="w-28"
              />
            </div>
            {images.some((file) => /svg/i.test(file.type) || /\.svg$/i.test(file.name)) && (
              <p className="mb-2 text-[10px] leading-snug text-ink-subtle">
                For SVG, max edge sets the render size and may scale up. Left blank, art with its
                own width and height keeps it; otherwise it renders 1024px wide.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <Action
                label="Convert"
                onClick={() =>
                  void run('Convert', async () => {
                    const { convertImage } = await import('@/lib/convert/images')
                    const cap = Number(maxEdge)
                    for (const file of images) {
                      const { blob } = await convertImage(file, {
                        format: imageFormat,
                        maxEdge: Number.isFinite(cap) && cap > 0 ? cap : undefined,
                      })
                      await saveBlob(
                        blob,
                        outputName(file.name, imageFormat === 'jpeg' ? 'jpg' : imageFormat),
                      )
                    }
                    return `Converted ${images.length} image${images.length === 1 ? '' : 's'}`
                  })
                }
              />
              {gifs.length > 0 && (
                <Action
                  label="GIF to MP4"
                  onClick={() =>
                    void run('GIF to MP4', async () => {
                      const { gifToVideo } = await import('@/lib/ffmpeg')
                      for (const file of gifs) {
                        await saveBlob(await gifToVideo(file), outputName(file.name, 'mp4'))
                      }
                      return 'Converted, keeping every frame'
                    })
                  }
                />
              )}
              <Action
                label="Read text (OCR)"
                onClick={() =>
                  void run('Read text (OCR)', async () => {
                    const { readImage, releaseOcr } = await import('@/lib/convert/ocr')
                    try {
                      let empty = 0
                      for (const file of images) {
                        const text = await readImage(file)
                        if (!text) empty++
                        await saveBlob(
                          new Blob([text], { type: 'text/plain' }),
                          outputName(file.name, 'txt'),
                        )
                      }
                      return empty
                        ? `${empty} produced no text — is there writing in them?`
                        : 'Read the text. Worth proofreading.'
                    } finally {
                      // ~6MB of engine and model; do not hold it after one job.
                      await releaseOcr()
                    }
                  })
                }
              />
              <Action
                label="To ICO"
                onClick={() =>
                  void run('To ICO', async () => {
                    const { imageToIco } = await import('@/lib/convert/ico')
                    for (const file of images) {
                      await saveBlob(await imageToIco(file), outputName(file.name, 'ico'))
                    }
                    return `Made ${images.length} icon${images.length === 1 ? '' : 's'}`
                  })
                }
              />
              <Action
                label="Combine into PDF"
                onClick={() =>
                  void run('Combine into PDF', async () => {
                    const [{ imagesToPdf }, { toPdfEmbeddable }] = await Promise.all([
                      import('@/lib/convert/pdf'),
                      import('@/lib/convert/images'),
                    ])
                    const prepared = await Promise.all(images.map(toPdfEmbeddable))
                    const bytes = await imagesToPdf(prepared)
                    await saveBlob(
                      new Blob([bytes as BlobPart], { type: 'application/pdf' }),
                      outputName(images[0]!.name, 'pdf'),
                    )
                    return `Combined ${images.length} images into a PDF`
                  })
                }
              />
            </div>
          </Card>
        )}

        {videos.length > 0 && (
          <Card className="p-2.5">
            <GroupLabel>Video · {videos.length}</GroupLabel>
            <div className="flex flex-wrap gap-1.5">
              <Action
                label="To MP4"
                onClick={() =>
                  void run('To MP4', async () => {
                    const { convertVideo } = await import('@/lib/ffmpeg')
                    for (const file of videos) {
                      await saveBlob(await convertVideo(file, 'mp4'), outputName(file.name, 'mp4'))
                    }
                    return `Converted ${videos.length} to MP4`
                  })
                }
              />
              <Action
                label="To WebM"
                onClick={() =>
                  void run('To WebM', async () => {
                    const { convertVideo } = await import('@/lib/ffmpeg')
                    for (const file of videos) {
                      await saveBlob(await convertVideo(file, 'webm'), outputName(file.name, 'webm'))
                    }
                    return `Converted ${videos.length} to WebM`
                  })
                }
              />
              <Action
                label="To GIF"
                onClick={() =>
                  void run('To GIF', async () => {
                    const { videoToGif } = await import('@/lib/ffmpeg')
                    for (const file of videos) {
                      await saveBlob(await videoToGif(file), outputName(file.name, 'gif'))
                    }
                    return 'Made a GIF'
                  })
                }
              />
              {(['mp3', 'm4a', 'wav'] as const).map((format) => (
                <Action
                  key={format}
                  label={`Audio · ${format.toUpperCase()}`}
                  onClick={() =>
                    void run(`Audio · ${format.toUpperCase()}`, async () => {
                      const { extractAudio } = await import('@/lib/ffmpeg')
                      for (const file of videos) {
                        await saveBlob(
                          await extractAudio(file, format),
                          outputName(file.name, format),
                        )
                      }
                      return `Extracted ${format.toUpperCase()}`
                    })
                  }
                />
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-ink-subtle">
              Video conversion re-encodes, so it runs at roughly real time. Pulling the audio out is
              much quicker.
            </p>
          </Card>
        )}

        {audios.length > 0 && (
          <Card className="p-2.5">
            <GroupLabel>Audio · {audios.length}</GroupLabel>
            <div className="flex flex-wrap gap-1.5">
              {(['mp3', 'm4a', 'wav'] as const).map((format) => (
                <Action
                  key={format}
                  label={`To ${format.toUpperCase()}`}
                  onClick={() =>
                    void run(`To ${format.toUpperCase()}`, async () => {
                      const { extractAudio } = await import('@/lib/ffmpeg')
                      for (const file of audios) {
                        await saveBlob(
                          await extractAudio(file, format),
                          outputName(file.name, format),
                        )
                      }
                      return `Converted to ${format.toUpperCase()}`
                    })
                  }
                />
              ))}
            </div>
          </Card>
        )}

        {pdfs.length > 0 && (
          <Card className="p-2.5">
            <GroupLabel>PDFs · {pdfs.length}</GroupLabel>
            <Input
              value={pageRange}
              onChange={(event) => setPageRange(event.target.value)}
              placeholder="Pages, e.g. 1-3, 5, 8-"
              className="mb-2 w-full"
            />
            <p className="mb-2 text-[10px] leading-snug text-ink-subtle">
              Use “To text” first. If it comes back empty the pages are scans, and “Read scan”
              recognises the writing instead — slower, and worth proofreading.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {pdfs.length > 1 && (
                <Action
                  label="Merge"
                  onClick={() =>
                    void run('Merge', async () => {
                      const { mergePdfs } = await import('@/lib/convert/pdf')
                      const buffers = await Promise.all(pdfs.map((file) => file.arrayBuffer()))
                      const bytes = await mergePdfs(buffers)
                      await saveBlob(
                        new Blob([bytes as BlobPart], { type: 'application/pdf' }),
                        outputName('merged', 'pdf'),
                      )
                      return `Merged ${pdfs.length} PDFs`
                    })
                  }
                />
              )}
              <Action
                label="Extract pages"
                onClick={() =>
                  void run('Extract pages', async () => {
                    const { extractPages } = await import('@/lib/convert/pdf')
                    for (const file of pdfs) {
                      const bytes = await extractPages(await file.arrayBuffer(), pageRange)
                      await saveBlob(
                        new Blob([bytes as BlobPart], { type: 'application/pdf' }),
                        outputName(`${stem(file.name)} pages`, 'pdf'),
                      )
                    }
                    return 'Extracted pages'
                  })
                }
              />
              <Action
                label="Rotate 90°"
                onClick={() =>
                  void run('Rotate 90°', async () => {
                    const { rotatePdf } = await import('@/lib/convert/pdf')
                    for (const file of pdfs) {
                      const bytes = await rotatePdf(await file.arrayBuffer(), 90, pageRange)
                      await saveBlob(
                        new Blob([bytes as BlobPart], { type: 'application/pdf' }),
                        outputName(`${stem(file.name)} rotated`, 'pdf'),
                      )
                    }
                    return 'Rotated'
                  })
                }
              />
              <Action
                label="To text"
                onClick={() =>
                  void run('To text', async () => {
                    const { pdfToText } = await import('@/lib/convert/pdf-read')
                    let empty = 0
                    for (const file of pdfs) {
                      const text = await pdfToText(await file.arrayBuffer())
                      if (!text.trim()) empty++
                      await saveBlob(
                        new Blob([text], { type: 'text/plain' }),
                        outputName(file.name, 'txt'),
                      )
                    }
                    // A scan is a picture of text and has no text layer at all.
                    return empty
                      ? `${empty} had no text layer — likely scans, which need OCR`
                      : 'Extracted the text'
                  })
                }
              />
              <Action
                label="Read scan (OCR)"
                onClick={() =>
                  void run('Read scan (OCR)', async () => {
                    const { readPdf, releaseOcr } = await import('@/lib/convert/ocr')
                    try {
                      for (const file of pdfs) {
                        const text = await readPdf(await file.arrayBuffer())
                        await saveBlob(
                          new Blob([text], { type: 'text/plain' }),
                          outputName(`${stem(file.name)} ocr`, 'txt'),
                        )
                      }
                      return 'Read the scan. Worth proofreading.'
                    } finally {
                      await releaseOcr()
                    }
                  })
                }
              />
              <Action
                label="Pages to PNG"
                onClick={() =>
                  void run('Pages to PNG', async () => {
                    const { pdfToImages } = await import('@/lib/convert/pdf-read')
                    let total = 0
                    for (const file of pdfs) {
                      const pages = await pdfToImages(await file.arrayBuffer())
                      for (const page of pages) {
                        await saveBlob(page.blob, outputName(`${stem(file.name)} p${page.page}`, 'png'))
                        total++
                      }
                    }
                    return `Rendered ${total} page${total === 1 ? '' : 's'}`
                  })
                }
              />
              <Action
                label="Split into pages"
                onClick={() =>
                  void run('Split into pages', async () => {
                    const { burstPdf } = await import('@/lib/convert/pdf')
                    let total = 0
                    for (const file of pdfs) {
                      const parts = await burstPdf(await file.arrayBuffer())
                      for (const [index, bytes] of parts.entries()) {
                        await saveBlob(
                          new Blob([bytes as BlobPart], { type: 'application/pdf' }),
                          outputName(`${stem(file.name)} p${index + 1}`, 'pdf'),
                        )
                        total++
                      }
                    }
                    return `Split into ${total} files`
                  })
                }
              />
            </div>
          </Card>
        )}

        {(csvs.length > 0 || jsons.length > 0) && (
          <Card className="p-2.5">
            <GroupLabel>Data · {csvs.length + jsons.length}</GroupLabel>
            <div className="flex flex-wrap gap-1.5">
              {csvs.length > 0 && (
                <>
                  <Action
                    label="CSV to JSON"
                    onClick={() =>
                      void run('CSV to JSON', async () => {
                        const { csvToJson } = await import('@/lib/convert/tabular')
                        for (const file of csvs) {
                          const rows = csvToJson(await file.text())
                          await saveBlob(
                            new Blob([JSON.stringify(rows, null, 2)], {
                              type: 'application/json',
                            }),
                            outputName(file.name, 'json'),
                          )
                        }
                        return 'Converted to JSON'
                      })
                    }
                  />
                  <Action
                    label="CSV to Excel"
                    onClick={() =>
                      void run('CSV to Excel', async () => {
                        const [{ parseCsv, sniffDelimiter }, { rowsToXlsx }] = await Promise.all([
                          import('@/lib/convert/tabular'),
                          import('@/lib/convert/xlsx'),
                        ])
                        for (const file of csvs) {
                          const text = await file.text()
                          const rows = parseCsv(text, sniffDelimiter(text))
                          await saveBlob(rowsToXlsx(rows, stem(file.name)), outputName(file.name, 'xlsx'))
                        }
                        return 'Converted to Excel'
                      })
                    }
                  />
                  <Action
                    label="CSV to Markdown"
                    onClick={() =>
                      void run('CSV to Markdown', async () => {
                        const { csvToMarkdown } = await import('@/lib/convert/tabular')
                        for (const file of csvs) {
                          await saveBlob(
                            new Blob([csvToMarkdown(await file.text())], {
                              type: 'text/markdown',
                            }),
                            outputName(file.name, 'md'),
                          )
                        }
                        return 'Converted to a Markdown table'
                      })
                    }
                  />
                </>
              )}
              {jsons.length > 0 && (
                <Action
                  label="JSON to CSV"
                  onClick={() =>
                    void run('JSON to CSV', async () => {
                      const { jsonToCsv } = await import('@/lib/convert/tabular')
                      for (const file of jsons) {
                        await saveBlob(
                          new Blob([jsonToCsv(await file.text())], { type: 'text/csv' }),
                          outputName(file.name, 'csv'),
                        )
                      }
                      return 'Converted to CSV'
                    })
                  }
                />
              )}
            </div>
          </Card>
        )}

        {(markdowns.length > 0 || htmls.length > 0 || docxs.length > 0) && (
          <Card className="p-2.5">
            <GroupLabel>Documents</GroupLabel>
            <div className="flex flex-wrap gap-1.5">
              {markdowns.length > 0 && (
                <Action
                  label="Markdown to HTML"
                  onClick={() =>
                    void run('Markdown to HTML', async () => {
                      const { markdownToHtmlDocument } = await import('@/lib/convert/text')
                      for (const file of markdowns) {
                        const html = await markdownToHtmlDocument(
                          await file.text(),
                          stem(file.name),
                        )
                        await saveBlob(
                          new Blob([html], { type: 'text/html' }),
                          outputName(file.name, 'html'),
                        )
                      }
                      return 'Converted to HTML'
                    })
                  }
                />
              )}
              {htmls.length > 0 && (
                <Action
                  label="HTML to Markdown"
                  onClick={() =>
                    void run('HTML to Markdown', async () => {
                      const { htmlToMarkdown } = await import('@/lib/convert/text')
                      for (const file of htmls) {
                        await saveBlob(
                          new Blob([htmlToMarkdown(await file.text())], {
                            type: 'text/markdown',
                          }),
                          outputName(file.name, 'md'),
                        )
                      }
                      return 'Converted to Markdown'
                    })
                  }
                />
              )}
              {docxs.length > 0 && (
                <Action
                  label="DOCX to Markdown"
                  onClick={() =>
                    void run('DOCX to Markdown', async () => {
                      const { convertDocx } = await import('@/lib/convert/docx')
                      let warnings = 0
                      for (const file of docxs) {
                        const result = await convertDocx(await file.arrayBuffer())
                        warnings += result.warnings.length
                        await saveBlob(
                          new Blob([result.markdown], { type: 'text/markdown' }),
                          outputName(file.name, 'md'),
                        )
                      }
                      return warnings
                        ? `Converted, with ${warnings} formatting note${warnings === 1 ? '' : 's'}`
                        : 'Converted to Markdown'
                    })
                  }
                />
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  )
}
