/**
 * Minimal XLSX writer.
 *
 * An .xlsx is a zip of XML parts. Writing the handful this needs by hand keeps
 * the cost to a small zip library, where a full spreadsheet package would add
 * about a megabyte for one conversion.
 *
 * Deliberately limited: one sheet, no styling, no formulas. Enough to open a
 * converted CSV in Excel or Numbers with numbers still behaving as numbers.
 */

import { strToU8, zipSync } from 'fflate'

/** 0 -> A, 25 -> Z, 26 -> AA. */
function columnName(index: number): string {
  let name = ''
  let n = index
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  }
  return name
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Values that are entirely numeric become numeric cells; everything else is an
 * inline string. Inline strings avoid a shared-strings part altogether.
 *
 * Deliberately conservative: a leading zero or a `+` means the value is an
 * identifier rather than a quantity, and turning "007" into 7 loses data.
 */
function cellXml(reference: string, value: string): string {
  const numeric = /^-?(0|[1-9]\d*)(\.\d+)?$/.test(value.trim()) && value.trim() !== ''
  if (numeric) return `<c r="${reference}"><v>${value.trim()}</v></c>`
  if (value === '') return `<c r="${reference}"/>`
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

export function rowsToXlsx(rows: string[][], sheetName = 'Sheet1'): Blob {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row.map((value, column) => cellXml(`${columnName(column)}${rowIndex + 1}`, value))
      return `<row r="${rowIndex + 1}">${cells.join('')}</row>`
    })
    .join('')

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${sheetRows}</sheetData></worksheet>`

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  })

  return new Blob([zipped as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
