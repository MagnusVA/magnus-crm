import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import { buildEntityDetail } from "../../leadCustomers/detail";
import {
  canOpenOpportunityDetail,
  canOpenMeetingDetail,
} from "../../leadCustomers/permissions";
import { buildMeetingDetail } from "../../closer/meetingDetail";
import { buildMyOpportunities } from "../../closer/pipeline";
import { rejectRequest } from "../../lib/observability/errors";
import { mcpCallerValidator, requireMcpUser, type McpUser } from "../guard";
import {
  latestCallNote,
  noteResult,
  noteResultValidator,
  personText,
  personTextValidator,
} from "../noteRead";
import { formatLocal } from "../time";

export const personArgs = {
  meetingId: v.optional(v.id("meetings")),
  personId: v.optional(v.id("leads")),
  search: v.optional(v.string()),
  includeContact: v.optional(v.boolean()),
};
const bookingAnswerValidator = v.object({
  meetingId: v.id("meetings"),
  question: v.string(),
  answer: v.string(),
  personSupplied: v.literal(true),
});
const refuse = () =>
  rejectRequest("person.not_yours", "That isn't one of your deals.");

async function readPerson(
  ctx: QueryCtx,
  me: McpUser,
  personId: Id<"leads">,
  includeContact: boolean,
  meetingDetail?: Awaited<ReturnType<typeof buildMeetingDetail>>,
) {
  // Check access before invoking the shared web reader, which can also show
  // masked summaries of other closers' deals on an accessible person's page.
  const owned = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", me.tenantId).eq("leadId", personId),
    )
    .take(1000);
  if (
    !owned.some((opportunity) =>
      canOpenOpportunityDetail({
        viewerUserId: me.userId,
        viewerRole: me.role,
        opportunity,
      }),
    )
  )
    throw refuse();
  const detail = await buildEntityDetail(ctx, me, personId);
  if (!detail || detail.kind !== "detail" || detail.lead.status === "merged")
    throw refuse();
  const visible = detail.opportunities.filter(
    (row) => row.permissions.canOpenOpportunity,
  );
  const visibleIds = new Set(visible.map((row) => row.opportunity._id));
  const meetings = detail.meetings.filter(
    (meeting) =>
      meeting.permissions.canOpenMeeting &&
      visibleIds.has(meeting.opportunityId),
  );
  let isPartial =
    owned.length === 1000 ||
    Object.values(detail.caps).some(Boolean) ||
    detail.meetings.length >= 50 ||
    visible.some(
      (row) =>
        detail.meetings.filter(
          (meeting) => meeting.opportunityId === row.opportunity._id,
        ).length >= 10,
    );
  const answer = (
    meetingId: Id<"meetings">,
    fieldKey: string,
    question: string,
    text: string,
  ) => ({
    meetingId,
    question,
    answer:
      !includeContact &&
      /email|phone|mobile|whatsapp|telephone|contact/i.test(
        `${fieldKey} ${question}`,
      )
        ? "Hidden contact detail"
        : text,
    personSupplied: true as const,
  });
  const answers = [];
  if (meetingDetail) {
    // A direct lookup always uses that booking, even beyond the person
    // page's bounded meeting history. These are the web reader's snapshots.
    answers.push(
      ...meetingDetail.bookingAnswers
        .slice(0, 20)
        .map((row) =>
          answer(
            meetingDetail.meeting._id,
            row.fieldKey,
            row.question,
            row.answer,
          ),
        ),
    );
    isPartial ||= meetingDetail.bookingAnswers.length > 20;
  } else {
    for (const meeting of meetings.slice(0, 10)) {
      const responses = await ctx.db
        .query("meetingFormResponses")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
        .take(21);
      isPartial ||= responses.length > 20;
      answers.push(
        ...responses
          .slice(0, 20)
          .filter((row) => row.tenantId === me.tenantId)
          .map((row) =>
            answer(
              meeting._id,
              row.fieldKey,
              row.questionLabelSnapshot,
              row.answerText,
            ),
          ),
      );
    }
    isPartial ||= meetings.length > 10;
  }
  const dealSummaries: Array<{
    opportunity: Pick<
      Doc<"opportunities">,
      | "_id"
      | "stage"
      | "outcome"
      | "soldProgramName"
      | "firstBookingProgramName"
      | "assignedCloserId"
    >;
    callAt: number | null;
  }> = visible.map(({ opportunity, nextStep }) => ({
    opportunity,
    callAt: nextStep?.callAt ?? null,
  }));
  if (meetingDetail && !visibleIds.has(meetingDetail.opportunity._id)) {
    dealSummaries.push({
      opportunity: meetingDetail.opportunity,
      callAt: meetingDetail.opportunity.nextMeetingAt ?? null,
    });
  }
  const deals = await Promise.all(
    dealSummaries.map(async ({ opportunity, callAt }) => {
      const note = await latestCallNote(ctx, me.tenantId, opportunity._id);
      // Payment IDs and proof status, so the agent can attach a receipt to
      // one that has none (decision 12a). Only on the caller's own deals.
      const payments =
        opportunity.assignedCloserId === me.userId
          ? await ctx.db
              .query("paymentRecords")
              .withIndex("by_opportunityId_and_recordedAt", (q) =>
                q.eq("opportunityId", opportunity._id),
              )
              .order("desc")
              .take(10)
          : [];
      return {
        opportunityId: opportunity._id,
        program:
          opportunity.soldProgramName ??
          opportunity.firstBookingProgramName ??
          null,
        stage: opportunity.stage,
        outcome: opportunity.outcome,
        nextCall: callAt !== null ? formatLocal(callAt, me.timeZone) : null,
        latestCallNote: note ? noteResult(note, me.timeZone) : null,
        payments: payments
          .filter((payment) => payment.tenantId === me.tenantId)
          .map((payment) => ({
            paymentId: payment._id,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            paymentType: payment.paymentType,
            status: payment.status,
            hasProof: payment.proofFileId !== undefined,
            recordedAt: formatLocal(payment.recordedAt, me.timeZone),
          })),
      };
    }),
  );
  return {
    personId,
    name: personText(detail.lead.fullName ?? "Unknown person"),
    ...(includeContact
      ? {
          contact: {
            email: detail.lead.email ?? null,
            phone: detail.lead.phone ?? null,
            personSupplied: true as const,
          },
        }
      : {}),
    deals,
    bookingAnswers: answers,
    isPartial,
  };
}

