// CSV in and out: reading people lists saved from Excel or Dexterity Sheets, and writing
// reports (attendance, exports) that open cleanly in either.
import type { ImportRow } from './protocol.ts';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const HEADERS: Array<[keyof ImportRow, RegExp]> = [
  ['account', /^(windows )?(account|user ?name|login|user id)$/],
  ['displayName', /^(display )?name$|^full name$/],
  ['title', /^(title|designation|job title|role)$/],
  ['department', /^(department|dept|team)$/],
  ['manager', /^(manager|reports to|reporting to|reporting manager)$/],
  ['phone', /^(phone|mobile|cell)( number)?$/],
  ['extension', /^(ext|extension|ext\.?)$/],
  ['location', /^(location|seat|desk|office)$/],
  ['email', /^e-?mail( address)?$/],
  ['employeeId', /^(emp(loyee)? ?(id|no|number|code))$/],
  ['joinedOn', /^(joined( on)?|joining date|date of joining|doj|start date)$/],
  ['birthday', /^(birthday|date of birth|dob)$/],
];

/** Turn a sheet into import rows; unknown columns become custom fields with the same label. */
export function rowsFromSheet(table: string[][]): { rows: ImportRow[]; columns: Array<{ header: string; maps: string }> } {
  const [head, ...body] = table;
  if (!head) return { rows: [], columns: [] };
  const map = head.map((h) => {
    const key = h.toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
    return HEADERS.find(([, re]) => re.test(key))?.[0] ?? null;
  });
  const rows = body.map((cells) => {
    const r: ImportRow = { account: '' };
    cells.forEach((cell, i) => {
      const v = cell.trim();
      if (!v) return;
      const k = map[i];
      if (k === 'fields') return;
      if (k) (r as unknown as Record<string, string>)[k] = normaliseDate(k, v);
      else if (head[i]?.trim()) (r.fields ??= {})[head[i].trim()] = v;
    });
    return r;
  });
  return { rows, columns: head.map((h, i) => ({ header: h, maps: map[i] ?? 'custom field' })) };
}

/** Spreadsheets often write dates as 30/06/2024 or 30-Jun-2024; the hub wants 2024-06-30. */
function normaliseDate(k: keyof ImportRow, v: string): string {
  if (k !== 'joinedOn' && k !== 'birthday') return v;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let m = v.match(/^(\d{1,2})[/\-. ](\d{1,2}|[a-z]{3})[a-z]*[/\-. ](\d{2,4})$/i);
  if (m) {
    const mm = /^\d+$/.test(m[2]) ? Number(m[2]) : months.indexOf(m[2].toLowerCase().slice(0, 3)) + 1;
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return k === 'birthday' ? `${String(mm).padStart(2, '0')}-${m[1].padStart(2, '0')}` : `${yyyy}-${String(mm).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m && k === 'birthday') return `${m[2]}-${m[3]}`;
  return v;
}


/** One CSV line per row; quotes only where needed. Starts with a BOM so Excel reads UTF-8. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    // a leading = + - @ would run as a formula in a spreadsheet
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\r\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
