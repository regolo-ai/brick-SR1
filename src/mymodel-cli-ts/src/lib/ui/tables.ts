/**
 * Table rendering helpers using cli-table3.
 */

import Table from 'cli-table3'
import {COLORS} from './theme.js'

interface TableOptions {
  head: string[]
  colWidths?: number[]
}

export function createTable(options: TableOptions): Table.Table {
  return new Table({
    head: options.head,
    ...(options.colWidths ? {colWidths: options.colWidths} : {}),
    style: {
      head: ['cyan'],
      border: ['dim'],
    },
  })
}

export function printTable(head: string[], rows: string[][]): void {
  const table = createTable({head})
  for (const row of rows) {
    table.push(row)
  }
  console.log(table.toString())
}

/**
 * Print a simple key-value display (no header row).
 */
export function printKeyValue(pairs: Array<[string, string]>): void {
  const table = new Table({
    style: {head: [], border: ['dim']},
    chars: {
      'top': '', 'top-mid': '', 'top-left': '', 'top-right': '',
      'bottom': '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '',
      'left': '', 'left-mid': '',
      'mid': '', 'mid-mid': '',
      'right': '', 'right-mid': '',
      'middle': '  ',
    },
  })
  for (const [key, value] of pairs) {
    table.push([key, value])
  }
  console.log(table.toString())
}
