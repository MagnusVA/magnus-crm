export type MetricRow = { id: string; value: number | null; unit: "count" | "minor" | "ratio" | "minutes" | "per_hour"; currency?: string; scope?: string; lowerBound?: boolean; group: string | null; period: string; label?: string; nullReason?: string };
export const NON_ADDITIVE = new Set(["closeRate", "showRate", "recorded", "showRateFloor", "firstCallShowRate", "timeToRecord", "cashPerWonDeal", "attributionCoverage", "perScheduledHour", "bookRate", "tasksOnTime"]);
export const isAdditive = (id: string) => !NON_ADDITIVE.has(id);
const key = (r: MetricRow) => JSON.stringify([r.id, r.group, r.period, r.currency ?? null]);

/** Never reconstruct a cohort, a distinct count or a ratio from split answers. */
export function mergeMetricWindows(history: MetricRow[], today: MetricRow[], complete: boolean): MetricRow[] {
  const result = new Map<string, MetricRow>();
  const separate: MetricRow[] = [];
  for (const [label, rows] of [["history_as_of_watermark", history], ["today_live", today]] as const) {
    for (const row of rows) {
      if (!isAdditive(row.id)) { separate.push({ ...row, label }); continue; }
      const old = result.get(key(row));
      result.set(key(row), { ...row, value: complete && row.value !== null ? (old?.value ?? 0) + row.value : null, ...(!complete ? { nullReason: "incomplete_input" } : {}) });
    }
  }
  return [...result.values(), ...separate];
}

export function metricDelta(current: MetricRow, baseline: MetricRow | undefined, complete: boolean) {
  if (!complete) return { delta: null, percentChange: null, nullReason: "incomplete_input" };
  if ((current.label && current.label !== "omitted_groups") || (baseline?.label && baseline.label !== "omitted_groups")) return { delta: null, percentChange: null, nullReason: "non_additive_split" };
  if (current.value === null || !baseline || baseline.value === null) return { delta: null, percentChange: null, nullReason: current.nullReason ?? baseline?.nullReason ?? "no_baseline" };
  const difference = current.value - baseline.value;
  if (current.unit === "ratio") return { delta: difference * 100, deltaUnit: "percentage_points", percentChange: null };
  return { delta: difference, deltaUnit: current.unit, percentChange: baseline.value === 0 ? null : difference / baseline.value * 100 };
}

/** Rank and calculate omitted groups only from a complete set. Currency remains part of every key. */
export function boundMetricRows(rows: MetricRow[], limit: number, complete: boolean) {
  const groups = [...new Set(rows.map(r => r.group))];
  if (!complete) {
    const kept = new Set(groups.slice(0, limit));
    return { rows: rows.filter(r => kept.has(r.group)), omitted: { groups: Math.max(0, groups.length - limit), remainder: null, nullReason: "incomplete_input" } };
  }
  const rankable = rows.every(r => isAdditive(r.id) && !r.label);
  const sameCurrency = new Set(rows.map(r => r.currency ?? "")).size <= 1;
  const scores = new Map(groups.map(group => [group, rows.find(r => r.group === group)?.value ?? 0]));
  const ordered = rankable && sameCurrency ? [...groups].sort((a, b) => scores.get(b)! - scores.get(a)! || String(a).localeCompare(String(b))) : groups;
  const kept = new Set(ordered.slice(0, limit));
  const omittedRows = rows.filter(r => !kept.has(r.group));
  const remainder = new Map<string, MetricRow>();
  for (const row of omittedRows) {
    const r = { ...row, group: null, label: "omitted_groups" };
    const old = remainder.get(key(r));
    remainder.set(key(r), { ...r, value: isAdditive(r.id) && !row.label && r.value !== null ? (old?.value ?? 0) + r.value : null, ...(!isAdditive(r.id) || row.label ? { nullReason: "non_additive_groups" } : {}) });
  }
  return { rows: rows.filter(r => kept.has(r.group)), omitted: { groups: Math.max(0, groups.length - limit), remainder: [...remainder.values()] } };
}

export const MAX_ASSISTANT_ANSWER_BYTES = 12 * 1024;
/** The gateway returns the same answer as structuredContent AND serialized text. */
export function gatewayAnswerBytes(answer: unknown) {
  return new TextEncoder().encode(JSON.stringify({ structuredContent: answer, content: [{ type: "text", text: JSON.stringify(answer) }] })).byteLength;
}
