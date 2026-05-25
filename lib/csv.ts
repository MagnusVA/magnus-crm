const FORMULA_PREFIX_PATTERN = /^[=+\-@\t\r]/;
const CSV_ESCAPE_PATTERN = /[",\r\n]/;

function hardenFormulaCell(value: string) {
  if (FORMULA_PREFIX_PATTERN.test(value)) {
    return `'${value}`;
  }

  const trimmedStart = value.trimStart();
  if (FORMULA_PREFIX_PATTERN.test(trimmedStart)) {
    return `'${value}`;
  }
  return value;
}

export function serializeCsvCell(value: unknown) {
  const raw = value == null ? "" : String(value);
  const hardened = hardenFormulaCell(raw);

  if (CSV_ESCAPE_PATTERN.test(hardened)) {
    return `"${hardened.replace(/"/g, '""')}"`;
  }

  return hardened;
}

export function serializeCsv(rows: unknown[][]) {
  return rows.map((row) => row.map(serializeCsvCell).join(",")).join("\r\n");
}
