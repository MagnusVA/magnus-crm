import {
  INCOME_BAND_EDGES,
  type IncomeKind,
} from "../../lib/callInsights/taxonomy";

const words: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900,
};
const thousands = new Set(["k", "grand", "thousand", "mil", "luca", "lucas"]);
function numeric(token: string): number {
  // Three digits after a separator are grouping; the other common forms are decimals.
  const last = Math.max(token.lastIndexOf(","), token.lastIndexOf("."));
  if (last < 0) return Number(token);
  const suffix = token.length - last - 1;
  if (suffix === 3) return Number(token.replace(/[,.]/g, ""));
  return Number(
    token.slice(0, last).replace(/[,.]/g, "") + "." + token.slice(last + 1),
  );
}

/** Recognizes number phrases, keeping separate amounts in a range separate. */
export function parseAmounts(text: string): number[] {
  const normalized = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(
      /\b(\d+(?:[.,]\d+)*)\s*(?:[-–—]|to|a|hasta)\s*(\d+(?:[.,]\d+)*)\s*(k|grand|thousand|mil|lucas)\b/g,
      "$1 $3 to $2 $3",
    );
  const tokens = normalized.match(/\d+(?:[.,]\d+)*|[a-z]+|[^\sa-z\d]/g) ?? [];
  const result: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const start = tokens[i];
    if (
      !/^\d/.test(start) &&
      words[start] === undefined &&
      !thousands.has(start) &&
      start !== "hundred"
    )
      continue;
    let subtotal = 0;
    let total = 0;
    let seen = false;
    let previousWasSmall = false;
    for (; i < tokens.length; i++) {
      const token = tokens[i];
      if (
        (token === "and" || token === "y" || token === "-") &&
        seen &&
        words[tokens[i + 1]] !== undefined
      ) {
        // Hyphens join spelled tens, not the two numeric endpoints of a range.
        if (
          previousWasSmall &&
          subtotal % 10 === 0 &&
          subtotal >= 20 &&
          words[tokens[i + 1]] < 10
        )
          continue;
        if (
          (token === "and" || token === "y") &&
          (subtotal >= 100 || total > 0)
        )
          continue;
        break;
      }
      if (/^\d/.test(token)) {
        if (seen) break;
        subtotal = numeric(token);
        seen = true;
        previousWasSmall = false;
      } else if (words[token] !== undefined) {
        const value = words[token];
        if (
          previousWasSmall &&
          !(subtotal % 10 === 0 && value < 10 && subtotal >= 20)
        )
          break;
        subtotal += value;
        seen = true;
        previousWasSmall = value < 100;
      } else if (token === "hundred") {
        subtotal = (subtotal || 1) * 100;
        seen = true;
        previousWasSmall = false;
      } else if (thousands.has(token)) {
        total += (subtotal || 1) * 1000;
        subtotal = 0;
        seen = true;
        previousWasSmall = false;
      } else break;
    }
    i--;
    const amount = total + subtotal;
    if (seen && Number.isFinite(amount) && amount >= 0) result.push(amount);
  }
  return result;
}

export function incomeBandFor(
  kind: string,
  currency: string | undefined,
  monthlyMinMinor?: number,
  monthlyMaxMinor?: number,
  speakerUncertain?: boolean,
): string | undefined {
  if (speakerUncertain) return "speaker_unclear";
  if (!currency) return "currency_not_stated";
  if (currency !== "USD") return "other_currency";
  if (monthlyMinMinor === undefined) return "no_monthly_equivalent";
  const edges = INCOME_BAND_EDGES[kind as IncomeKind];
  if (!edges) return undefined;
  const band = (minor: number) => edges.findLast((edge) => minor >= edge * 100);
  const min = band(monthlyMinMinor);
  // An absent maximum is an open-ended range, not an exact amount.
  const max =
    monthlyMaxMinor === undefined ? edges.at(-1) : band(monthlyMaxMinor);
  if (min !== max) return "spans_bands";
  return min === undefined ? undefined : `b${min}`;
}
