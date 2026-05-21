import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  getUniqueFieldKey,
  loadFieldCatalogByKey,
  normalizeFieldKey,
  upsertEventTypeFieldCatalogEntry,
} from "./eventTypeFields";
import { getString, isRecord } from "./payloadExtraction";

export type MeetingQuestionAnswer = {
  answer: string;
  question: string;
};

export type MeetingFormResponseWriteResult = {
  fieldCatalogCreated: number;
  fieldCatalogUpdated: number;
  questionsSkipped: number;
  responsesCreated: number;
  responsesUpdated: number;
};

export function extractQuestionsAndAnswers(
  value: unknown,
): MeetingQuestionAnswer[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: MeetingQuestionAnswer[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const question = getString(item, "question")?.trim();
    const answer = getString(item, "answer")?.trim();
    if (!question || !answer) {
      continue;
    }

    entries.push({ answer, question });
  }

  return entries;
}

export function toQuestionAnswerRecord(
  entries: MeetingQuestionAnswer[],
): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[entry.question] = entry.answer;
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

export async function writeMeetingFormResponses(
  ctx: MutationCtx,
  args: {
    capturedAt: number;
    eventTypeConfigId?: Id<"eventTypeConfigs">;
    leadId: Id<"leads">;
    meetingId: Id<"meetings">;
    opportunityId: Id<"opportunities">;
    questionsAndAnswers: MeetingQuestionAnswer[];
    tenantId: Id<"tenants">;
  },
): Promise<MeetingFormResponseWriteResult> {
  const responseByQuestion = new Map<string, Doc<"meetingFormResponses">>();
  const usedFieldKeys = new Set<string>();
  const existingResponses = ctx.db
    .query("meetingFormResponses")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId));

  for await (const response of existingResponses) {
    responseByQuestion.set(response.questionLabelSnapshot, response);
    usedFieldKeys.add(response.fieldKey);
  }

  const fieldCatalogEntriesByFieldKey = new Map<
    string,
    Doc<"eventTypeFieldCatalog">
  >();
  if (args.eventTypeConfigId) {
    const entries = await loadFieldCatalogByKey(ctx, {
      tenantId: args.tenantId,
      eventTypeConfigId: args.eventTypeConfigId,
    });
    for (const [fieldKey, entry] of entries) {
      fieldCatalogEntriesByFieldKey.set(fieldKey, entry);
    }
  }

  let responsesCreated = 0;
  let responsesUpdated = 0;
  let fieldCatalogCreated = 0;
  let fieldCatalogUpdated = 0;
  let questionsSkipped = 0;

  for (const qa of args.questionsAndAnswers) {
    const existingResponse = responseByQuestion.get(qa.question) ?? null;
    const baseFieldKey = normalizeFieldKey(qa.question);
    const fieldKey = existingResponse
      ? existingResponse.fieldKey
      : getUniqueFieldKey(baseFieldKey, usedFieldKeys);

    let fieldCatalogId: Id<"eventTypeFieldCatalog"> | undefined;
    if (args.eventTypeConfigId) {
      const fieldCatalogResult = await upsertEventTypeFieldCatalogEntry(ctx, {
        tenantId: args.tenantId,
        eventTypeConfigId: args.eventTypeConfigId,
        fieldKey,
        currentLabel: qa.question,
        seenAt: args.capturedAt,
        existingEntriesByFieldKey: fieldCatalogEntriesByFieldKey,
      });
      fieldCatalogId = fieldCatalogResult.fieldCatalogId;
      if (fieldCatalogResult.action === "created") {
        fieldCatalogCreated += 1;
      } else if (fieldCatalogResult.action === "updated") {
        fieldCatalogUpdated += 1;
      }
    }

    if (existingResponse) {
      const patch: Partial<Doc<"meetingFormResponses">> = {};
      if (!existingResponse.eventTypeConfigId && args.eventTypeConfigId) {
        patch.eventTypeConfigId = args.eventTypeConfigId;
      }
      if (!existingResponse.fieldCatalogId && fieldCatalogId) {
        patch.fieldCatalogId = fieldCatalogId;
      }

      if (Object.keys(patch).length > 0) {
        const updatedResponse = {
          ...existingResponse,
          ...patch,
        };
        await ctx.db.patch(existingResponse._id, patch);
        responseByQuestion.set(qa.question, updatedResponse);
        responsesUpdated += 1;
      } else {
        questionsSkipped += 1;
      }
      continue;
    }

    usedFieldKeys.add(fieldKey);
    const responseId = await ctx.db.insert("meetingFormResponses", {
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      opportunityId: args.opportunityId,
      leadId: args.leadId,
      eventTypeConfigId: args.eventTypeConfigId,
      fieldCatalogId,
      fieldKey,
      questionLabelSnapshot: qa.question,
      answerText: qa.answer,
      capturedAt: args.capturedAt,
    });
    responsesCreated += 1;
    responseByQuestion.set(qa.question, {
      _id: responseId,
      _creationTime: args.capturedAt,
      tenantId: args.tenantId,
      meetingId: args.meetingId,
      opportunityId: args.opportunityId,
      leadId: args.leadId,
      eventTypeConfigId: args.eventTypeConfigId,
      fieldCatalogId,
      fieldKey,
      questionLabelSnapshot: qa.question,
      answerText: qa.answer,
      capturedAt: args.capturedAt,
    });
  }

  return {
    responsesCreated,
    responsesUpdated,
    fieldCatalogCreated,
    fieldCatalogUpdated,
    questionsSkipped,
  };
}
