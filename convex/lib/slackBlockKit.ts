import type { KnownBlock, ModalView } from "@slack/types";
import type { Doc, Id } from "../_generated/dataModel";
import {
  isLeadType,
  LEAD_TYPE_LABELS,
  LEAD_TYPES,
  type LeadType,
} from "./leadType";
import type { BookingReviewDetail, BookingReviewPerson } from "../pipeline/bookingReviews";
import { dealPositionLabel } from "../opportunities/stageLabels";
import { normalizeSocialHandle } from "./normalization";
import {
  SOCIAL_PLATFORM_LABELS,
  type SocialPlatform,
} from "./socialPlatform";

const MAX_DIGEST_ENTRIES = 25;

export type QualifyLeadModalMetadata = {
  tenantId: Id<"tenants">;
  slackUserId: string;
  teamId: string;
  appId: string;
  channelId: string;
};

export type ParsedQualifyLeadSubmission = QualifyLeadModalMetadata & {
  fullName: string;
  handle: string;
  country: string;
  leadType: LeadType;
};

export type QualifiedLeadConfirmationArgs = {
  leadFullName: string;
  platform: SocialPlatform;
  handle: string;
  country?: string;
  leadType?: LeadType;
  qualifiedBySlackUserId: string;
  submittedAt?: number;
  qualificationGoal?: {
    qualifiedCount: number;
    dailyTeamQualificationGoal: number;
  };
  appUrl: string;
  opportunityId: string;
};

type LeadGenSource = Doc<"leadGenSubmissions">["source"];
type LeadGenOriginKind = Doc<"leadGenSubmissions">["originKind"];

export type LeadGenSubmissionNotificationArgs = {
  handle: string;
  profileUrl: string;
  source: LeadGenSource;
  originKind: LeadGenOriginKind;
  originValue?: string;
  submittedByName: string;
  teamName?: string;
  contactAttemptNumber: number;
  /** True when older attempts went uncounted, so the number is a minimum. */
  contactAttemptCapped?: boolean;
  submittedAt: number;
};

const LEAD_GEN_SOURCE_LABELS: Record<LeadGenSource, string> = {
  instagram: "Instagram",
  meta_business: "Meta Business",
};

const LEAD_GEN_ORIGIN_LABELS: Record<LeadGenOriginKind, string> = {
  post: "Post",
  reel: "Reel",
  story_poll: "Story Poll",
  story: "Story",
  follower: "Follower",
  application: "Application",
  source_only: "Source only",
  meta_business: "Meta Business",
  other: "Other",
};

export type StaleLeadDigestEntry = {
  leadFullName: string;
  platform: SocialPlatform;
  handle: string;
  daysOld: number;
  appUrl: string;
  opportunityId: string;
  qualifiedBySlackUserId: string;
};

type SlackStateElement = {
  value?: unknown;
  selected_option?: {
    value?: unknown;
  } | null;
};

type SlackViewState = {
  values?: Record<
    string,
    Record<string, SlackStateElement | undefined> | undefined
  >;
};

type SlackSubmittedView = {
  private_metadata?: unknown;
  state?: SlackViewState;
};

export function buildQualifyLeadModal(
  meta: QualifyLeadModalMetadata,
): ModalView {
  return {
    type: "modal",
    callback_id: "qualify_lead_submit",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Qualify a Lead" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "full_name",
        label: { type: "plain_text", text: "Full name" },
        element: {
          type: "plain_text_input",
          action_id: "v",
          max_length: 200,
        },
      },
      {
        type: "input",
        block_id: "country",
        label: { type: "plain_text", text: "Country" },
        element: {
          type: "plain_text_input",
          action_id: "v",
          placeholder: { type: "plain_text", text: "e.g. United States" },
          max_length: 100,
        },
      },
      {
        type: "input",
        block_id: "lead_type",
        label: { type: "plain_text", text: "Type" },
        element: {
          type: "static_select",
          action_id: "v",
          placeholder: { type: "plain_text", text: "Pick one" },
          options: LEAD_TYPES.map((leadType) => ({
            text: {
              type: "plain_text",
              text: LEAD_TYPE_LABELS[leadType],
            },
            value: leadType,
          })),
        },
      },
      {
        type: "input",
        block_id: "handle",
        label: { type: "plain_text", text: "Social handle" },
        element: {
          type: "plain_text_input",
          action_id: "v",
          placeholder: { type: "plain_text", text: "@username" },
          max_length: 80,
        },
      },
    ],
  };
}

