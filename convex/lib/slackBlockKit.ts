import type { ModalView } from "@slack/types";
import type { Id } from "../_generated/dataModel";
import {
  isSocialPlatform,
  SOCIAL_PLATFORM_LABELS,
  SOCIAL_PLATFORMS,
  type SocialPlatform,
} from "./socialPlatform";

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
