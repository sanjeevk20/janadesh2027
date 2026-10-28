// Shared helpers for the data build scripts.
import { access } from 'node:fs/promises';

export function normalise(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(RESERVATION_TAG, '')
    .replace(/[^A-Z]/g, '');
}

// Reservation suffixes such as "(SC)" / "(ST)", including ones the boundary source truncated
// ("Sri Hargobindpur (S"). Other bracketed text is part of the name: "Gandhinagar(South)".
export const RESERVATION_TAG = /\s*\((SC|ST)\)|\s*\((S|SC|ST)?$/g;

// Levenshtein-based similarity in [0, 1].
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export function titleCase(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/(^|[\s.(-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

export function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// Minimal RFC 4180 parser: handles quoted fields with commas and escaped quotes.
export function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((v) => v !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]?.trim() ?? ''])));
}

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