export function buildQualifiedLeadConfirmation(
  args: QualifiedLeadConfirmationArgs,
) {
  const leadName = escapeSlackMrkdwn(args.leadFullName);
  const handle = escapeSlackMrkdwn(args.handle);
  const profileUrl = socialProfileUrl(args.platform, args.handle);
  const platformLabel = SOCIAL_PLATFORM_LABELS[args.platform];
  const country = args.country ? escapeSlackMrkdwn(args.country) : null;
  const leadTypeLabel = args.leadType
    ? LEAD_TYPE_LABELS[args.leadType]
    : null;
  const goalText = args.qualificationGoal
    ? `${args.qualificationGoal.qualifiedCount}/${args.qualificationGoal.dailyTeamQualificationGoal} qualified`
    : null;
  const fields = [
    { type: "mrkdwn" as const, text: `*Name:*\n${leadName}` },
    ...(leadTypeLabel
      ? [{ type: "mrkdwn" as const, text: `*Type:*\n${leadTypeLabel}` }]
      : []),
    ...(country
      ? [{ type: "mrkdwn" as const, text: `*Country:*\n${country}` }]
      : []),
    { type: "mrkdwn" as const, text: `*Platform:*\n${platformLabel}` },
    {
      type: "mrkdwn" as const,
      text: `*Handle:*\n${profileUrl ? `<${slackLinkUrl(profileUrl)}|${handle}>` : handle}`,
    },
    {
      type: "mrkdwn" as const,
      text: `*Qualified by:*\n<@${args.qualifiedBySlackUserId}>`,
    },
  ];
  if (goalText) {
    fields.push({ type: "mrkdwn", text: `*Goal:*\n${goalText}` });
  }

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎯 New Qualified Lead", emoji: true },
    },
    {
      type: "section",
      fields,
    },
  ];
  if (args.submittedAt !== undefined) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Submitted ${slackDate(args.submittedAt)}`,
        },
      ],
    });
  }

  // Push notifications and some clients show only `text`, so it repeats
  // every submitted field.
  const details = [
    leadTypeLabel,
    country,
    `${platformLabel} ${handle}`,
  ].filter((detail): detail is string => Boolean(detail));
  return {
    text:
      `${leadName} (${details.join(", ")}) was qualified by ` +
      `<@${args.qualifiedBySlackUserId}>` +
      `${goalText ? `. Goal: ${goalText}` : ""}`,
    blocks,
  };
}

export function buildLeadGenSubmissionNotification(
  args: LeadGenSubmissionNotificationArgs,
) {
  const handle = escapeSlackMrkdwn(`@${args.handle}`);
  const sourceLabel = LEAD_GEN_SOURCE_LABELS[args.source];
  const submittedBy = escapeSlackMrkdwn(args.submittedByName);
  const origin = formatLeadGenOrigin(args.originKind, args.originValue);
  const isRepeat =
    args.contactAttemptNumber > 1 || Boolean(args.contactAttemptCapped);
  const attempt =
    `#${args.contactAttemptNumber}` + (args.contactAttemptCapped ? "+" : "");

  const fields = [
    {
      type: "mrkdwn" as const,
      text: `*Prospect:*\n<${slackLinkUrl(args.profileUrl)}|${handle}>`,
    },
    { type: "mrkdwn" as const, text: `*Source:*\n${sourceLabel}` },
    ...(origin
      ? [{ type: "mrkdwn" as const, text: `*Origin:*\n${origin}` }]
      : []),
    { type: "mrkdwn" as const, text: `*Submitted by:*\n${submittedBy}` },
    ...(args.teamName
      ? [
          {
            type: "mrkdwn" as const,
            text: `*Team:*\n${escapeSlackMrkdwn(args.teamName)}`,
          },
        ]
      : []),
    {
      type: "mrkdwn" as const,
      text: isRepeat
        ? `*Prospect status:*\nRepeat - attempt ${attempt}`
        : "*Prospect status:*\nNew prospect",
    },
  ];

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📥 New Lead Gen Submission", emoji: true },
    },
    { type: "section", fields },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Submitted ${slackDate(args.submittedAt)}`,
        },
      ],
    },
  ];

  const originLabel =
    args.originKind === "source_only"
      ? null
      : LEAD_GEN_ORIGIN_LABELS[args.originKind];
  return {
    text:
      `${handle} submitted by ${submittedBy}` +
      ` (${[sourceLabel, originLabel].filter(Boolean).join(", ")})` +
      (isRepeat ? ` - repeat prospect, attempt ${attempt}` : ""),
    blocks,
  };
}

export function buildStaleDigest(args: {
  entries: StaleLeadDigestEntry[];
  hasMore: boolean;
  appUrl: string;
}) {
  const visible = args.entries.slice(0, MAX_DIGEST_ENTRIES);
  const headline = args.hasMore
    ? `${visible.length}+ qualified leads waiting`
    : `${visible.length} qualified lead${visible.length === 1 ? "" : "s"} waiting`;

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🟡 ${headline}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Qualified more than 30 days ago with no booking yet. Leads with no booking after 31 days close as lost (stale). Daily digest, 8am ET.",
        },
      ],
    },
    { type: "divider" },
  ];

  for (const entry of visible) {
    const leadName = escapeSlackMrkdwn(entry.leadFullName);
    const platformLabel = SOCIAL_PLATFORM_LABELS[entry.platform];
    const handle = escapeSlackMrkdwn(entry.handle);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*${leadName}*\n` +
          `${platformLabel} - ${handle} - ${entry.daysOld} day${entry.daysOld === 1 ? "" : "s"} old\n` +
          `Qualified by <@${entry.qualifiedBySlackUserId}>`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Open" },
        url: crmOpportunityUrl(entry.appUrl, entry.opportunityId),
      },
    });
  }

  if (args.hasMore) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_More qualified leads are waiting - view all in CRM_",
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "View all" },
        // /workspace/pipeline redirects whatever it is given, so links
        // already posted with `status=` land where this one does
        // (docs/plans/phase-5-deal-status.md §6.8).
        url: `${args.appUrl}/workspace/pipeline?source=slack_qualified&stage=qualified`,
      },
    });
  }

  return {
    text: headline,
    blocks,
  };
}

