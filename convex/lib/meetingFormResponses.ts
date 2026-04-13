import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
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

function normalizeFieldKey(question: string): string {
  const normalized = question
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return normalized.length > 0 ? normalized : "unknown";
}

function getUniqueFieldKey(baseKey: string, usedKeys: Set<string>): string {
  if (!usedKeys.has(baseKey)) {
    return baseKey;
  }

  let suffix = 2;
  while (usedKeys.has(`${baseKey}_${suffix}`)) {
    suffix += 1;
  }

  return `${baseKey}_${suffix}`;
}

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

async function upsertFieldCatalogEntry(
  ctx: MutationCtx,
  args: {
    existingEntriesByFieldKey: Map<string, Doc<"eventTypeFieldCatalog">>;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    fieldKey: string;
    questionLabel: string;
    seenAt: number;
    tenantId: Id<"tenants">;
  },
): Promise<{
  action: "created" | "updated" | "unchanged";
  fieldCatalogId: Id<"eventTypeFieldCatalog">;
}> {
  const existingEntry =
    args.existingEntriesByFieldKey.get(args.fieldKey) ?? null;

  if (existingEntry) {
    const patch: Partial<Doc<"eventTypeFieldCatalog">> = {};
    if (args.seenAt > existingEntry.lastSeenAt) {
      patch.lastSeenAt = args.seenAt;
      patch.currentLabel = args.questionLabel;
    } else if (existingEntry.currentLabel !== args.questionLabel) {
      patch.currentLabel = args.questionLabel;
    }

    if (Object.keys(patch).length > 0) {
      const updatedEntry = {
        ...existingEntry,
        ...patch,
      };
      await ctx.db.patch(existingEntry._id, patch);
      args.existingEntriesByFieldKey.set(updatedEntry.fieldKey, updatedEntry);
      return {
        action: "updated",
        fieldCatalogId: existingEntry._id,
      };
    }

    return {
      action: "unchanged",
      fieldCatalogId: existingEntry._id,
    };
  }

  const fieldCatalogId = await ctx.db.insert("eventTypeFieldCatalog", {
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.questionLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
  });

  args.existingEntriesByFieldKey.set(args.fieldKey, {
    _id: fieldCatalogId,
    _creationTime: args.seenAt,
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.questionLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
    valueType: undefined,
  });

  return {
    action: "created",
    fieldCatalogId,
  };
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
    const eventTypeConfigId = args.eventTypeConfigId;
    const existingFieldCatalogEntries = ctx.db
      .query("eventTypeFieldCatalog")
      .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("eventTypeConfigId", eventTypeConfigId),
      );

    for await (const entry of existingFieldCatalogEntries) {
      fieldCatalogEntriesByFieldKey.set(entry.fieldKey, entry);
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
      const fieldCatalogResult = await upsertFieldCatalogEntry(ctx, {
        tenantId: args.tenantId,
        eventTypeConfigId: args.eventTypeConfigId,
        fieldKey,
        questionLabel: qa.question,
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
