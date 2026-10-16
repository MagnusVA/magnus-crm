import { describe, expect, it } from "vitest";
import {
  isPlaceholderEmail,
  isPlaceholderHandle,
  isPlaceholderPhone,
  normalizePhone,
  normalizeSocialHandle,
} from "./normalization";

describe("normalizePhone", () => {
  it.each([
    ["+1 778-955-9253", "+17789559253"],
    ["(778) 955-9253", "+17789559253"],
    ["7789559253", "+17789559253"],
    ["17789559253", "+17789559253"],
    ["+1 416-555-0142", "+14165550142"],
    ["+1 212-555-1234", "+12125551234"],
    ["+1 555-010-0000", "+15550100000"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("keeps the real number %s", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    // Existing list and all-same-digit rule.
    "+1 234-567-8910",
    "1234567890",
    "0987654321",
    "+1 111-111-1111",
    // Known fakes from the polluted-lead split.
    "+1 234-234-2342",
    "+1 234-567-8901",
    "+1 212-345-6789",
    "+1 234-567-8945",
    // The same fakes typed without the country code.
    "234-234-2342",
    "234-567-8910",
  ])("rejects the known fake %s", (raw) => {
    expect(normalizePhone(raw)).toBeUndefined();
  });

  it.each([
    ["an ascending run of 7", "+1 345-678-9012"],
    ["a descending run of 7", "+1 498-765-4321"],
    ["a descending run of 7 at the start", "(987) 654-3201"],
    ["a 3-digit group repeated over 9 digits", "+1 456-456-4567"],
    ["a repeated area code and exchange", "+1 555-555-5555"],
  ])("rejects a North American number with %s", (_, raw) => {
    expect(normalizePhone(raw)).toBeUndefined();
  });

  it.each([
    ["a 6-digit ascending run", "+1 312-345-6000"],
    ["a group repeated twice", "+1 604-604-1234"],
  ])("keeps a North American number with only %s", (_, raw) => {
    expect(normalizePhone(raw)).toBeDefined();
  });

  it.each([
    // Both reviewed in Tier D and kept.
    ["German", "+49 171 9876543", "+491719876543"],
    ["UK", "+44 345 678 9101", "+443456789101"],
  ])("does not apply the pattern rule to a %s number", (_, raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    // Each typed by several bookers in production (Tier D).
    "+61 423 567 890",
    "+61 234 567 891",
    "+91 2345678990",
    // Reviewed one by one.
    "+52 987 654 3210",
    "+43 1 234567",
    "+62 812-3456-7890",
    "+44 7462 345678",
    "+254 712 345678",
    "+61 422 345 678",
    "+359 34 567 89",
    "+46 70 123 45 67",
    "+33 2 34 56 78 91",
    "+49 30 12345678",
    "+49 234 567891",
    "+41 79 123 45 67",
  ])("rejects the listed fake %s outside North America", (raw) => {
    expect(normalizePhone(raw)).toBeUndefined();
  });
});

describe("isPlaceholderPhone", () => {
  it.each(["+1 234-567-8912", "1234567890", "+1 111-111-1111", "+61 423 567 890"])(
    "flags the placeholder %s",
    (raw) => {
      expect(isPlaceholderPhone(raw)).toBe(true);
    },
  );

  it.each([
    ["a real number", "+1 778-955-9253"],
    ["a number too short to read", "12345"],
    ["text", "n/a"],
    ["a sequence outside North America", "+49 171 9876543"],
  ])("doesn't flag %s", (_, raw) => {
    expect(isPlaceholderPhone(raw)).toBe(false);
  });
});

describe("isPlaceholderEmail", () => {
  it.each([
    "email@gmail.com",
    "email@yahoo.com",
    "email@icloud.com",
    "thisisnotanemail@notanemail.com",
    "email@hotmail.com",
    "someone@notanemail.com",
  ])("treats %s as a placeholder", (email) => {
    expect(isPlaceholderEmail(email)).toBe(true);
  });

  it.each([
    "jane.coach@gmail.com",
    "email.me@gmail.com",
    "myemail@yahoo.com",
    "owner@acme-coaching.example",
    "info@email.com",
    // Booking tests use example.com addresses as real identities.
    "lead@example.com",
  ])("treats %s as a real address", (email) => {
    expect(isPlaceholderEmail(email)).toBe(false);
  });
});

describe("normalizeSocialHandle", () => {
  it.each([
    ["@campos.coachpro", "campos.coachpro"],
    ["https://www.instagram.com/Campos.CoachPro/", "campos.coachpro"],
    ["jo", "jo"],
    ["@j_9", "j_9"],
  ])("keeps the handle %s", (raw, expected) => {
    expect(normalizeSocialHandle(raw, "instagram")).toBe(expected);
  });

  it.each([
    "na",
    "NA",
    "@na",
    "n/a",
    "N/A",
    "none",
    "None",
    "null",
    "nil",
    "no",
    "-",
    "...",
    ".",
    "g",
    "@j",
    "_._",
    "instagram.com/g",
    "test",
    "",
  ])("rejects the placeholder handle %j", (raw) => {
    expect(normalizeSocialHandle(raw, "instagram")).toBeUndefined();
  });
});

describe("isPlaceholderHandle", () => {
  it.each(["na", "g", "test", "-"])("flags %j", (handle) => {
    expect(isPlaceholderHandle(handle)).toBe(true);
  });

  it.each(["jo", "campos.coachpro", "testing.coach"])("doesn't flag %j", (handle) => {
    expect(isPlaceholderHandle(handle)).toBe(false);
  });
});
