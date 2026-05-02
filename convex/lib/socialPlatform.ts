import { v } from "convex/values";

/**
 * Social-platform identifiers shared by leadIdentifiers.type and the Slack
 * qualify-lead modal. Keep labels and validators aligned with this list.
 */
export const SOCIAL_PLATFORMS = [
  "instagram",
  "tiktok",
  "twitter",
  "facebook",
  "linkedin",
  "other_social",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "Twitter/X",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  other_social: "Other",
};

export const socialPlatformValidator = v.union(
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("twitter"),
  v.literal("facebook"),
  v.literal("linkedin"),
  v.literal("other_social"),
);

const SOCIAL_PLATFORM_SET = new Set<string>(SOCIAL_PLATFORMS);

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && SOCIAL_PLATFORM_SET.has(value);
}
