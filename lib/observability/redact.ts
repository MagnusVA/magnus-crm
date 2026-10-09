/**
 * PII scrubbing for everything the ingest forwards to PostHog. Convex code
 * should log ids, not people (see `docs/agents/observability.md`); this is
 * the backstop for older log lines and for error messages that echo input.
 *
 * Every pattern has bounded quantifiers and input is capped, so a long
 * string can't make a regex backtrack for seconds.
 */

const MAX_INPUT = 8_000;

const EMAIL = /[\w.+-]{1,64}(?:@|%40)[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
/** `555-123-4567`, `(555) 123 4567`, `+1 555.123.4567`. Bare digit runs are left alone. */
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;
/** Personal scheduling links carry the person's name: `calendly.com/jane-doe/30min`. */
const CALENDLY_SLUG = /(?<![\w.])calendly\.com\/[\w-]{1,100}/gi;

/** Scrub free-form log text. */
export function redactPii(text: string): string {
  return text
    .slice(0, MAX_INPUT)
    .replace(EMAIL, "<email>")
    .replace(PHONE, "<phone>")
    .replace(CALENDLY_SLUG, "calendly.com/<slug>");
}

/**
 * Convex argument validation errors dump the offending value
 * (`Value: …` / `Object: {…}`), until the `Path:` or `Validator:` line.
 */
const VALIDATOR_DUMP = /(^|\n)(Value|Object): [\s\S]{0,4000}?(?=\n(?:Validator|Path):|$)/g;
/** Error messages quote user input: `Lead "Jane Doe" is lost`, `Invalid link "…"`. */
const QUOTED = /"[^"\n]{1,200}"/g;

/**
 * Scrub an error message or stack. Stricter than `redactPii`: it also drops
 * quoted values and validator dumps, which in error text are usually input.
 */
export function redactErrorText(text: string): string {
  return redactPii(text).replace(VALIDATOR_DUMP, "$1$2: <redacted>").replace(QUOTED, '"<redacted>"');
}
