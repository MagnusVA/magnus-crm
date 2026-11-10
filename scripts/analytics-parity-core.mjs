const EPSILON = 1e-6;
/** Paths where the two answers differ, at most `limit` of them. */
export function differences(left, right, path = "", out = [], limit = 20) {
  if (out.length >= limit) return out;
  if (typeof left === "number" && typeof right === "number") {
    const leaf = path.split(/[.\[\]]/).filter(Boolean).at(-1) ?? "";
    const derived = /(?:rate|share|percent|average|avg|median|perHour|minutes|hours|duration)/i.test(leaf);
    const exact = Number.isInteger(left) || Number.isInteger(right) || /minor|cents|amount/i.test(path) || !derived;
    const equal = Number.isFinite(left) && Number.isFinite(right) &&
      (exact ? left === right : Math.abs(left - right) <= EPSILON * Math.max(Math.abs(left), Math.abs(right)));
    if (!equal) out.push({ path, convex: left, clickhouse: right });
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push({ path: `${path}.length`, convex: left.length, clickhouse: right.length });
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      differences(left[index], right[index], `${path}[${index}]`, out, limit);
    }
    return out;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      differences(left[key], right[key], path ? `${path}.${key}` : key, out, limit);
    }
    return out;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) out.push({ path, convex: left, clickhouse: right });
  return out;
}

// The form_answers view shows contact answers as this text (clickhouse/
// migrations/0002_views.sql), so Leads' top answers and distributions differ
// there by design. Those differences are reported as masked, not failures;
// every response count must still match.
const MASKED_ANSWER = "Hidden contact detail";

function valueAt(root, path) {
  let value = root;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

/**
 * A field's top answer, its count and its share, when masking changed them:
 * ClickHouse shows the mask and Convex's top answer is something else. A
 * field whose real top answer is the literal mask text is compared in full,
 * so the rule errs toward failing.
 */
export function isMaskedDifference(convex, clickhouse, path) {
  const field = path.match(/^(topAnswerPerField\[\d+\])\.(topAnswer|topAnswerCount|topAnswerShare)$/);
  return (
    field !== null &&
    valueAt(clickhouse, `${field[1]}.topAnswer`) === MASKED_ANSWER &&
    valueAt(convex, `${field[1]}.topAnswer`) !== MASKED_ANSWER
  );
}

/**
 * An answer distribution, compared by answer: every answer ClickHouse shows
 * must have Convex's count, and the answers it hid must add up to its
 * `Hidden contact detail` count. An answer that changed or went missing for
 * another reason still fails.
 */
function distributionDifferences(convex, clickhouse) {
  const out = [];
  const left = new Map((convex?.distribution ?? []).map((entry) => [entry.answer, entry.count]));
  const right = new Map((clickhouse?.distribution ?? []).map((entry) => [entry.answer, entry.count]));
  const maskedCount = right.get(MASKED_ANSWER) ?? 0;
  let hiddenCount = 0;
  let hiddenAnswers = 0;
  for (const [answer, count] of left) {
    // ClickHouse folds a literal answer of the mask text into its bucket.
    if (answer === MASKED_ANSWER || !right.has(answer)) {
      hiddenCount += count;
      hiddenAnswers += 1;
    } else if (right.get(answer) !== count) {
      out.push({ path: `distribution[${JSON.stringify(answer)}]`, convex: count, clickhouse: right.get(answer) });
    }
  }
  for (const [answer, count] of right) {
    if (answer !== MASKED_ANSWER && !left.has(answer)) {
      out.push({ path: `distribution[${JSON.stringify(answer)}]`, convex: undefined, clickhouse: count });
    }
  }
  if (hiddenCount !== maskedCount) {
    out.push({ path: `distribution[${JSON.stringify(MASKED_ANSWER)}]`, convex: hiddenCount, clickhouse: maskedCount });
  }
  const expectedDistinct = (convex?.distinctAnswers ?? left.size) - hiddenAnswers + (maskedCount > 0 ? 1 : 0);
  if (clickhouse?.distinctAnswers !== expectedDistinct) {
    out.push({ path: "distinctAnswers", convex: expectedDistinct, clickhouse: clickhouse?.distinctAnswers });
  }
  return out;
}

/** Flags a Convex reader sets when it read only part of the range. */
const CAPPED_FLAGS = ["partial", "isTruncated", "truncated", "callsPartial", "cohortPartial", "paymentsPartial", "attendanceCountsPartial"];

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !keys.includes(key)));
}

/** Every difference, masked ones excluded; the caller limits what it prints. */
export function reportDifferences(convex, clickhouse) {
  if (Array.isArray(clickhouse?.distribution)) {
    const keys = ["distribution", "distinctAnswers"];
    return [
      ...distributionDifferences(convex, clickhouse),
      ...differences(withoutKeys(convex, keys), withoutKeys(clickhouse, keys), "", [], Number.POSITIVE_INFINITY),
    ];
  }
  return differences(convex, clickhouse, "", [], Number.POSITIVE_INFINITY);
}


/** A cap anywhere in an answer makes it an incomplete reference. */
export function cappedBy(value) {
  if (!value || typeof value !== "object") return null;
  for (const flag of CAPPED_FLAGS) if (value[flag] === true) return flag;
  for (const child of Object.values(value)) {
    const cap = cappedBy(child);
    if (cap) return cap;
  }
  return null;
}

export function coverageKey(item) {
  return JSON.stringify([item.reportId, canonical(item.range), canonical(item.filters ?? {})]);
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}

/** Every required tuple must have exactly one successful comparison. */
export function coverageFailures(required, observed) {
  return required.flatMap(item => {
    const matches = observed.filter(entry => coverageKey(entry) === coverageKey(item));
    return matches.length === 1 && matches[0].status === "ok" ? [] : [
      { ...item, reason: matches.length === 0 ? "missing comparison" : matches.length > 1 ? "duplicate comparison" : matches[0].status },
    ];
  });
}
