/**
 * Booking setup's reading of Calendly event types: which ones are look-alikes
 * of each other, where an unsorted one probably belongs, and which look-alike
 * copies nobody uses. Pure functions over plain rows, so the Inbox and the
 * Event types tab share one answer and it can be unit tested.
 */

export type IntelMode = "normal" | "extended";

export type IntelStatus = "unsorted" | "sorted" | "not_sales_call" | "gone";

export type IntelEventType = {
  id: string;
  name: string;
  /** Calendly's own name when it differs from `name`. */
  calendlyName?: string;
  durationMinutes?: number;
  /** Calendly's pooling type: round_robin, collective, multi_pool, or none (one host). */
  poolingType?: string;
  /** Calendly's kind: "solo" or "group". */
  kind?: string;
  formQuestionCount?: number;
  status: IntelStatus;
  programId?: string;
  mode: IntelMode;
  bookings30d: number;
  /** Whether a coverage cell points at it. */
  inUse?: boolean;
  /** Who owns it in Calendly, when known (a person's or a team's name). */
  ownerName?: string;
  color?: string;
};

export type IntelProgram = { id: string; name: string };

export type NotSalesReason = "personal" | "follow_up" | "internal" | "group" | "duplicate";

export const NOT_SALES_REASONS: ReadonlyArray<{ key: NotSalesReason; label: string; hint: string }> = [
  { key: "personal", label: "Personal calendar", hint: "One host, not a closer pool" },
  { key: "follow_up", label: "Follow-up call", hint: "Books people who already had a call" },
  { key: "internal", label: "Internal meeting", hint: "Team, interviews, tests" },
  { key: "group", label: "Group event or webinar", hint: "Seats, not a sales call" },
  { key: "duplicate", label: "Duplicate", hint: "A copy of another event type" },
];

export const NOT_SALES_REASON_LABEL: Record<NotSalesReason, string> = Object.fromEntries(
  NOT_SALES_REASONS.map((reason) => [reason.key, reason.label]),
) as Record<NotSalesReason, string>;

export type Strength = "strong" | "likely" | "possible";

export type Destination =
  | { kind: "program"; programId: string; mode: IntelMode }
  | { kind: "not_sales_call"; reason: NotSalesReason; duplicateOfId?: string };

export type Suggestion = Destination & {
  strength: Strength;
  /** Plain sentences, strongest first. */
  reasons: string[];
};

