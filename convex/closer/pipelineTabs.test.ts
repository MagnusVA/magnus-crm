import { describe, expect, it } from "vitest";
import { CLOSER_PIPELINE_TABS, closerPipelineTabFromSearch } from "./pipelineTabs";

// The closer pipeline's URL (docs/plans/phase-5-deal-status.md §6.2): `stage=`
// names a tab, and an old `status=` link still opens the tab its deals are on.

const tab = (search: string) => closerPipelineTabFromSearch(new URLSearchParams(search));

describe("closerPipelineTabFromSearch", () => {
  it("lists the tabs in order, without Qualified", () => {
    expect(CLOSER_PIPELINE_TABS).toEqual(["booked", "call_held", "follow_up", "won", "lost"]);
  });

  it("opens the tab `stage=` names", () => {
    for (const stage of CLOSER_PIPELINE_TABS) {
      expect(tab(`stage=${stage}`)).toBe(stage);
    }
  });

  it("maps each old status to the tab its deals are on now", () => {
    expect(tab("status=scheduled")).toBe("booked");
    expect(tab("status=follow_up_scheduled")).toBe("follow_up");
    expect(tab("status=reschedule_link_sent")).toBe("follow_up");
    expect(tab("status=payment_received")).toBe("won");
    expect(tab("status=lost")).toBe("lost");
    expect(tab("status=canceled")).toBe("lost");
    expect(tab("status=no_show")).toBe("lost");
  });

  it("opens All for Qualified, which closers have no deals at", () => {
    expect(tab("status=qualified_pending")).toBeNull();
    expect(tab("stage=qualified")).toBeNull();
  });

  it("opens All for anything else", () => {
    expect(tab("")).toBeNull();
    expect(tab("stage=all")).toBeNull();
    expect(tab("stage=scheduled")).toBeNull();
    expect(tab("stage=closed")).toBeNull();
    expect(tab("status=booked")).toBeNull();
    expect(tab("status=constructor")).toBeNull();
    expect(tab("stage=toString")).toBeNull();
  });

  it("reads `stage=` before `status=`", () => {
    expect(tab("stage=won&status=lost")).toBe("won");
    expect(tab("stage=nope&status=lost")).toBeNull();
  });
});
