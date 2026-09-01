/**
 * CSV and JSON conversion.
 *
 * Hand-written rather than pulled from a library because the whole job is one
 * state machine, and the cases that actually bite - quoted fields containing
 * commas, escaped quotes, newlines inside a field, CRLF line endings - are
 * exactly the ones a naive `split(',')` gets wrong.
 */

export type Row = Record<string, string>

/** Parse RFC 4180 style CSV into rows of raw cells. */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0

  // Strip a UTF-8 BOM, which spreadsheet exports routinely include.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // Ignore the trailing empty row produced by a final newline.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (index < text.length) {
    const char = text[index]!

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"' // an escaped quote
          index += 2
          continue
        }
        quoted = false
        index++
        continue
      }
      field += char
      index++
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
      index++
      continue
    }
    if (char === delimiter) {
      endField()
      index++
      continue
    }
    if (char === '\r') {
      // CRLF or a lone CR both terminate the row.
      if (text[index + 1] === '\n') index++
      endRow()
      index++
      continue
    }
    if (char === '\n') {
      endRow()
      index++
      continue
    }

    field += char
    index++
  }

  if (field !== '' || row.length > 0) endRow()
  return rows
}

/** Quote a cell only when it would otherwise change meaning. */
function escapeCell(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value
}

export function toCsv(rows: string[][], delimiter = ','): string {
  return rows.map((row) => row.map((cell) => escapeCell(cell, delimiter)).join(delimiter)).join('\n')
}

/**
 * Work out which character separates the fields.
 *
 * Extension is a poor guide: `.tsv` files are tab separated, and plenty of
 * files named `.csv` are semicolon separated because that is what spreadsheets
 * export in locales where the comma is the decimal mark. Each candidate is
 * actually parsed and the one producing a consistent, wider table wins, so a
 * comma sitting inside a quoted field cannot cast a vote.
 */
export function sniffDelimiter(input: string): string {
  const sample = input.slice(0, 64 * 1024)
  let best = ','
  let bestScore = 0

  for (const candidate of [',', '\t', ';', '|']) {
    const rows = parseCsv(sample, candidate).slice(0, 20)
    const header = rows[0]
    if (!header || header.length < 2) continue

    // A delimiter that genuinely structures the file gives every row the same
    // column count; one that appears incidentally does not.
    const consistent = rows.every((row) => row.length === header.length)
    const score = header.length * (consistent ? 2 : 1)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** CSV with a header row becomes an array of objects keyed by that header. */
export function csvToJson(input: string, delimiter?: string): Row[] {
  const rows = parseCsv(input, delimiter ?? sniffDelimiter(input))
  const header = rows[0]
  if (!header) return []

  return rows.slice(1).map((row) => {
    const record: Row = {}
    header.forEach((key, column) => {
      // Blank header cells would collide; give them a stable positional name.
      record[key || `column${column + 1}`] = row[column] ?? ''
    })
    return record
  })
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * An array of objects becomes CSV. The header is the union of every object's
 * keys in first-seen order, so rows with missing or extra fields still line up.
 */
export function jsonToCsv(input: string | unknown[], delimiter = ','): string {
  const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input
  const list = Array.isArray(parsed) ? parsed : [parsed]
  if (list.length === 0) return ''

  const header: string[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    for (const key of Object.keys(entry as object)) {
      if (!header.includes(key)) header.push(key)
    }
  }

  // A list of primitives has no keys; emit a single "value" column.
  if (header.length === 0) {
    return toCsv([['value'], ...list.map((entry) => [stringify(entry)])], delimiter)
  }

  const body = list.map((entry) =>
    header.map((key) => stringify((entry as Record<string, unknown>)?.[key])),
  )
  return toCsv([header, ...body], delimiter)
}

/** Render rows as a GitHub-flavoured Markdown table. */
export function csvToMarkdown(input: string, delimiter?: string): string {
  const rows = parseCsv(input, delimiter ?? sniffDelimiter(input))
  const header = rows[0]
  if (!header) return ''

  const escape = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const lines = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => {
      // Pad short rows so the table stays rectangular.
      const cells = header.map((_, column) => escape(row[column] ?? ''))
      return `| ${cells.join(' | ')} |`
    }),
  ]
  return lines.join('\n')
}
