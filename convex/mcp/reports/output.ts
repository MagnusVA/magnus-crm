import { gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES } from "../../../lib/assistantReportMerge";
export type Json = null | string | number | boolean | Json[] | {
    [key: string]: Json;
};
export function incomplete(value: unknown): boolean {
    if (!value || typeof value !== "object")
        return false;
    return Object.entries(value).some(([key, v]) => /truncat|capped|partial|incomplete/i.test(key) && v === true || incomplete(v));
}
const derivedKey = /rate|ratio|average|avg|distinct|unique|cohort|opportunitiesWithReminderChains|chainLengthHistogram|wonDeals|perHour|perDay|percent|share|quota|target|velocity|age|duration|at$|date|daySpan|hourly|limit/i;
const identityKey = /^(id|key|.*Id|source|originKey|periodKey|bucket|fieldKey|paymentType)$/;
// Unknown numeric fields are non-additive until explicitly classified here.
const additiveNames = /^(count|.*Count|.*Numerator|.*Denominator|.*RevenueMinor|.*AmountMinor|.*CashMinor|cashCollectedMinor|revenueMinor|amountMinor|totalRevenue|totalSales|totalDeals|sales|deals|conversions|newLeads|totalConversions|excludedConversions|submissions|duplicates|scheduledHours|dayCount|businessDayCount|goalDayCount|totalQualified|qualified|totalBooked|booked|resparks|notAFit|entries|rawLeads|resparkedThenBooked|created|completed|totalCreated|totalCompleted|scheduled|shown|noShows|canceled|notRecorded|resultsRecorded|pastCalls|callsShowed|callsNoShow|callsCanceled|bookedCalls|callsScheduledNotRecorded|newBooked|newShowed|newNoShows|newCanceled|newPastCalls|followUpBooked|followUpShowed|followUpNoShows|followUpCanceled|followUpPastCalls|totalCloserActions|sold|lost|no_show|rescheduled|dq|follow_up|not_recorded|upcoming|admin|closer|unknown|payment_received|no_response_rescheduled|no_response_given_up|no_response_close_only|prospect|in_conversation|showed|customer)$/;
export function additiveField(key: string) { return !derivedKey.test(key) && additiveNames.test(key); }
function identity(value: Json, index: number) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const fields = Object.entries(value).filter(([k]) => identityKey.test(k));
        if (fields.length)
            return JSON.stringify(fields);
    }
    return String(index);
}
/** The page builders remain authoritative. Only additive fields join windows;
 * derived fields retain separate, labelled source answers.
 */
export function mergePanel(history: Json, today: Json, key = ""): {
    combined: Json;
    separate: Json | null;
} {
    if (typeof history === "number" || typeof today === "number" || history === null && today === null) {
        if (!additiveField(key))
            return { combined: { value: null, nullReason: "non_additive_split" }, separate: { history_as_of_watermark: history, today_live: today } };
        return { combined: typeof history === "number" || typeof today === "number" ? Number(history ?? 0) + Number(today ?? 0) : null, separate: null };
    }
    if (Array.isArray(history) || Array.isArray(today)) {
        if (/topAnswerPerField|chainLengthHistogram|topCloserActors|topDeals|origins/i.test(key))
            return { combined: { value: null, nullReason: "incomplete_input" }, separate: { history_as_of_watermark: history, today_live: today } };
        const left = Array.isArray(history) ? history : [];
        const right = Array.isArray(today) ? today : [];
        const byKey = new Map(left.map((v, i) => [identity(v, i), v]));
        const pairs = right.map((v, i) => { const k = identity(v, i); const past = byKey.get(k) ?? null; byKey.delete(k); return mergePanel(past, v, key); });
        for (const v of byKey.values())
            pairs.push(mergePanel(v, null, key));
        return { combined: pairs.map(p => p.combined), separate: pairs.some(p => p.separate !== null) ? pairs.map(p => p.separate) : null };
    }
    if (history && typeof history === "object" || today && typeof today === "object") {
        const left = history && typeof history === "object" ? history as Record<string, Json> : {};
        const right = today && typeof today === "object" ? today as Record<string, Json> : {};
        const combined: Record<string, Json> = {};
        const separate: Record<string, Json> = {};
        for (const k of new Set([...Object.keys(left), ...Object.keys(right)])) {
            if (identityKey.test(k) || /^unresolvedReminder/.test(k) || k === "window") {
                combined[k] = right[k] ?? left[k] ?? null;
                continue;
            }
            const pair = mergePanel(left[k] ?? null, right[k] ?? null, k);
            combined[k] = pair.combined;
            if (pair.separate !== null)
                separate[k] = pair.separate;
        }
        return { combined, separate: Object.keys(separate).length ? separate : null };
    }
    return { combined: today ?? history, separate: null };
}
/** Page revenue builders cannot certify currencies. Withhold their blended money. */
export function currencySafe(value: Json, key = "", moneyContext = false): Json {
    const money = moneyContext || /byOrigin|byPaymentType|minor|revenue|cash/i.test(key);
    if (Array.isArray(value))
        return value.map(v => currencySafe(v, key, money));
    if (value && typeof value === "object") {
        // A payment row with its own ISO currency is already safe.
        if (typeof value.currency === "string")
            return value;
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, currencySafe(v, k, money)]));
    }
    if (typeof value === "number" && (money || /minor|revenue|cash|totalSalesValue/i.test(key)))
        return { value: null, nullReason: "mixed_currencies" };
    return value;
}
/** Drop private fields and wrap all outside text, including labels that may
 * fall back to an email in an old page builder. No contact strings escape.
 */