const MATCH_LABELS = {
  email: "email",
  phone: "phone",
  social_handle: "Instagram handle",
} as const;

const MAX_REVIEW_DEALS = 3;

function bookingReviewPersonText(person: BookingReviewPerson) {
  const contact = [
    person.email && escapeSlackMrkdwn(person.email),
    person.phone && escapeSlackMrkdwn(person.phone),
    ...person.handles.map((h) => escapeSlackMrkdwn(`@${h.handle}`)),
  ].filter(Boolean);
  const deals = person.deals.slice(0, MAX_REVIEW_DEALS).map((deal) => {
    const parts = [dealPositionLabel(deal.position, deal.systemLoss)];
    const closer = deal.closerName ?? deal.hostName;
    if (closer) parts.push(`with ${escapeSlackMrkdwn(closer)}`);
    if (deal.latestMeetingAt !== undefined) parts.push(`call ${slackDate(deal.latestMeetingAt)}`);
    if (deal.qualifiedByName) parts.push(`qualified by ${escapeSlackMrkdwn(deal.qualifiedByName)}`);
    return parts.join(", ");
  });
  const more = person.deals.length > MAX_REVIEW_DEALS ? ` (+${person.deals.length - MAX_REVIEW_DEALS} more)` : "";
  return [
    `*${escapeSlackMrkdwn(person.name ?? "Unnamed person")}*${contact.length ? `  ·  ${contact.join("  ·  ")}` : ""}`,
    deals.length ? `Deals: ${deals.join("; ")}${more}` : "No deals",
  ].join("\n");
}

export function buildBookingReviewNotification(
  detail: BookingReviewDetail,
  appUrl: string,
) {
  const { booking } = detail;
  const invitee = escapeSlackMrkdwn(booking.inviteeName ?? "Someone");
  const booked = detail.people.find((p) => p.role === "booked");
  const matched = detail.people.filter((p) => p.role === "matched");
  const call = [
    booking.eventName && `*${escapeSlackMrkdwn(booking.eventName)}*`,
    booking.hostName && `with ${escapeSlackMrkdwn(booking.hostName)}`,
    booking.startTime !== undefined && `for ${slackDate(booking.startTime)}`,
  ].filter(Boolean).join(" ");
  const handle = booking.socialHandle ? escapeSlackMrkdwn(`@${booking.socialHandle.handle}`) : null;
  const named = matched
    .map((p) => `its ${p.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")} belongs to *${escapeSlackMrkdwn(p.name ?? "an unnamed person")}*`)
    .join(", and ");

  const summary =
    detail.kind === "attached" && booked
      ? `${invitee} booked ${call || "a call"}. The Instagram handle ${handle ?? ""} belongs to *${escapeSlackMrkdwn(booked.name ?? "an unnamed person")}*, so the call went to them, but ${named}. Are they the same person?`
      : `${invitee} booked ${call || "a call"}. The CRM is holding it: ${named || "its details name more than one person"}. The call is not in the CRM until someone decides.`;

  const fields = [
    { label: "Invitee", value: booking.inviteeName },
    { label: "Email", value: booking.email },
    { label: "Phone", value: booking.phone },
    { label: "Instagram", value: booking.socialHandle && `@${booking.socialHandle.handle}` },
    { label: "Time zone", value: booking.timezone },
    { label: "Booked via", value: booking.bookedVia },
  ].flatMap(({ label, value }) =>
    value ? [{ type: "mrkdwn" as const, text: `*${label}:*\n${escapeSlackMrkdwn(value)}` }] : [],
  );

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: detail.kind === "attached" ? "🔀 Booking matched two people" : "⏸️ Booking held for review",
        emoji: true,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: summary } },
  ];
  if (fields.length) blocks.push({ type: "section", fields });
  if (booked)
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Booking went to*\n${bookingReviewPersonText(booked)}` },
    });
  for (const person of matched) {
    const checks = person.checks;
    const same = checks.filter((c) => c.same).map((c) => c.label);
    const different = checks.filter((c) => !c.same).map((c) => c.label);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Also matched by ${person.matchedBy.map((via) => MATCH_LABELS[via]).join(" and ")}*\n${bookingReviewPersonText(person)}`,
      },
    });
    if (checks.length)
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: [
              same.length ? `Same as the booking: ${same.join(", ")}` : null,
              different.length ? `Different: ${different.join(", ")}` : null,
            ].filter(Boolean).join("  ·  "),
          },
        ],
      });
  }
  const reviewUrl = new URL(
    `/workspace/operations/booking-reviews/${detail.reviewId}`,
    appUrl.replace(/\/$/, ""),
  ).toString();
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Review and decide", emoji: true },
        url: reviewUrl,
      },
    ],
  });

  return {
    text:
      detail.kind === "attached"
        ? `${invitee}'s booking went to ${booked?.name ?? "the Instagram handle's person"}, but ${named}. Review: ${reviewUrl}`
        : `${invitee}'s booking is held: ${named || "it names more than one person"}. Review: ${reviewUrl}`,
    blocks,
    reviewUrl,
  };
}

