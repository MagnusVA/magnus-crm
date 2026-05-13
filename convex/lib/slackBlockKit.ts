import type { KnownBlock, ModalView } from "@slack/types";
import type { Id } from "../_generated/dataModel";
import {
  isSocialPlatform,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
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
  platform: SocialPlatform;
  handle: string;
  email: string | null;
  phone: string | null;
};

export type QualifiedLeadConfirmationArgs = {
  leadFullName: string;
  platform: SocialPlatform;
  handle: string;
  qualifiedBySlackUserId: string;
  appUrl: string;
  opportunityId: string;
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
    submit: { type: "plain_text", text: "Create lead" },
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
        block_id: "platform",
        label: { type: "plain_text", text: "Social platform" },
        element: {
          type: "static_select",
          action_id: "v",
          placeholder: { type: "plain_text", text: "Pick one" },
          options: SOCIAL_PLATFORMS.map((platform) => ({
            text: {
              type: "plain_text",
              text: SOCIAL_PLATFORM_LABELS[platform],
            },
            value: platform,
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
      {
        type: "input",
        block_id: "email",
        optional: true,
        label: { type: "plain_text", text: "Email (optional)" },
        element: {
          type: "email_text_input",
          action_id: "v",
        },
      },
      {
        type: "input",
        block_id: "phone",
        optional: true,
        label: { type: "plain_text", text: "Phone (optional)" },
        element: {
          type: "plain_text_input",
          action_id: "v",
          max_length: 30,
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
  const platformLabel = SOCIAL_PLATFORM_LABELS[args.platform];
  const opportunityUrl = crmOpportunityUrl(args.appUrl, args.opportunityId);
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🎯 New Qualified Lead", emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Name:*\n${leadName}` },
        { type: "mrkdwn", text: `*Platform:*\n${platformLabel}` },
        { type: "mrkdwn", text: `*Handle:*\n${handle}` },
        {
          type: "mrkdwn",
          text: `*Qualified by:*\n<@${args.qualifiedBySlackUserId}>`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in CRM" },
          url: opportunityUrl,
        },
      ],
    },
  ];

  return {
    text: `${leadName} was qualified by <@${args.qualifiedBySlackUserId}>`,
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
  const platformRaw = values?.platform?.v?.selected_option?.value;
  const handle = getStringValue(values, "handle")?.trim() ?? "";
  const email = getStringValue(values, "email")?.trim() || null;
  const phone = getStringValue(values, "phone")?.trim() || null;

  if (!isSocialPlatform(platformRaw)) {
    return null;
  }

  return {
    ...meta,
    fullName,
    platform: platformRaw,
    handle,
    email,
    phone,
  };
}

function isSubmittedView(value: unknown): value is SlackSubmittedView {
  return typeof value === "object" && value !== null;
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
