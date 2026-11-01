import type { getLeadConversionMetrics } from "../../reporting/leadConversion";
import type {
  getAnswerDistribution,
  getFormResponseKpis,
} from "../../reporting/formResponseAnalytics";
import type { ReaderOutput } from "../definition";
import { joinOntoToday, mergeRows, rate } from "./helpers";

type LeadConversionMetrics = ReaderOutput<typeof getLeadConversionMetrics>;
type FormResponseKpis = ReaderOutput<typeof getFormResponseKpis>;
type AnswerDistribution = ReaderOutput<typeof getAnswerDistribution>;

export function mergeLeadConversionMetrics(
  history: LeadConversionMetrics,
  today: LeadConversionMetrics,
): LeadConversionMetrics {
  const newLeads = history.newLeads + today.newLeads;
  const totalConversions = history.totalConversions + today.totalConversions;
  const meetingsPerSaleNumerator =
    history.meetingsPerSaleNumerator + today.meetingsPerSaleNumerator;
  const meetingsPerSaleDenominator =
    history.meetingsPerSaleDenominator + today.meetingsPerSaleDenominator;
  const timeToConversionSampleCount =
    history.timeToConversionSampleCount + today.timeToConversionSampleCount;
  return {
    newLeads,
    totalConversions,
    conversionRate: rate(totalConversions, newLeads),
    meetingsPerSaleNumerator,
    meetingsPerSaleDenominator,
    avgMeetingsPerSale: rate(meetingsPerSaleNumerator, meetingsPerSaleDenominator),
    timeToConversionSampleCount,
    avgTimeToConversionMs: rate(
      (history.avgTimeToConversionMs ?? 0) * history.timeToConversionSampleCount +
        (today.avgTimeToConversionMs ?? 0) * today.timeToConversionSampleCount,
      timeToConversionSampleCount,
    ),
    byCloser: joinOntoToday(
      history.byCloser,
      today.byCloser,
      (row) => row.closerId,
      (past, current) => ({ ...current, conversions: past.conversions + current.conversions }),
    ).sort(
      (left, right) =>
        right.conversions - left.conversions || left.closerName.localeCompare(right.closerName),
    ),
    excludedConversions: history.excludedConversions + today.excludedConversions,
    isConversionDataTruncated: history.isConversionDataTruncated || today.isConversionDataTruncated,
  };
}

export function mergeFormResponseKpis(
  history: FormResponseKpis,
  today: FormResponseKpis,
): FormResponseKpis {
  const totalMeetings = history.totalMeetings + today.totalMeetings;
  const respondedMeetingsCount = history.respondedMeetingsCount + today.respondedMeetingsCount;
  return {
    totalMeetings,
    respondedMeetingsCount,
    formResponseRate: rate(respondedMeetingsCount, totalMeetings),
    topAnswerPerField: mergeRows(
      history.topAnswerPerField,
      today.topAnswerPerField,
      (row) => row.fieldKey,
      (past, current) => {
        // Only each window's top answer is returned. Combine matching tops,
        // else choose the larger known count, then the builder's label order.
        // Counts for candidates hidden behind either top cannot be recovered.
        const totalResponses = past.totalResponses + current.totalResponses;
        const top =
          past.topAnswer === current.topAnswer
            ? { ...current, topAnswerCount: past.topAnswerCount + current.topAnswerCount }
            : [past, current].sort(
                (left, right) =>
                  right.topAnswerCount - left.topAnswerCount ||
                  left.topAnswer.localeCompare(right.topAnswer),
              )[0];
        return {
          ...current,
          topAnswer: top.topAnswer,
          topAnswerCount: top.topAnswerCount,
          totalResponses,
          topAnswerShare: rate(top.topAnswerCount, totalResponses) ?? 0,
        };
      },
    ).sort((left, right) => left.fieldKey.localeCompare(right.fieldKey)),
    isMeetingsTruncated: history.isMeetingsTruncated || today.isMeetingsTruncated,
    isFormResponsesTruncated: history.isFormResponsesTruncated || today.isFormResponsesTruncated,
  };
}

export function mergeAnswerDistribution(
  history: AnswerDistribution,
  today: AnswerDistribution,
): AnswerDistribution {
  const totalResponses = history.totalResponses + today.totalResponses;
  const distribution = mergeRows(
    history.distribution,
    today.distribution,
    (row) => row.answer,
    (past, current) => ({ ...current, count: past.count + current.count }),
  )
    .map((row) => ({ ...row, percent: (rate(row.count, totalResponses) ?? 0) * 100 }))
    .sort((left, right) => right.count - left.count || left.answer.localeCompare(right.answer));
  return {
    fieldKey: today.fieldKey,
    totalResponses,
    distinctAnswers: distribution.length,
    distribution,
    isTruncated: history.isTruncated || today.isTruncated,
  };
}