export type SuggestionResult = {
  /** Null when nothing points anywhere. */
  best: Suggestion | null;
  /** Up to two other one-key choices. */
  alternatives: Destination[];
  /** Filed event types this one looks like, closest first. */
  lookalikes: IntelEventType[];
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;

// The brand Calendly names carry ("with PT-Dom", "W/ PT-Domination").
const BRAND = /\bpt[\s-]*dom(?:ination)?\b/gi;
const HAS_BRAND = /\bpt[\s-]*dom(?:ination)?\b/i;

const MODE_WORDS = /\b(extended|standard|ext)\b/i;

const STOP_WORDS = new Set(["the", "a", "an", "with", "w", "and", "your", "you", "for", "of", "to", "my", "our", "on", "in"]);

/** Lowercase words without emoji, accents or punctuation. */
export function normalizeWords(value: string) {
  return value
    .replace(EMOJI, " ")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/w\//g, "with ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A name without the parts look-alikes differ by: emoji, case, punctuation,
 * "Copy of", "(old)", the brand ("with PT-Dom", "W/ PT-Domination"),
 * "Extended"/"Standard", lengths ("30 min") and a leading "The".
 */
export function familyKey(name: string) {
  let words = normalizeWords(name.replace(BRAND, " "));
  words = words
    .replace(/^copy of /, "")
    .replace(/\b(copy|old|new|v\d+|duplicate)\b/g, " ")
    .replace(/\b(extended|standard|ext)\b/g, " ")
    .replace(/\b\d+\s*(min|mins|minute|minutes|m)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/ (with|w)$/, "")
    .trim();
  return words;
}

/** Same clean-up as `familyKey`, keeping the original case: the look-alike group's name. */
export function familyLabel(name: string) {
  const cleaned = name
    .replace(EMOJI, " ")
    .replace(/\bcopy of\b/gi, " ")
    .replace(/\((?:old|copy)\)/gi, " ")
    .replace(/\s+(?:with|w\/)\s*pt[\s-]*dom(?:ination)?\b\.?/gi, " ")
    .replace(BRAND, " ")
    .replace(/\b(extended|standard)\b/gi, " ")
    .replace(/[\s.\-–—:|]+$/g, "")
    .replace(/^\s*the\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || name.trim();
}

function tokens(value: string) {
  return familyKey(value)
    .split(" ")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** 0–1: how alike two event type names are once the noise is gone. */
export function nameSimilarity(left: string, right: string) {
  const a = familyKey(left);
  const b = familyKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = [...new Set(tokens(left))];
  const tb = [...new Set(tokens(right))];
  if (ta.length === 0 || tb.length === 0) return 0;
  // Words match exactly, or as a truncation ("Meet" for "Meeting").
  const unused = new Set(tb);
  let shared = 0;
  for (const word of ta) {
    const match = [...unused].find((other) => sameWord(word, other));
    if (match !== undefined) {
      unused.delete(match);
      shared += 1;
    }
  }
  return shared / (ta.length + tb.length - shared);
}

function sameWord(left: string, right: string) {
  if (left === right) return true;
  return Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left));
}

const LOOKALIKE_THRESHOLD = 0.75;

export function areLookalikes(left: Pick<IntelEventType, "name">, right: Pick<IntelEventType, "name">) {
  return nameSimilarity(left.name, right.name) >= LOOKALIKE_THRESHOLD && tokens(left.name).length >= 2;
}

/** "Copy of …", "… (copy)", "… (old)": a name that says it is a copy. */
export function looksLikeCopy(name: string) {
  return /^\s*copy of\b/i.test(name) || /\((?:copy|old)\)\s*$/i.test(name) || /\bcopy\s*$/i.test(name);
}

function bareName(name: string) {
  return normalizeWords(name.replace(/^\s*copy of\s+/i, "").replace(/\((?:copy|old)\)\s*$|\bcopy\s*$/i, ""));
}

/** Same name once "Copy of", emoji, case and punctuation are gone. */
function sameBareName(left: string, right: string) {
  return bareName(left) === bareName(right);
}

/** "Extended" or "Standard" in the name: the event type's own word for Standard. */
export function nameSaysStandard(name: string) {
  return MODE_WORDS.test(name);
}

const NAME_STOP = new Set(
  [
    "strategy", "discovery", "intro", "introduction", "team", "sales", "call", "meeting", "the", "kick", "complete",
    "content", "program", "programme", "session", "consultation", "demo", "free", "vip", "test", "group", "closer",
    "follow", "onboarding", "interview", "personal", "quick", "new", "copy", "launchpad", "giveaway", "giveaways",
    "high", "next", "pt", "masterclass", "coaching", "booking", "book", "application", "apply", "qualification",
  ].map((word) => word.toLowerCase()),
);

/** "Claudio — 15 min", "Jorge's Personal Calendar", "Meet with Ana": named after a person. */
export function personInName(name: string, ownerName?: string): string | null {
  const clean = name.replace(EMOJI, "").trim();
  const possessive = clean.match(/^(\p{Lu}\p{Ll}+)(?:’|')s\b/u);
  if (possessive && !NAME_STOP.has(possessive[1].toLowerCase())) return possessive[1];
  const lead = clean.match(/^(\p{Lu}\p{Ll}+)(?:\s+\p{Lu}\p{Ll}+)?\s*[-–—:|]\s*/u);
  if (lead && !NAME_STOP.has(lead[1].toLowerCase())) return lead[1];
  const withName = clean.match(/\b(?:with|w\/)\s+(\p{Lu}\p{Ll}+)\s*$/u);
  if (withName && !NAME_STOP.has(withName[1].toLowerCase()) && !HAS_BRAND.test(withName[0])) return withName[1];
  if (ownerName) {
    const first = ownerName.trim().split(/\s+/)[0];
    if (first && first.length > 2 && new RegExp(`\\b${escapeRegExp(first)}\\b`, "i").test(clean)) return first;
  }
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const GENERIC_PERSONAL = /^(?:\d+\s*(?:min|mins|minute|minutes)(?:\s+(?:meeting|call|chat))?|quick (?:call|chat)|chat|coffee(?: chat)?)$/i;

const POOLED = new Set(["round_robin", "collective", "multi_pool"]);

export function isPooled(eventType: Pick<IntelEventType, "poolingType">) {
  return eventType.poolingType !== undefined && POOLED.has(eventType.poolingType);
}

// ---------------------------------------------------------------------------
// Look-alike groups
// ---------------------------------------------------------------------------

export type LookalikeMember = {
  eventType: IntelEventType;
  /** The in-use twin an unused copy should fold into, when there is one. */
  foldInto: IntelEventType | null;
};

export type LookalikeGroup = {
  key: string;
  label: string;
  members: LookalikeMember[];
  /** Members with a `foldInto`. */
  foldable: LookalikeMember[];
  programIds: string[];
};

/**
 * Event types grouped by look-alike names, two or more per group, biggest
 * first. Not-a-sales-call and gone event types stay in their group so the
 * group reads complete, but are never suggested for folding.
 */
export function lookalikeGroups(eventTypes: readonly IntelEventType[]): LookalikeGroup[] {
  const list = eventTypes.filter((eventType) => familyKey(eventType.name).length > 0);
  const parent = list.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (areLookalikes(list[i], list[j])) parent[find(i)] = find(j);
    }
  }
  const byRoot = new Map<number, IntelEventType[]>();
  list.forEach((eventType, index) => {
    const root = find(index);
    const members = byRoot.get(root) ?? [];
    members.push(eventType);
    byRoot.set(root, members);
  });

  const groups: LookalikeGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(
      (left, right) =>
        Number(right.inUse ?? false) - Number(left.inUse ?? false) ||
        right.bookings30d - left.bookings30d ||
        left.name.localeCompare(right.name),
    );
    const used = ordered.filter((eventType) => eventType.inUse);
    const withFold = ordered.map<LookalikeMember>((eventType) => {
      // Filed copies nobody routes to, or unsorted ones named as copies. A
      // new unsorted look-alike is a new pool until someone says otherwise.
      const canFold =
        !eventType.inUse &&
        eventType.bookings30d <= 2 &&
        (eventType.status === "sorted" || (eventType.status === "unsorted" && looksLikeCopy(eventType.name))) &&
        used.length > 0;
      if (!canFold) return { eventType, foldInto: null };
      const twin =
        [...used]
          .filter((candidate) => candidate.mode === eventType.mode)
          .sort(
            (left, right) =>
              Number(sameBareName(eventType.name, right.name)) - Number(sameBareName(eventType.name, left.name)) ||
              nameSimilarity(eventType.name, right.name) - nameSimilarity(eventType.name, left.name) ||
              right.bookings30d - left.bookings30d,
          )[0] ??
        used[0];
      return { eventType, foldInto: twin };
    });
    groups.push({
      key: familyKey(ordered[0].name),
      label: mostCommonLabel(ordered),
      members: withFold,
      foldable: withFold.filter((member) => member.foldInto !== null),
      programIds: [...new Set(ordered.flatMap((eventType) => (eventType.status === "sorted" && eventType.programId ? [eventType.programId] : [])))],
    });
  }
  return groups.sort(
    (left, right) =>
      right.foldable.length - left.foldable.length ||
      right.members.length - left.members.length ||
      left.label.localeCompare(right.label),
  );
}

function mostCommonLabel(members: readonly IntelEventType[]) {
  const counts = new Map<string, number>();
  for (const member of members) {
    const label = familyLabel(member.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)[0][0];
}

/** For each event type in a look-alike group, the group's name ("Look-alike of …"). */
export function lookalikeIndex(groups: readonly LookalikeGroup[]) {
  const index = new Map<string, LookalikeGroup>();
  for (const group of groups) for (const member of group.members) index.set(member.eventType.id, group);
  return index;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

type ProgramScore = {
  program: IntelProgram;
  score: number;
  reasons: string[];
  mode: IntelMode;
  modeReason: string | null;
  lookalikes: IntelEventType[];
};

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (count: number) => NUMBER_WORDS[count] ?? String(count);
const plural = (count: number, one: string, many = `${one}s`) => `${countWord(count)} ${count === 1 ? one : many}`;

function lengthAndPooling(eventType: IntelEventType) {
  const pooling = poolingWords(eventType.poolingType);
  return eventType.durationMinutes !== undefined ? `${eventType.durationMinutes}-minute ${pooling}` : pooling;
}

function poolingWords(poolingType: string | undefined) {
  if (poolingType === "round_robin") return "round robin";
  if (poolingType === "collective") return "collective event";
  if (poolingType === "multi_pool") return "multi-pool round robin";
  return "one-host event";
}

function scoreProgram(
  target: IntelEventType,
  program: IntelProgram,
  filed: readonly IntelEventType[],
): ProgramScore {
  const reasons: string[] = [];
  let score = 0;
  const name = ` ${normalizeWords(`${target.name} ${target.calendlyName ?? ""}`)} `;
  const programWords = normalizeWords(program.name).split(" ").filter(Boolean);

  // (a) The program's name in the event type's name.
  if (programWords.length > 0 && name.includes(` ${programWords.join(" ")} `)) {
    score += 3;
    reasons.push(`Name says “${program.name}”.`);
  } else {
    const significant = programWords.filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
    const hits = significant.filter((word) => name.includes(` ${word} `));
    if (significant.length > 0 && hits.length > 0) {
      score += 1.5 * (hits.length / significant.length);
      reasons.push(`Name shares “${hits.join(" ")}” with ${program.name}.`);
    }
  }

  // (b) Look-alikes already filed on the program.
  const onProgram = filed.filter((eventType) => eventType.programId === program.id);
  const scored = onProgram
    .map((eventType) => ({ eventType, similarity: nameSimilarity(target.name, eventType.name) }))
    .sort((left, right) => right.similarity - left.similarity || right.eventType.bookings30d - left.eventType.bookings30d);
  const lookalikes = scored.filter((entry) => entry.similarity >= LOOKALIKE_THRESHOLD).map((entry) => entry.eventType);
  if (lookalikes.length > 0) {
    score += 3 + Math.min(lookalikes.length - 1, 3) * 0.5;
    reasons.push(
      lookalikes.length === 1
        ? `Looks like “${lookalikes[0].name}”, already on ${program.name}.`
        : `Name matches ${plural(lookalikes.length, "event type")} already on ${program.name}.`,
    );
  } else if (scored[0] && scored[0].similarity >= 0.6) {
    score += 1;
    reasons.push(`Close to “${scored[0].eventType.name}” on ${program.name}.`);
  }

  // (c) Same length and pooling as the closest one there.
  const twins = (lookalikes.length > 0 ? lookalikes : onProgram).filter(
    (eventType) =>
      eventType.durationMinutes !== undefined &&
      eventType.durationMinutes === target.durationMinutes &&
      (eventType.poolingType ?? "none") === (target.poolingType ?? "none"),
  );
  if (twins.length > 0 && score > 0) {
    score += 1;
    const formNote =
      target.formQuestionCount && twins[0].formQuestionCount === target.formQuestionCount
        ? ` with ${plural(target.formQuestionCount, "form question")}`
        : "";
    reasons.push(`${capitalize(lengthAndPooling(target))}${formNote}, like “${twins[0].name}”.`);
  }

  // (d) The mode: the name's own word first, then its closest look-alike.
  let mode: IntelMode = "normal";
  let modeReason: string | null = null;
  const standardWord = target.name.match(MODE_WORDS)?.[1];
  if (standardWord) {
    mode = "extended";
    modeReason = `Name says “${capitalize(standardWord.toLowerCase())}”, so Standard.`;
  } else {
    const plainTwin = lookalikes.find((eventType) => !nameSaysStandard(eventType.name));
    if (plainTwin && plainTwin.mode === "extended") {
      mode = "extended";
      modeReason = `Its look-alike “${plainTwin.name}” is Standard.`;
    } else if (lookalikes.length > 0) {
      modeReason = "No “Extended” in the name, so Priority.";
    }
  }

  return { program, score, reasons, mode, modeReason, lookalikes };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

type NotSalesSignal = { reason: NotSalesReason; score: number; reasons: string[]; duplicateOfId?: string };

function notSalesSignals(target: IntelEventType, others: readonly IntelEventType[]): NotSalesSignal[] {
  const words = normalizeWords(target.name);
  const signals: NotSalesSignal[] = [];

  if (looksLikeCopy(target.name)) {
    // The original carries the copy's exact name, give or take emoji and case.
    const sameName = (eventType: IntelEventType) => sameBareName(target.name, eventType.name);
    const original = others
      .filter((eventType) => eventType.id !== target.id && !looksLikeCopy(eventType.name))
      .map((eventType) => ({ eventType, similarity: nameSimilarity(target.name, eventType.name) }))
      .filter((entry) => entry.similarity >= LOOKALIKE_THRESHOLD)
      .sort(
        (left, right) =>
          Number(sameName(right.eventType)) - Number(sameName(left.eventType)) ||
          Number(right.eventType.status === "sorted") - Number(left.eventType.status === "sorted") ||
          right.similarity - left.similarity ||
          right.eventType.bookings30d - left.eventType.bookings30d,
      )[0]?.eventType;
    signals.push({
      reason: "duplicate",
      score: original ? 8 : 3.5,
      reasons: original
        ? [`“Copy of” in the name: a copy of “${original.name}”.`, ...(target.bookings30d === 0 ? ["No bookings in the last 30 days."] : [])]
        : ["The name says it’s a copy."],
      duplicateOfId: original?.id,
    });
  }

  if (/\bfollow ?up\b|\bcheck ?in\b|\bsecond call\b|\b2nd call\b|\bonboarding\b|\bnext steps?\b/.test(words)) {
    signals.push({ reason: "follow_up", score: 4, reasons: ["The name reads like a follow-up, not a first sales call."] });
  }

  if (/\binterview\b|\binternal\b|\bhuddle\b|\bstandup\b|\bstand up\b|\b1 1\b|\bone on one\b|\btraining\b|\btest\b/.test(words)) {
    signals.push({ reason: "internal", score: 3.5, reasons: ["The name reads like an internal meeting."] });
  }

  if (target.kind === "group" || /\bgroup\b|\bwebinar\b|\bq a\b|\bq and a\b|\bworkshop\b|\bclass\b/.test(words)) {
    signals.push({
      reason: "group",
      score: target.kind === "group" ? 5 : 3.5,
      reasons: [target.kind === "group" ? "A group event in Calendly: seats, not a one-to-one call." : "The name reads like a group event."],
    });
  }

  const personal: string[] = [];
  let personalScore = 0;
  if (!isPooled(target)) {
    personalScore += 2;
    personal.push("One host, not a round robin.");
  }
  const person = personInName(target.name, target.ownerName);
  if (person) {
    personalScore += 3;
    personal.push(`Named after a person (“${person}”).`);
  }
  if (GENERIC_PERSONAL.test(words) || /\bpersonal\b/.test(words)) {
    personalScore += 2;
    personal.push(/\bpersonal\b/.test(words) ? "The name says “personal”." : "A generic Calendly name, like a personal calendar’s.");
  }
  if (personalScore > 0) signals.push({ reason: "personal", score: personalScore, reasons: personal });

  return signals.sort((left, right) => right.score - left.score);
}

function strengthOf(score: number): Strength {
  if (score >= 5) return "strong";
  if (score >= 3) return "likely";
  return "possible";
}

function sameDestination(left: Destination, right: Destination) {
  if (left.kind === "program" && right.kind === "program") return left.programId === right.programId && left.mode === right.mode;
  if (left.kind === "not_sales_call" && right.kind === "not_sales_call") return left.reason === right.reason;
  return false;
}

/**
 * Where an unsorted event type probably belongs, and why. `all` is every event
 * type the tenant has (filed ones teach the look-alikes).
 */
export function suggestDestination(
  target: IntelEventType,
  programs: readonly IntelProgram[],
  all: readonly IntelEventType[],
): SuggestionResult {
  const filed = all.filter((eventType) => eventType.id !== target.id && eventType.status === "sorted" && eventType.programId);
  const scores = programs
    .map((program) => scoreProgram(target, program, filed))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const top = scores[0];
  const signals = notSalesSignals(target, all);
  const topSignal = signals[0];

  const lookalikes = top?.lookalikes ?? [];
  let best: Suggestion | null = null;
  // A strong not-a-sales-call signal wins unless the program evidence is stronger.
  const programWins = top && (!topSignal || top.score + (isPooled(target) ? 1 : 0) >= topSignal.score);
  if (top && programWins) {
    const reasons = [...top.reasons];
    if (top.modeReason) reasons.push(top.modeReason);
    best = {
      kind: "program",
      programId: top.program.id,
      mode: top.mode,
      strength: strengthOf(top.score),
      reasons: reasons.slice(0, 4),
    };
  } else if (topSignal) {
    best = {
      kind: "not_sales_call",
      reason: topSignal.reason,
      duplicateOfId: topSignal.duplicateOfId,
      strength: strengthOf(topSignal.score),
      reasons: [...topSignal.reasons, ...(top ? [] : programs.length > 0 ? ["No program’s name matches it."] : [])].slice(0, 4),
    };
  }

  const alternatives: Destination[] = [];
  const pushAlternative = (destination: Destination) => {
    if (alternatives.length >= 2) return;
    if (best && sameDestination(best, destination)) return;
    if (alternatives.some((existing) => sameDestination(existing, destination))) return;
    alternatives.push(destination);
  };
  if (best?.kind === "program") {
    pushAlternative({ kind: "program", programId: best.programId, mode: best.mode === "normal" ? "extended" : "normal" });
    if (topSignal && topSignal.score >= 3) {
      pushAlternative({ kind: "not_sales_call", reason: topSignal.reason, duplicateOfId: topSignal.duplicateOfId });
    }
    if (scores[1]) pushAlternative({ kind: "program", programId: scores[1].program.id, mode: scores[1].mode });
  } else {
    if (top) pushAlternative({ kind: "program", programId: top.program.id, mode: top.mode });
    if (signals[1]) pushAlternative({ kind: "not_sales_call", reason: signals[1].reason, duplicateOfId: signals[1].duplicateOfId });
    if (scores[1]) pushAlternative({ kind: "program", programId: scores[1].program.id, mode: scores[1].mode });
  }

  return { best, alternatives, lookalikes };
}

// ---------------------------------------------------------------------------
// Inbox cards: similar unsorted event types share one card
// ---------------------------------------------------------------------------

export type InboxCard = {
  /** The first event type's id, or "stack:<key>". */
  id: string;
  eventTypes: IntelEventType[];
  result: SuggestionResult;
  /** "6 personal calendars", "3 look-alikes of Strategy Meeting"; null for a single card. */
  stackLabel: string | null;
};

/**
 * One card per unsorted event type, except that event types with the same
 * suggestion share a card when they are all personal calendars (or another
 * not-a-sales-call reason) or look-alikes of each other.
 */
export function buildInboxCards(
  unsorted: readonly IntelEventType[],
  programs: readonly IntelProgram[],
  all: readonly IntelEventType[],
): InboxCard[] {
  const singles = unsorted.map((eventType) => ({ eventType, result: suggestDestination(eventType, programs, all) }));
  const cards: InboxCard[] = [];
  const taken = new Set<string>();

  for (const entry of singles) {
    if (taken.has(entry.eventType.id)) continue;
    const best = entry.result.best;
    if (best) {
      const mates = singles.filter(
        (other) =>
          other.eventType.id !== entry.eventType.id &&
          !taken.has(other.eventType.id) &&
          other.result.best !== null &&
          sameDestination(other.result.best, best) &&
          (best.kind === "not_sales_call"
            ? best.reason !== "duplicate"
            : areLookalikes(other.eventType, entry.eventType)),
      );
      if (mates.length > 0) {
        const members = [entry, ...mates];
        members.forEach((member) => taken.add(member.eventType.id));
        const eventTypes = members.map((member) => member.eventType);
        const strengths = members.map((member) => member.result.best!.strength);
        const weakest: Strength = strengths.includes("possible") ? "possible" : strengths.includes("likely") ? "likely" : "strong";
        const label =
          best.kind === "not_sales_call"
            ? `${members.length} ${stackNoun(best.reason)}`
            : `${members.length} look-alikes of ${familyLabel(entry.eventType.name)}`;
        const reasons =
          best.kind === "not_sales_call"
            ? [...new Set(members.flatMap((member) => member.result.best!.reasons.slice(0, 1)))].slice(0, 2)
            : best.reasons.slice(0, 2);
        cards.push({
          id: `stack:${entry.eventType.id}`,
          eventTypes,
          stackLabel: label,
          result: {
            best: { ...best, strength: weakest, reasons: [...reasons, `Same suggestion for ${members.length === 2 ? "both" : `all ${countWord(members.length)}`}, so they share one card.`] },
            alternatives: entry.result.alternatives.filter((alternative) => alternative.kind === "not_sales_call" || alternative.kind === "program").slice(0, 2),
            lookalikes: entry.result.lookalikes,
          },
        });
        continue;
      }
    }
    taken.add(entry.eventType.id);
    cards.push({ id: entry.eventType.id, eventTypes: [entry.eventType], result: entry.result, stackLabel: null });
  }

  // Strongest, most-booked suggestions first; cards without one go last.
  const rank = (card: InboxCard) => {
    const best = card.result.best;
    if (!best) return 0;
    return best.strength === "strong" ? 3 : best.strength === "likely" ? 2 : 1;
  };
  const bookings = (card: InboxCard) => card.eventTypes.reduce((sum, eventType) => sum + eventType.bookings30d, 0);
  return cards.sort((left, right) => rank(right) - rank(left) || bookings(right) - bookings(left));
}

function stackNoun(reason: NotSalesReason) {
  switch (reason) {
    case "personal":
      return "personal calendars";
    case "follow_up":
      return "follow-up calls";
    case "internal":
      return "internal meetings";
    case "group":
      return "group events";
    default:
      return "duplicates";
  }
}

// ---------------------------------------------------------------------------
// Warnings on filed event types
// ---------------------------------------------------------------------------

/** "Name says “Extended” but the mode is Priority", or null. */
export function modeWarning(eventType: Pick<IntelEventType, "name" | "mode" | "status">) {
  if (eventType.status !== "sorted") return null;
  const word = eventType.name.match(MODE_WORDS)?.[1];
  if (word && eventType.mode === "normal") return `Name says “${capitalize(word.toLowerCase())}” but the mode is Priority`;
  return null;
}

/** Palette matching: every typed word starts a word of the label ("give std" → "Giveaways · Standard"). */
export function paletteMatch(query: string, label: string) {
  const typed = normalizeWords(query).split(" ").filter(Boolean);
  if (typed.length === 0) return true;
  const words = normalizeWords(label).split(" ").filter(Boolean);
  return typed.every((part) => words.some((word) => word.startsWith(part) || (part.length >= 3 && abbreviates(part, word))));
}

// "std" abbreviates "standard": its letters appear in order, starting with the first.
function abbreviates(part: string, word: string) {
  if (part[0] !== word[0]) return false;
  let index = 0;
  for (const char of word) if (char === part[index]) index += 1;
  return index === part.length;
}