export function safeText(value: Json, key = ""): Json {
    if (Array.isArray(value))
        return value.map(v => safeText(v, key));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).filter(([k]) => !/email|phone|receipt|proof|referenceCode|transcript|notes|imageUrl|avatar|picture|handle/i.test(k)).map(([k, v]) => [k, safeText(v, k)]));
    if (typeof value === "string" && /name|label|title|answer|originValue|utm|username|text/i.test(key))
        return { text: /\S+@\S+\.\S+/.test(value) ? "Hidden contact detail" : value.slice(0, 240), by: /lead|answer/i.test(key) ? "person" : "integration" };
    return value;
}
/** Bound every displayed list; the remainder is calculated from all omitted
 * inputs only where addition is meaningful. Already-cut source lists say so.
 */
export function boundPanel(value: Json, limit: number, complete: boolean, omissions: Json[], path = ""): Json {
    if (Array.isArray(value)) {
        // These page builders return only their top ten candidates. A cached
        // payload cannot reveal the unseen tail, so no remainder is invented.
        const sourceComplete = complete && !(/(?:topDeals|origins)$/.test(path) && value.length >= 10);
        if (!sourceComplete && complete) {
            omissions.push({ scope: path, rows: null, remainder: null, nullReason: "incomplete_input" });
        }
        const hidden = value.slice(limit);
        if (hidden.length) {
            const sums = new Map<string, number>();
            const sum = (v: Json, prefix = "", inheritedCurrency: string | null = null) => {
                if (!v || typeof v !== "object" || Array.isArray(v))
                    return;
                const currency = typeof v.currency === "string" ? v.currency : inheritedCurrency;
                for (const [k, child] of Object.entries(v)) {
                    if (typeof child === "number" && additiveField(k)) {
                        const money = /minor|revenue|cash|amount/i.test(k);
                        if (money && !currency) continue;
                        const sumKey = `${money ? currency + "." : ""}${prefix}${k}`;
                        sums.set(sumKey, (sums.get(sumKey) ?? 0) + child);
                    }
                    else if (child && typeof child === "object" && !Array.isArray(child))
                        sum(child, `${prefix}${k}.`, currency);
                }
            };
            for (const row of hidden)
                sum(row);
            const remainder: Json = Object.fromEntries(sums);
            omissions.push({ scope: path, rows: hidden.length, remainder: sourceComplete ? remainder : null, ...(!sourceComplete ? { nullReason: "incomplete_input" } : {}) });
        }
        return value.slice(0, limit).map((v, i) => boundPanel(v, limit, complete, omissions, `${path}/${i}`));
    }
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, boundPanel(v, limit, complete, omissions, `${path}/${k}`)]));
    return value;
}
export function capAnswer<T extends Record<string, unknown>>(answer: T): T | Record<string, unknown> {
    if (gatewayAnswerBytes(answer) <= MAX_ASSISTANT_ANSWER_BYTES)
        return answer;
    const { rows: _rows, panels: _panels, comparison: _comparison, comparisonOmitted: _comparisonOmitted, omitted: _omitted, ...base } = answer;
    return { ...base, status: "unavailable", isPartial: true, reasons: ["answer_size_limit"], nullReason: "answer_size_limit" };
}
/** Closer focus narrows the page's closer lists. The page's workspace totals
 * retain their explicit scope, since its public readers have no closer filter.
 */
export function focusCloser(value: Json, closerId: string): Json {
    if (Array.isArray(value)) {
        const keyOf = (row: Json) => row && typeof row === "object" && !Array.isArray(row) ? row.closerId ?? row.attributedCloserId ?? row.userId : undefined;
        const hasCloserRows = value.some(row => keyOf(row) !== undefined);
        return (hasCloserRows ? value.filter(row => keyOf(row) === closerId) : value).map(row => focusCloser(row, closerId));
    }
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, focusCloser(v, closerId)]));
    return value;
}
