import type { Doc } from "../_generated/dataModel";
import {
  isPlaceholderEmail,
  normalizeEmail,
  normalizePhone,
  normalizeSocialHandle,
} from "../lib/normalization";
import { isSocialPlatform, type SocialPlatform } from "../lib/socialPlatform";

/**
 * One value that identifies a person: `email:<address>`, `phone:<E.164>`, or
 * `social:<platform>:<handle>`. Placeholder values never become keys
 * (docs/plans/polluted-lead-split.md §4).
 */
export type IdentityKey = string;

export function emailKey(raw: string | undefined): IdentityKey | undefined {
  const email = raw === undefined ? undefined : normalizeEmail(raw);
  return email && !isPlaceholderEmail(email) ? `email:${email}` : undefined;
}

export function phoneKey(raw: string | undefined): IdentityKey | undefined {
  const phone = raw === undefined ? undefined : normalizePhone(raw);
  return phone ? `phone:${phone}` : undefined;
}

export function socialKey(
  platform: SocialPlatform,
  raw: string | undefined,
): IdentityKey | undefined {
  const handle = raw === undefined ? undefined : normalizeSocialHandle(raw, platform);
  return handle ? `social:${platform}:${handle}` : undefined;
}

export const isEmailKey = (key: IdentityKey) => key.startsWith("email:");
export const isPhoneKey = (key: IdentityKey) => key.startsWith("phone:");
export const isSocialKey = (key: IdentityKey) => key.startsWith("social:");

/** The identifier's value as a key, or undefined when it is a placeholder. */
export function identifierKey(
  identifier: Pick<Doc<"leadIdentifiers">, "type" | "value">,
): IdentityKey | undefined {
  if (identifier.type === "email") return emailKey(identifier.value);
  if (identifier.type === "phone") return phoneKey(identifier.value);
  return socialKey(identifier.type, identifier.value);
}

/** The `leadIdentifiers` type and value a key names. */
export function keyToIdentifier(
  key: IdentityKey,
): { type: Doc<"leadIdentifiers">["type"]; value: string } {
  if (isEmailKey(key)) return { type: "email", value: key.slice("email:".length) };
  if (isPhoneKey(key)) return { type: "phone", value: key.slice("phone:".length) };
  const [, platform, ...handle] = key.split(":");
  if (!isSocialPlatform(platform)) throw new Error(`Unknown key type: ${key}`);
  return { type: platform, value: handle.join(":") };
}

type FieldMappings = NonNullable<Doc<"eventTypeConfigs">["customFieldMappings"]>;

// Booking forms without a field mapping still ask these questions. Production
// labels: "Phone", "Phone Number", "What's your phone number?", "What's your
// Instagram username?", "Instagram Handle", "Intagram Handle".
const PHONE_LABEL = /\bphone\b/i;
const INSTAGRAM_LABEL = /\bins?tagram\b/i;

/**
 * The key a booking-form answer gives, from the event type's field mapping
 * or, without one, from the question label. Answers can name the field by its
 * label or by its hashed field key.
 */
export function answerKey(
  answer: { label: string; fieldKey?: string; text: string },
  mappings: FieldMappings | undefined,
): IdentityKey | undefined {
  const label = answer.label.trim();
  const names = (field: string | undefined) =>
    field !== undefined && (field.trim() === label || field === answer.fieldKey);
  if (names(mappings?.phoneField) || PHONE_LABEL.test(label)) {
    return phoneKey(answer.text);
  }
  if (names(mappings?.socialHandleField) && mappings?.socialHandleType) {
    return socialKey(mappings.socialHandleType, answer.text);
  }
  if (INSTAGRAM_LABEL.test(label)) return socialKey("instagram", answer.text);
  return undefined;
}

function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * True when one name's words are all in the other: "Ana" and "Ana Lopez"
 * agree, "Ana Lopez" and "Ana Ruiz" don't. Stricter than `areNamesSimilar`,
 * which only needs one shared word.
 */
export function namesCompatible(a: string, b: string): boolean {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, new Set(tokensB)] : [tokensB, new Set(tokensA)];
  return shorter.every((token) => longer.has(token));
}
