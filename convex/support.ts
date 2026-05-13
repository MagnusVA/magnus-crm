import { v } from "convex/values";
import { mutation } from "./_generated/server";

const MAX_NAME_LENGTH = 160;
const MAX_EMAIL_LENGTH = 254;
const MAX_ORGANIZATION_LENGTH = 200;
const MAX_WORKSPACE_LENGTH = 120;
const MAX_SUBJECT_LENGTH = 180;
const MAX_MESSAGE_LENGTH = 4000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredText(value: string, label: string, maxLength: number) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

function optionalText(value: string | undefined, label: string, maxLength: number) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

export const submitSupportRequest = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    organizationName: v.optional(v.string()),
    slackWorkspace: v.optional(v.string()),
    subject: v.string(),
    message: v.string(),
    website: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.website?.trim()) {
      console.warn("[Support] Rejected support request from honeypot");
      throw new Error("Support request could not be submitted.");
    }

    const name = requiredText(args.name, "Name", MAX_NAME_LENGTH);
    const email = requiredText(args.email, "Email", MAX_EMAIL_LENGTH)
      .toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      throw new Error("Enter a valid email address.");
    }

    const subject = requiredText(args.subject, "Subject", MAX_SUBJECT_LENGTH);
    const message = requiredText(args.message, "Message", MAX_MESSAGE_LENGTH);
    const organizationName = optionalText(
      args.organizationName,
      "Organization",
      MAX_ORGANIZATION_LENGTH,
    );
    const slackWorkspace = optionalText(
      args.slackWorkspace,
      "Slack workspace",
      MAX_WORKSPACE_LENGTH,
    );
    const createdAt = Date.now();

    const supportTicketId = await ctx.db.insert("supportTickets", {
      name,
      email,
      organizationName,
      slackWorkspace,
      subject,
      message,
      source: "support_page",
      status: "new",
      createdAt,
    });

    console.log("[Support] support request submitted", {
      supportTicketId,
      createdAt,
    });

    return { supportTicketId };
  },
});
