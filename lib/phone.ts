/**
 * A phone number as people read it. A North American number stored as bare
 * digits ("+15005559610", "5005559610") reads "+1 500 555 9610". A number
 * already written with spaces or dashes ("+504 8282-8282") keeps its own
 * grouping, and anything else is shown as stored: without a numbering plan
 * per country, regrouping other numbers would guess wrong.
 */
export function formatPhone(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\+?\d+$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/^\+/, "");
  const national =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.length === 10 && !trimmed.startsWith("+")
        ? digits
        : null;
  if (national === null) return trimmed;
  return `+1 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}