export function parseQualifyLeadSubmission(
  view: unknown,
): ParsedQualifyLeadSubmission | null {
  if (!isSubmittedView(view)) {
    return null;
  }

  const meta = parseMetadata(view.private_metadata);
  if (!meta) {
    return null;
  }

  const values = view.state?.values;
  const fullName = getStringValue(values, "full_name")?.trim() ?? "";
  const country = getStringValue(values, "country")?.trim() ?? "";
  const leadTypeRaw = values?.lead_type?.v?.selected_option?.value;
  const handle = getStringValue(values, "handle")?.trim() ?? "";

  if (!isLeadType(leadTypeRaw)) {
    return null;
  }

  return {
    ...meta,
    fullName,
    handle,
    country,
    leadType: leadTypeRaw,
  };
}

function isSubmittedView(value: unknown): value is SlackSubmittedView {
  return typeof value === "object" && value !== null;
}

function formatLeadGenOrigin(
  originKind: LeadGenOriginKind,
  originValue: string | undefined,
): string | null {
  if (originKind === "source_only") return null;
  const label = LEAD_GEN_ORIGIN_LABELS[originKind];
  if (!originValue) return label;
  if (originKind === "post" || originKind === "reel") {
    // Capture normalizes post and reel origins to an http(s) URL.
    return `<${slackLinkUrl(originValue)}|${label}>`;
  }
  return `${label} - ${escapeSlackMrkdwn(originValue)}`;
}

/** Instagram is the only platform the qualify modal submits today. */
function socialProfileUrl(platform: SocialPlatform, rawHandle: string) {
  if (platform !== "instagram") return null;
  const handle = normalizeSocialHandle(rawHandle, "instagram");
  if (!handle || !/^[a-z0-9._]+$/.test(handle)) return null;
  return `https://instagram.com/${handle}`;
}

/**
 * Slack reads `|` as the URL/label separator, and URL parsing keeps it in
 * pathnames, so encode it along with the mrkdwn control characters.
 */
function slackLinkUrl(url: string) {
  return escapeSlackMrkdwn(url).replace(/\|/g, "%7C");
}

/** Renders in each reader's own timezone. */
function slackDate(timestamp: number) {
  const seconds = Math.floor(timestamp / 1000);
  const fallback = new Date(timestamp).toISOString();
  return `<!date^${seconds}^{date_short_pretty} at {time}|${fallback}>`;
}

function crmOpportunityUrl(appUrl: string, opportunityId: string) {
  const url = new URL("/api/slack/open-opportunity", appUrl.replace(/\/$/, ""));
  url.searchParams.set("opportunityId", opportunityId);
  return url.toString();
}

function parseMetadata(value: unknown): QualifyLeadModalMetadata | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.tenantId !== "string" ||
      typeof parsed.slackUserId !== "string" ||
      typeof parsed.teamId !== "string" ||
      typeof parsed.appId !== "string" ||
      typeof parsed.channelId !== "string"
    ) {
      return null;
    }

    return {
      tenantId: parsed.tenantId as Id<"tenants">,
      slackUserId: parsed.slackUserId,
      teamId: parsed.teamId,
      appId: parsed.appId,
      channelId: parsed.channelId,
    };
  } catch {
    return null;
  }
}

function getStringValue(
  values: SlackViewState["values"],
  blockId: string,
): string | undefined {
  const value = values?.[blockId]?.v?.value;
  return typeof value === "string" ? value : undefined;
}

function escapeSlackMrkdwn(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
