import { setTimeout as pause } from "node:timers/promises";
import { normalizePayment, scaleMinorUnits } from "./normalize.mjs";

export const API_VERSION_DATE = "2026-11-16-2";
const PAGE_DELAY_MS = 250;
const MAX_RATE_LIMIT_RETRIES = 3;
const API_BASE = {
  live: "https://api.whop.com/api/v1",
  sandbox: "https://sandbox-api.whop.com/api/v1",
};

/** @param {number} milliseconds */
const wait = (milliseconds) => pause(milliseconds);

export function retryAfterMs(value, now = Date.now()) {
  if (value != null && /^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Math.ceil(Number(value) * 1000);
  const retryAt = Date.parse(value ?? "");
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 60_000;
}

function requestError(status) {
  const code = {
    401: "unauthorized",
    403: "forbidden",
    429: "rate_limited",
  }[status] ?? (status >= 500 ? "provider_unavailable" : "unexpected_response");
  return new Error(`Whop request failed: ${code} (HTTP ${status}).`);
}

export function whopPageReader({ apiKey, sandbox = false, fetchPage = fetch, sleep = wait }) {
  const base = API_BASE[sandbox ? "sandbox" : "live"];
  return async (query) => {
    const url = new URL(`${base}/payments`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchPage(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Api-Version-Date": API_VERSION_DATE,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error("Whop request failed: provider_unavailable.");
      }
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new Error("Whop request failed: unexpected_response.");
        }
      }
      const status = response.status;
      const retryAfter = response.headers.get("Retry-After");
      await response.body?.cancel().catch(() => {});
      if (status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) throw requestError(status);
      await sleep(retryAfterMs(retryAfter));
    }
  };
}

export function scanQuery(account, { from, to }, filter) {
  return {
    account_id: account,
    mode: "account_sales",
    first: 100,
    order: "created_at",
    direction: "desc",
    // Whop documents "after" as strict. Include the exact start millisecond.
    [`${filter}_after`]: new Date(from - 1).toISOString(),
    [`${filter}_before`]: new Date(to).toISOString(),
  };
}

export async function scanPayments(readPage, { account, window, filter = "created", sleep = wait }) {
  const base = scanQuery(account, window, filter);
  const payments = new Map();
  const seenCursors = new Set();
  let cursor;
  let pages = 0;
  let returned = 0;
  let wrongAccount = 0;
  let outsideFilter = 0;
  let duplicates = 0;
  do {
    const page = await readPage(cursor === undefined ? base : { ...base, after: cursor });
    pages++;
    if (!Array.isArray(page?.data) || typeof page?.page_info?.has_next_page !== "boolean") {
      throw new Error("Whop returned an invalid payment page.");
    }
    for (const row of page.data) {
      returned++;
      if (row?.account_id !== account) {
        wrongAccount++;
        continue;
      }
      const payment = normalizePayment(row);
      // For event filters Whop can return a payment with an older event in
      // its summary fields. Count it on the strength of the server filter.
      if (filter === "created" && (payment.createdAt < window.from || payment.createdAt >= window.to)) {
        outsideFilter++;
        continue;
      }
      const previous = payments.get(payment.id);
      if (previous) duplicates++;
      if (!previous || previous.updatedAt <= payment.updatedAt) payments.set(payment.id, payment);
    }
    cursor = page.page_info.has_next_page ? page.page_info.end_cursor : undefined;
    if (page.page_info.has_next_page) {
      if (typeof cursor !== "string" || !cursor || seenCursors.has(cursor)) {
        throw new Error("Whop returned a missing or repeated payment cursor.");
      }
      seenCursors.add(cursor);
      await sleep(PAGE_DELAY_MS);
    }
  } while (cursor !== undefined);
  return { payments, pages, returned, wrongAccount, outsideFilter, duplicates };
}

export async function replayScan(pages, options) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("A fixture scan needs at least one page.");
  let index = 0;
  const result = await scanPayments(() => pages[index++], { ...options, sleep: async () => {} });
  if (index !== pages.length) throw new Error("A fixture scan has pages after its final cursor.");
  return result;
}

function sameTotal(left, right) {
  if (!left || !right) return left === right;
  if (left.currency !== right.currency) return false;
  const scale = Math.max(left.decimals, right.decimals);
  return scaleMinorUnits(left.minor, left.decimals, scale) === scaleMinorUnits(right.minor, right.decimals, scale);
}

export function compareScans(first, second) {
  let firstOnly = 0;
  let secondOnly = 0;
  let amountChanged = 0;
  let statusChanged = 0;
  for (const [id, payment] of first) {
    const next = second.get(id);
    if (!next) {
      firstOnly++;
      continue;
    }
    if (!sameTotal(payment.total, next.total)) amountChanged++;
    if (payment.status !== next.status) statusChanged++;
  }
  for (const id of second.keys()) {
    if (!first.has(id)) secondOnly++;
  }
  return {
    unique: first.size + secondOnly,
    shared: first.size - firstOnly,
    different: firstOnly + secondOnly + amountChanged,
    firstOnly, secondOnly, amountChanged, statusChanged,
  };
}
