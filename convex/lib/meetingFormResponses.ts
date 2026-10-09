import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  loadFieldCatalogByKey,
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

/** Provider labels are values. SHA-256 keys accept every Unicode label and stay bounded. */
export async function questionFieldKey(
  label: string,
  occurrence = 0,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([label, occurrence])),
  );
  return (
    "q_" +
    Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export async function toQuestionAnswerRecord(
  entries: MeetingQuestionAnswer[],
): Promise<Record<string, string> | undefined> {
  if (!entries.length) return undefined;
  const record: Record<string, string> = {};
  const occurrences = new Map<string, number>();
  for (const entry of entries) {
    const occurrence = occurrences.get(entry.question) ?? 0;
    occurrences.set(entry.question, occurrence + 1);
    record[await questionFieldKey(entry.question, occurrence)] = entry.answer;
  }
  return record;
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
  const legacyOccurrences = new Map<string, number>();
  const existingResponses = ctx.db
    .query("meetingFormResponses")
    .withIndex("by_meetingId", (q) => q.eq("meetingId", args.meetingId));

  for await (const response of existingResponses) {
    if (response.tenantId !== args.tenantId)
      throw new Error("Form response tenant mismatch");
    const occurrence =
      legacyOccurrences.get(response.questionLabelSnapshot) ?? 0;
    legacyOccurrences.set(response.questionLabelSnapshot, occurrence + 1);
    const key = /^q_[a-f0-9]{64}$/.test(response.fieldKey)
      ? response.fieldKey
      : await questionFieldKey(response.questionLabelSnapshot, occurrence);
    responseByQuestion.set(key, response);
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

  const labels: Record<string, string> = {};
  const occurrences = new Map<string, number>();
  for (const qa of args.questionsAndAnswers) {
    const occurrence = occurrences.get(qa.question) ?? 0;
    occurrences.set(qa.question, occurrence + 1);
    const fieldKey = await questionFieldKey(qa.question, occurrence);
    labels[fieldKey] = qa.question;
    const existingResponse = responseByQuestion.get(fieldKey) ?? null;

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
      if (existingResponse.fieldKey !== fieldKey) patch.fieldKey = fieldKey;
      if (!existingResponse.eventTypeConfigId && args.eventTypeConfigId) {
        patch.eventTypeConfigId = args.eventTypeConfigId;
      }
      if (
        fieldCatalogId &&
        existingResponse.fieldCatalogId !== fieldCatalogId
      ) {
        patch.fieldCatalogId = fieldCatalogId;
      }

      if (Object.keys(patch).length > 0) {
        const updatedResponse = {
          ...existingResponse,
          ...patch,
        };
        await ctx.db.patch("meetingFormResponses", existingResponse._id, patch);
        responseByQuestion.set(fieldKey, updatedResponse);
        responsesUpdated += 1;
      } else {
        questionsSkipped += 1;
      }
      continue;
    }

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
    responseByQuestion.set(fieldKey, {
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

  const lead = await ctx.db.get("leads", args.leadId);
  if (!lead || lead.tenantId !== args.tenantId)
    throw new Error("Form response lead mismatch");
  const customFields = { ...lead.customFields };
  for (const [key, label] of Object.entries(labels)) {
    // Replace the old label-as-key representation when this question is seen
    // again, without dropping unrelated historical answers.
    if (!(key in customFields) && label in customFields)
      customFields[key] = customFields[label];
    if (!(label in labels)) delete customFields[label];
  }
  await ctx.db.patch("leads", lead._id, {
    customFields,
    customFieldLabels: { ...lead.customFieldLabels, ...labels },
  });
  if (args.eventTypeConfigId) {
    const config = await ctx.db.get("eventTypeConfigs", args.eventTypeConfigId);
    if (!config || config.tenantId !== args.tenantId)
      throw new Error("Form response config mismatch");
    await ctx.db.patch("eventTypeConfigs", config._id, {
      knownCustomFieldKeys: [
        ...new Set([
          ...(config.knownCustomFieldKeys ?? []).filter(
            (k) => !/^q_[a-f0-9]{64}$/.test(k),
          ),
          ...Object.values(labels),
        ]),
      ],
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
