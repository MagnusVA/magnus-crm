import { describe, expect, it } from "vitest";
import {
  buildInboxCards,
  familyKey,
  familyLabel,
  lookalikeGroups,
  modeWarning,
  nameSimilarity,
  paletteMatch,
  personInName,
  suggestDestination,
  type IntelEventType,
  type IntelProgram,
} from "./event-type-intel";

const programs: IntelProgram[] = [
  { id: "p25k", name: "25K Accelerator" },
  { id: "p5k", name: "5K accelerator" },
  { id: "pgive", name: "Giveaways" },
  { id: "pvip", name: "VIP" },
];

let next = 0;
function et(name: string, overrides: Partial<IntelEventType> = {}): IntelEventType {
  next += 1;
  return {
    id: `e${next}`,
    name,
    durationMinutes: 45,
    poolingType: "round_robin",
    kind: "solo",
    formQuestionCount: 9,
    status: "unsorted",
    mode: "normal",
    bookings30d: 0,
    ...overrides,
  };
}

const filed = [
  et("🟢 The Complete Strategy Meeting W/ PT-Domination", { status: "sorted", programId: "p25k", bookings30d: 64, inUse: true }),
  et("The Complete Strategy Meeting W/ PT-Domination Extended", { status: "sorted", programId: "p25k", bookings30d: 96, inUse: true }),
  et("Complete Strategy Meeting With PT-Domination", { status: "sorted", programId: "p25k", mode: "extended", bookings30d: 52, inUse: true }),
  et("Kick Start your Online Fitness Business with PT Dom", { status: "sorted", programId: "p5k", durationMinutes: 30, bookings30d: 71, inUse: true }),
];

describe("names", () => {
  it("drops emoji, case, punctuation, the brand, Copy of and Extended", () => {
    expect(familyKey("🔴 The Complete Strategy Meeting W/ PT-Dom🔴")).toBe("complete strategy meeting");
    expect(familyKey("Copy of The Complete Strategy Meeting W/ PT-Domination")).toBe("complete strategy meeting");
    expect(familyKey("Complete Strategy Meeting With PT-Domination.")).toBe("complete strategy meeting");
    expect(familyKey("The Complete Strategy Meeting W/ PT-Domination Extended")).toBe("complete strategy meeting");
    expect(familyLabel("The Complete Strategy Meeting W/ PT-Domination Extended")).toBe("Complete Strategy Meeting");
  });

  it("treats a truncated word as the same word", () => {
    expect(nameSimilarity("PT-Dom High Performance Content Strategy Meet", "PT-Dom High Performance Content Strategy Meeting")).toBe(1);
    expect(nameSimilarity("Strategy Meeting With PT-Dom", "Complete Strategy Meeting With PT-Domination")).toBeLessThan(0.75);
  });

  it("spots a person's name", () => {
    expect(personInName("Claudio — 15 min")).toBe("Claudio");
    expect(personInName("Jorge's Personal Calendar")).toBe("Jorge");
    expect(personInName("Strategy Session – VIP Inner Circle")).toBeNull();
    expect(personInName("Closer-1-Meeting")).toBeNull();
  });

  it("matches the palette by word starts and abbreviations", () => {
    expect(paletteMatch("give std", "Giveaways · Standard")).toBe(true);
    expect(paletteMatch("25k pri", "25K Accelerator · Priority")).toBe(true);
    expect(paletteMatch("vip std", "Giveaways · Standard")).toBe(false);
  });
});

describe("suggestDestination", () => {
  it("files a look-alike under its twins' program, with reasons", () => {
    const target = et("🔴 The Complete Strategy Meeting W/ PT-Dom🔴");
    const { best, alternatives } = suggestDestination(target, programs, [...filed, target]);
    expect(best).toMatchObject({ kind: "program", programId: "p25k", mode: "normal", strength: "strong" });
    expect(best?.reasons.join(" ")).toMatch(/already on 25K Accelerator/);
    expect(best?.reasons.join(" ")).toMatch(/45-minute round robin/);
    expect(alternatives[0]).toEqual({ kind: "program", programId: "p25k", mode: "extended" });
  });

  it("reads Extended in the name as Standard", () => {
    const target = et("Kick Start your Online Fitness Business Extended", { durationMinutes: 30 });
    const { best } = suggestDestination(target, programs, [...filed, target]);
    expect(best).toMatchObject({ kind: "program", programId: "p5k", mode: "extended" });
  });

  it("matches a program's name in the event type's name", () => {
    const target = et("Giveaway Winner Call", { durationMinutes: 20 });
    const named = et("Giveaways Winner Call");
    expect(suggestDestination(named, programs, [named]).best).toMatchObject({ kind: "program", programId: "pgive" });
    // "Giveaway" alone shares a word with "Giveaways" only as a truncation, so no match.
    expect(suggestDestination(target, programs, [target]).best?.kind).not.toBe("program");
  });

  it("calls a one-host calendar named after a person a personal calendar", () => {
    const target = et("Claudio — 15 min", { poolingType: undefined, durationMinutes: 15 });
    const { best } = suggestDestination(target, programs, [...filed, target]);
    expect(best).toMatchObject({ kind: "not_sales_call", reason: "personal", strength: "strong" });
  });

  it("flags a copy as a duplicate of its original", () => {
    const target = et("Copy of The Complete Strategy Meeting W/ PT-Domination");
    const { best, alternatives } = suggestDestination(target, programs, [...filed, target]);
    expect(best).toMatchObject({ kind: "not_sales_call", reason: "duplicate", duplicateOfId: filed[0].id });
    expect(alternatives).toContainEqual({ kind: "program", programId: "p25k", mode: "normal" });
  });

  it("suggests nothing when nothing points anywhere", () => {
    const target = et("Doms Dms");
    expect(suggestDestination(target, programs, [target]).best).toBeNull();
  });
});

describe("buildInboxCards", () => {
  it("stacks personal calendars into one card", () => {
    const personal = ["Ana — 30 min", "Bo's calendar", "Cole — 15 min"].map((name) =>
      et(name, { poolingType: undefined, durationMinutes: 30 }),
    );
    const target = et("🔴 The Complete Strategy Meeting W/ PT-Dom🔴");
    const cards = buildInboxCards([...personal, target], programs, [...filed, ...personal, target]);
    const stack = cards.find((card) => card.stackLabel);
    expect(stack?.stackLabel).toBe("3 personal calendars");
    expect(stack?.eventTypes).toHaveLength(3);
    expect(cards).toHaveLength(2);
  });
});

describe("lookalikeGroups", () => {
  it("groups look-alikes and folds unused copies into an in-use twin", () => {
    const copy = et("Complete Strategy Meeting With PT-Domination.", { status: "sorted", programId: "p25k", mode: "extended", bookings30d: 2 });
    const groups = lookalikeGroups([...filed, copy]);
    const group = groups.find((candidate) => candidate.label === "Complete Strategy Meeting");
    expect(group?.members).toHaveLength(4);
    expect(group?.foldable.map((member) => member.eventType.id)).toEqual([copy.id]);
    expect(group?.foldable[0].foldInto?.id).toBe(filed[2].id);
  });
});

describe("modeWarning", () => {
  it("warns when the name says Extended but the mode is Priority", () => {
    expect(modeWarning(filed[1])).toBe("Name says “Extended” but the mode is Priority");
    expect(modeWarning(filed[2])).toBeNull();
  });
});