export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...personArgs },
  returns: v.object({
    timeZone: v.string(),
    isPartial: v.boolean(),
    people: v.array(
      v.object({
        personId: v.id("leads"),
        name: personTextValidator,
        contact: v.optional(
          v.object({
            email: v.union(v.string(), v.null()),
            phone: v.union(v.string(), v.null()),
            personSupplied: v.literal(true),
          }),
        ),
        deals: v.array(
          v.object({
            opportunityId: v.id("opportunities"),
            program: v.union(v.string(), v.null()),
            stage: v.string(),
            outcome: v.string(),
            nextCall: v.union(v.string(), v.null()),
            latestCallNote: v.union(noteResultValidator, v.null()),
            payments: v.array(
              v.object({
                paymentId: v.id("paymentRecords"),
                amountMinor: v.number(),
                currency: v.string(),
                paymentType: v.string(),
                status: v.string(),
                hasProof: v.boolean(),
                recordedAt: v.string(),
              }),
            ),
          }),
        ),
        bookingAnswers: v.array(bookingAnswerValidator),
        isPartial: v.boolean(),
      }),
    ),
  }),
  handler: async (
    ctx,
    { caller, meetingId, personId, search, includeContact },
  ) => {
    const me = await requireMcpUser(ctx, caller, ["closer"]);
    if (
      Number(!!meetingId) +
        Number(!!personId) +
        Number(search !== undefined) !==
      1
    ) {
      throw rejectRequest(
        "person.selector_required",
        "Pass one meeting ID, person ID or search string.",
      );
    }
    if (meetingId) {
      const meeting = await ctx.db.get("meetings", meetingId);
      if (
        !meeting ||
        meeting.tenantId !== me.tenantId ||
        !canOpenMeetingDetail({
          viewerUserId: me.userId,
          viewerRole: me.role,
          meeting,
        })
      )
        throw refuse();
      const deal = await ctx.db.get("opportunities", meeting.opportunityId);
      if (
        !deal ||
        deal.tenantId !== me.tenantId ||
        !canOpenOpportunityDetail({
          viewerUserId: me.userId,
          viewerRole: me.role,
          opportunity: deal,
        })
      )
        throw refuse();
      // Reuse the meeting page's reader and its authorization. Only selected
      // fields are exposed below, never its raw contact or payment payload.
      const detail = await buildMeetingDetail(ctx, me, meetingId);
      const person = await readPerson(
        ctx,
        me,
        detail.lead._id,
        includeContact ?? false,
        detail,
      );
      return {
        timeZone: me.timeZone,
        people: [person],
        isPartial: person.isPartial,
      };
    }
    if (personId) {
      const person = await readPerson(
        ctx,
        me,
        personId,
        includeContact ?? false,
      );
      return {
        timeZone: me.timeZone,
        people: [person],
        isPartial: person.isPartial,
      };
    }
    if (!search?.trim())
      throw rejectRequest(
        "person.search_required",
        "Enter a name or other search text.",
      );
    const result = await buildMyOpportunities(ctx, me, {
      tab: "all",
      search,
      limit: 300,
    });
    const ids = [...new Set(result.rows.map((row) => row.leadId))];
    const people = await Promise.all(
      ids
        .slice(0, 5)
        .map((id) => readPerson(ctx, me, id, includeContact ?? false)),
    );
    return {
      timeZone: me.timeZone,
      people,
      isPartial:
        result.isPartial ||
        result.isSearchPartial ||
        result.matched > result.rows.length ||
        ids.length > 5 ||
        people.some((p) => p.isPartial),
    };
  },
});
