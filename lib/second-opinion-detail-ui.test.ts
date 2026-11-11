// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpinionDetail } from "@/components/second-opinion/presentation";
import type { Id } from "@/convex/_generated/dataModel";

const fixture = vi.hoisted(() => ({ detail: null as OpinionDetail | null }));
vi.mock("convex/react", () => ({
  useQuery: () => fixture.detail,
  useMutation: () => async () => null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }));
vi.mock("@/hooks/use-breadcrumbs", () => ({ useBreadcrumbTrail: () => {} }));
import { SecondOpinionDetailPageClient } from "@/app/workspace/pipeline/second-opinions/_components/second-opinion-detail-page-client";

const now = Date.parse("2026-11-03T18:00Z");
const secondOpinionId = "opinion" as Id<"secondOpinions">;
function detail(): OpinionDetail {
  return {
    opinion: {
      _id: secondOpinionId,
      _creationTime: now,
      tenantId: "tenant" as Id<"tenants">,
      meetingId: "meeting" as Id<"meetings">,
      recordingId: "recording" as Id<"callRecordings">,
      closerUserId: "closer" as Id<"users">,
      trigger: "result_recorded",
      record: { kind: "lost", lossReason: "Budget" },
      inputKey: "meeting:recording",
      model: "typesafe/jev-1.13",
      status: "answered",
      attempts: 1,
      calls: 6,
      split: ["ending"],
      createdAt: now,
      answeredAt: now,
      answers: {
        attendance: { choice: "held", confidence: 0.99 },
        ending: { choice: "lost", confidence: 0.55 },
        objection: { choice: "price", confidence: 0.8 },
        claim: 0.7,
      },
      verdict: "unsure",
    },
    reviewer: undefined,
    recordingUrl: undefined,
    summary: undefined,
    person: "Grace",
    closer: "Kim",
    program: "Scale",
    scheduledAt: now,
    canAddNote: false,
    canReview: true,
    canReopen: false,
    canRerun: true,
    actionItems: [],
    timeZone: "America/Tegucigalpa",
    callbackTimeZone: "America/Tegucigalpa",
  };
}
const render = () =>
  renderToStaticMarkup(createElement(SecondOpinionDetailPageClient, { secondOpinionId }));
beforeEach(() => {
  fixture.detail = detail();
});
describe("second opinion detail page", () => {
  it("offers a rerun and explains the two readings", () => {
    const html = render();
    expect(html).toContain("Run Jev again");
    expect(html).toContain("Jev answered 6 times");
    expect(html).toContain("The two readings differed on how it ended.");
    expect(html).toContain("Held · Lost");
  });
  it("shows why a check was skipped instead of answers", () => {
    const d = fixture.detail!;
    d.opinion.status = "skipped";
    d.opinion.failure = "thin_transcript";
    d.opinion.answers = undefined;
    d.opinion.verdict = undefined;
    d.opinion.calls = undefined;
    const html = render();
    expect(html).toContain("The prospect barely speaks in the transcript");
    expect(html).toContain("Skipped");
    expect(html).toContain("Run Jev again");
    expect(html).not.toContain("Jev answered");
  });
  it("hides the rerun while Jev is checking, and on a replaced check links the newer one", () => {
    fixture.detail!.opinion.status = "queued";
    fixture.detail!.opinion.answers = undefined;
    expect(render()).toContain("Jev is checking this call.");
    expect(render()).not.toContain("Run Jev again");
    fixture.detail = detail();
    fixture.detail.canRerun = false;
    fixture.detail.opinion.supersededById = "newer" as Id<"secondOpinions">;
    const html = render();
    expect(html).toContain("A newer check replaced this one.");
    expect(html).toContain("/workspace/pipeline/second-opinions/newer");
    expect(html).not.toContain("Run Jev again");
  });
});
