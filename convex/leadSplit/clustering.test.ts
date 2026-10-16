import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  clusterMeetings,
  personKeyOf,
  possibleSamePersonPairs,
  sharedEmailKeys,
  type KeyedMeeting,
} from "./clustering";
import { answerKey, emailKey, namesCompatible, phoneKey, socialKey } from "./identityKeys";

const meetingId = (n: number) => `m${n}` as Id<"meetings">;

function meeting(n: number, keys: (string | undefined)[], name?: string): KeyedMeeting {
  return {
    meetingId: meetingId(n),
    scheduledAt: n * 1000,
    createdAt: n * 1000,
    keys: keys.filter((key): key is string => key !== undefined),
    name,
  };
}

const ids = (result: ReturnType<typeof clusterMeetings>) =>
  result.clusters.map((cluster) => cluster.meetingIds);

describe("identity keys", () => {
  it("drops placeholder values", () => {
    expect(emailKey("Email@Gmail.com")).toBeUndefined();
    expect(emailKey(" Ana@Example.org ")).toBe("email:ana@example.org");
    expect(phoneKey("+1 234-567-8910")).toBeUndefined();
    expect(phoneKey("+1 234-234-2342")).toBeUndefined();
    expect(phoneKey("(778) 955-9253")).toBe("phone:+17789559253");
    expect(socialKey("instagram", "na")).toBeUndefined();
    expect(socialKey("instagram", "@Ana.Lopez")).toBe("social:instagram:ana.lopez");
  });

  it("reads phone and handle answers by mapping or by production label", () => {
    const mappings = {
      phoneField: "Phone ",
      socialHandleField: "Your TikTok",
      socialHandleType: "tiktok" as const,
    };
    expect(answerKey({ label: "Phone", text: "7789559253" }, mappings)).toBe("phone:+17789559253");
    expect(answerKey({ label: "Your TikTok", text: "@ana" }, mappings)).toBe("social:tiktok:ana");
    expect(
      answerKey({ label: "What's your phone number? (Please include your country code)", text: "+44 7700 900123" }, undefined),
    ).toBe("phone:+447700900123");
    expect(
      answerKey({ label: "What's your Instagram username? (Example @therealbrianmark)", text: "@ana" }, undefined),
    ).toBe("social:instagram:ana");
    expect(answerKey({ label: "Intagram Handle", text: "ana" }, undefined)).toBe("social:instagram:ana");
    expect(answerKey({ label: "How did you hear about us?", text: "@ana" }, undefined)).toBeUndefined();
    expect(answerKey({ label: "Phone", fieldKey: "q_1", text: "+1 234-567-8910" }, undefined)).toBeUndefined();
  });

  it("compares names word by word", () => {
    expect(namesCompatible("Ana", "ana lópez")).toBe(true);
    expect(namesCompatible("Ana López", "Lopez, Ana")).toBe(true);
    expect(namesCompatible("Ana Lopez", "Ana Ruiz")).toBe(false);
    expect(namesCompatible("", "Ana")).toBe(false);
  });
});

describe("clusterMeetings", () => {
  it("joins meetings that share a phone or handle, never a placeholder", () => {
    const result = clusterMeetings([
      meeting(1, [emailKey("a@x.com"), phoneKey("+17789559253")]),
      meeting(2, [emailKey("b@x.com"), phoneKey("+17789559253"), socialKey("instagram", "bee")]),
      meeting(3, [emailKey("c@x.com"), socialKey("instagram", "bee")]),
      meeting(4, [emailKey("d@x.com"), phoneKey("+1 234-567-8910")]),
      meeting(5, [phoneKey("+1 234-567-8910")]),
    ]);
    expect(ids(result)).toEqual([[meetingId(1), meetingId(2), meetingId(3)], [meetingId(4)]]);
    expect(result.unattributedMeetingIds).toEqual([meetingId(5)]);
  });

  it("joins on a shared email only when nothing conflicts", () => {
    const shared = emailKey("first@x.com");
    const result = clusterMeetings([
      meeting(1, [shared, phoneKey("+17789559253")], "Ana Lopez"),
      // Same email, no other key, compatible name: the same person.
      meeting(2, [shared], "Ana"),
      // Same email, a different phone: a setter reusing the email.
      meeting(3, [shared, phoneKey("+16045550101")], "Ana Lopez"),
      // Same email and no phone, but a different name.
      meeting(4, [shared], "Bruno Diaz"),
    ]);
    expect(ids(result)).toEqual([
      [meetingId(1), meetingId(2)],
      [meetingId(3)],
      [meetingId(4)],
    ]);
    expect(sharedEmailKeys(result.clusters)).toEqual([{ key: shared, clusters: [0, 1, 2] }]);
  });

  it("tries every earlier group before leaving a shared email apart", () => {
    const shared = emailKey("first@x.com");
    const result = clusterMeetings([
      meeting(1, [shared, phoneKey("+17789559253")], "Ana"),
      meeting(2, [shared, phoneKey("+16045550101")], "Bruno"),
      // Conflicts with Ana by name, agrees with Bruno.
      meeting(3, [shared], "Bruno Diaz"),
    ]);
    expect(ids(result)).toEqual([[meetingId(1)], [meetingId(2), meetingId(3)]]);
  });

  it("orders clusters by first meeting regardless of input order", () => {
    const result = clusterMeetings([
      meeting(3, [emailKey("b@x.com")]),
      meeting(1, [emailKey("a@x.com")]),
      meeting(2, [emailKey("b@x.com")]),
    ]);
    expect(ids(result)).toEqual([[meetingId(1)], [meetingId(2), meetingId(3)]]);
    expect(result.clusters.map(personKeyOf)).toEqual(["p_m1", "p_m2"]);
  });

  it("flags clusters with no shared key whose names agree", () => {
    const result = clusterMeetings([
      meeting(1, [emailKey("a@x.com")], "Ana Lopez"),
      meeting(2, [emailKey("b@x.com")], "ana"),
      meeting(3, [emailKey("c@x.com")], "Bruno"),
    ]);
    expect(possibleSamePersonPairs(result.clusters)).toEqual([[0, 1]]);
  });
});
