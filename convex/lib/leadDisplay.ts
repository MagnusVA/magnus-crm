import type { Doc, Id } from "../_generated/dataModel";
import { SOCIAL_PLATFORM_LABELS } from "./socialPlatform";

const CONFIDENCE_SCORE: Record<Doc<"leadIdentifiers">["confidence"], number> = {
  verified: 0,
  inferred: 1,
  suggested: 2,
};

export function formatLeadIdentifier(
  identifier: Pick<Doc<"leadIdentifiers">, "type" | "rawValue" | "value" | "confidence">,
): string {
  if (identifier.type === "email" || identifier.type === "phone") {
    return identifier.rawValue || identifier.value;
  }

  const platformLabel =
    SOCIAL_PLATFORM_LABELS[
      identifier.type as keyof typeof SOCIAL_PLATFORM_LABELS
    ];
  const value = identifier.rawValue || identifier.value;
  return platformLabel ? `${value} (${platformLabel})` : value;
}

export function leadDisplayString(
  lead: Pick<Doc<"leads">, "_id" | "fullName" | "email">,
  identifiers?: Array<
    Pick<Doc<"leadIdentifiers">, "type" | "rawValue" | "value" | "confidence">
  >,
): string {
  const fullName = lead.fullName?.trim();
  if (fullName) return fullName;
  if (lead.email) return lead.email;

  if (identifiers && identifiers.length > 0) {
    const [top] = [...identifiers].sort(
      (a, b) => CONFIDENCE_SCORE[a.confidence] - CONFIDENCE_SCORE[b.confidence],
    );
    if (top) return formatLeadIdentifier(top);
  }

  return leadDisplayFromShape({ leadId: lead._id });
}

export function leadDisplayFromShape(args: {
  fullName?: string;
  email?: string;
  primaryIdentifier?: { type: string; rawValue: string };
  leadId?: Id<"leads"> | string;
}): string {
  const fullName = args.fullName?.trim();
  if (fullName) return fullName;
  if (args.email) return args.email;

  if (args.primaryIdentifier) {
    const platformLabel =
      SOCIAL_PLATFORM_LABELS[
        args.primaryIdentifier.type as keyof typeof SOCIAL_PLATFORM_LABELS
      ];
    return platformLabel
      ? `${args.primaryIdentifier.rawValue} (${platformLabel})`
      : args.primaryIdentifier.rawValue;
  }

  return args.leadId ? `Lead ${String(args.leadId).slice(-6)}` : "Lead";
}
