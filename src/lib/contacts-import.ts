/**
 * Dependency-free CSV parsing + E.164 normalization + row validation for
 * the contact-upload flow. No XLSX/Excel support is implemented — adding a
 * binary spreadsheet parser was judged out of scope for this pass; CSV is
 * the primary supported format the product spec itself calls out.
 *
 * Pure functions only (no I/O, no Supabase) so they can run identically in
 * a server function and in tests without mocking anything.
 */

/** RFC4180-ish CSV parser: handles quoted fields, escaped quotes ("" ), and
 * commas/newlines inside quotes. Does not support alternate delimiters. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalize line endings up front so \r\n inside/outside quotes behaves the same.
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush the last field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing rows (common with a trailing newline).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface ParsedCsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/** Parses CSV text into headers + row objects keyed by header. Blank/duplicate headers are dropped/renamed defensively. */
export function csvToTable(text: string): ParsedCsvTable {
  const raw = parseCsv(text);
  if (raw.length === 0) return { headers: [], rows: [] };
  const seen = new Map<string, number>();
  const headers = raw[0]!.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
  const rows = raw.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows };
}

/**
 * Normalizes a phone number to E.164. Bare 10-digit numbers are assumed
 * Indian (matching the rest of this codebase's IN-first defaults —
 * organizations.country/currency both default to India) and get +91
 * prepended; anything already starting with + is only whitespace/punctuation
 * -stripped and validated, never re-interpreted. Returns null when the
 * result isn't a plausible E.164 number (6-15 digits after the +).
 */
export function normalizeToE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (hasPlus) {
    const candidate = `+${digits}`;
    return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
  }
  if (digits.length === 10) {
    const candidate = `+91${digits}`;
    return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    const candidate = `+91${digits.slice(1)}`;
    return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
  }
  if (digits.length === 12 && digits.startsWith("91")) {
    const candidate = `+${digits}`;
    return /^\+[1-9]\d{6,14}$/.test(candidate) ? candidate : null;
  }
  // Any other bare-digit shape is ambiguous (unknown country) — do not guess.
  return null;
}

export interface ContactImportRow {
  rowIndex: number;
  phoneRaw: string;
  phone: string | null;
  fields: Record<string, string>;
}

export interface ContactImportSummary {
  totalRows: number;
  valid: ContactImportRow[];
  invalid: { rowIndex: number; phoneRaw: string; reason: string }[];
  duplicates: { rowIndex: number; phone: string }[];
}

/**
 * Validates + normalizes every row of a parsed CSV table against a chosen
 * phone column, deduping by normalized phone within the file itself. Does
 * NOT check against existing contacts in the database — that's the caller's
 * job (an upsert on the (organization_id, phone) unique constraint), kept
 * separate so this function stays pure and independently testable.
 */
export function validateContactRows(
  table: ParsedCsvTable,
  phoneColumn: string,
): ContactImportSummary {
  const valid: ContactImportRow[] = [];
  const invalid: ContactImportSummary["invalid"] = [];
  const duplicates: ContactImportSummary["duplicates"] = [];
  const seenPhones = new Set<string>();

  table.rows.forEach((row, i) => {
    const rowIndex = i + 1; // 1-based, matches "row 1 of the data" as a customer would count it
    const phoneRaw = row[phoneColumn] ?? "";
    if (!phoneRaw) {
      invalid.push({ rowIndex, phoneRaw, reason: "Missing phone number" });
      return;
    }
    const phone = normalizeToE164(phoneRaw);
    if (!phone) {
      invalid.push({ rowIndex, phoneRaw, reason: "Invalid or unrecognized phone number" });
      return;
    }
    if (seenPhones.has(phone)) {
      duplicates.push({ rowIndex, phone });
      return;
    }
    seenPhones.add(phone);
    valid.push({ rowIndex, phoneRaw, phone, fields: row });
  });

  return { totalRows: table.rows.length, valid, invalid, duplicates };
}

/** Applies a {csvColumn: variableName} mapping to one row's fields, producing the agent-variable object for that contact. */
export function applyVariableMapping(
  fields: Record<string, string>,
  mapping: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, variableName] of Object.entries(mapping)) {
    if (!variableName) continue;
    const value = fields[column];
    if (value !== undefined && value !== "") out[variableName] = value;
  }
  return out;
}
