// Excel export. One row per finding, built with SheetJS.
//
// Money goes into the sheet as real numbers with a currency format, never as text,
// so analysts can sort, filter and add formulas. Amounts are parsed to integer cents
// first (lib/money.ts); the only step after that is the divide by 100 that a number
// cell needs. Text from uploaded documents is written as plain string cells, so a
// quote that starts with "=" is shown as text and never run as a formula.

import type { CellObject, WorkSheet } from "xlsx"

import { DECISION_LABEL } from "./findings"
import { toCents } from "./money"
import type { Finding } from "./types"

const MONEY_FORMAT = '"$"#,##0.00;-"$"#,##0.00'
const PERCENT_FORMAT = "0.00%"
const PROBABILITY_FORMAT = "0%"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** Excel stops at 32,767 characters in one cell. */
const MAX_CELL_TEXT = 32767

interface Column {
  header: string
  /** Width in characters. */
  width: number
  cell: (finding: Finding) => CellObject | undefined
}

const COLUMNS: Column[] = [
  { header: "Claim", width: 48, cell: (f) => text(f.claim) },
  { header: "Decision", width: 16, cell: (f) => text(DECISION_LABEL[f.decision]) },
  { header: "Claimed", width: 18, cell: (f) => money(f.claimed_usd) },
  { header: "Proof", width: 18, cell: (f) => money(f.proof_usd) },
  { header: "Gap", width: 18, cell: (f) => money(f.gap_usd) },
  { header: "Gap %", width: 10, cell: (f) => percent(f.gap_pct) },
  { header: "Jev probability", width: 16, cell: (f) => probability(f.jev_probability) },
  { header: "Claim quote", width: 56, cell: (f) => text(f.claim_source.quote) },
  { header: "Proof quote", width: 56, cell: (f) => text(f.proof_source?.quote) },
  { header: "Next action", width: 56, cell: (f) => text(f.next_action) },
  // Not in the brief's column list: a mocked finding must not leave the app looking real.
  { header: "Mocked", width: 10, cell: (f) => (f.mocked ? text("Yes") : undefined) },
]

function text(value: string | null | undefined): CellObject | undefined {
  if (value === null || value === undefined || value === "") return undefined
  // Drop control characters that are not allowed in an .xlsx file.
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  return { t: "s", v: clean.slice(0, MAX_CELL_TEXT) }
}

function money(value: string | null): CellObject | undefined {
  const cents = toCents(value)
  if (cents === null) return undefined
  return { t: "n", v: cents / 100, z: MONEY_FORMAT }
}

function percent(value: string | null): CellObject | undefined {
  // "14.58" is 1458 hundredths of a percent, which is the fraction 0.1458.
  const hundredths = toCents(value)
  if (hundredths === null) return undefined
  return { t: "n", v: hundredths / 10000, z: PERCENT_FORMAT }
}

function probability(value: number | null): CellObject | undefined {
  if (value === null || Number.isNaN(value)) return undefined
  return { t: "n", v: Math.min(Math.max(value, 0), 1), z: PROBABILITY_FORMAT }
}

/** diligo-<deal>-<date>.xlsx, with the deal name made safe for a file name. */
export function exportFileName(dealName: string, date: Date): string {
  const slug =
    dealName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "deal"
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `diligo-${slug}-${day}.xlsx`
}

/** Builds the workbook, saves it through the browser and returns the file name. */
export async function exportFindingsToExcel(
  findings: Finding[],
  dealName: string,
  now: Date = new Date()
): Promise<string> {
  // Loaded on demand, so the spreadsheet library stays out of the main bundle.
  const XLSX = await import("xlsx")

  const sheet: WorkSheet = {}
  COLUMNS.forEach((column, c) => {
    sheet[XLSX.utils.encode_cell({ r: 0, c })] = { t: "s", v: column.header }
  })
  findings.forEach((finding, i) => {
    COLUMNS.forEach((column, c) => {
      const cell = column.cell(finding)
      if (cell) sheet[XLSX.utils.encode_cell({ r: i + 1, c })] = cell
    })
  })

  const range = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: findings.length, c: COLUMNS.length - 1 },
  })
  sheet["!ref"] = range
  sheet["!autofilter"] = { ref: range }
  sheet["!cols"] = COLUMNS.map((column) => ({ wch: column.width }))

  const workbook = XLSX.utils.book_new()
  workbook.Props = { Title: `Diligo.ai findings: ${dealName}`, CreatedDate: now }
  XLSX.utils.book_append_sheet(workbook, sheet, "Findings")

  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true })
  const fileName = exportFileName(dealName, now)
  download(new Blob([bytes], { type: XLSX_MIME }), fileName)
  return fileName
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
