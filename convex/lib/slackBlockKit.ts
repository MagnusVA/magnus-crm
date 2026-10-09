import type { KnownBlock, ModalView } from "@slack/types";
import type { Doc, Id } from "../_generated/dataModel";
import {
  isLeadType,
  LEAD_TYPE_LABELS,
  LEAD_TYPES,
  type LeadType,
} from "./leadType";
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
      text: `*Handle:*\n${profileUrl ? `<${profileUrl}|${handle}>` : handle}`,
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
      text: `*Prospect:*\n<${args.profileUrl}|${handle}>`,
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
          text: "Qualified more than 30 days ago with no booking yet. Daily digest, 8am ET.",
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
        url: `${args.appUrl}/workspace/pipeline?source=slack_qualified&status=qualified_pending`,
      },
    });
  }

  return {
    text: headline,
    blocks,
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
    return `<${escapeSlackMrkdwn(originValue)}|${label}>`;
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
