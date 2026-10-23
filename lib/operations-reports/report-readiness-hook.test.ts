// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

const fixture = vi.hoisted(() => ({
  loaded: true,
  meetingsRebuilding: true,
  leadGenRebuilding: true,
  effects: [] as Array<() => void | (() => void)>,
  request: vi.fn(async () => ({ jobId: "test-job" })),
}));

// Run the mounted hook's effects explicitly without a browser or live Convex client.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
}));
vi.mock("convex/react", () => ({
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(reference).endsWith(":requestDashboardReport") ? fixture.request : vi.fn(),
  useQuery: () => undefined,
}));
vi.mock("@/hooks/use-business-day", () => ({
  useBusinessDay: (kind: string) => ({
    loaded: fixture.loaded,
    rebuilding: kind === "lead-gen" ? fixture.leadGenRebuilding : fixture.meetingsRebuilding,
    version: 1,
  }),
}));

import { useOperationsDashboardReport, type OperationsReportKind } from "@/app/workspace/operations/_components/use-operations-report-job";

function Dashboard({ reportKind }: { reportKind: OperationsReportKind }) {
  useOperationsDashboardReport({ reportKind, range: { kind: "preset", preset: "today" }, enabled: true });
  return null;
}

async function mountDashboard(reportKind: OperationsReportKind) {
  renderToStaticMarkup(createElement(Dashboard, { reportKind }));
  for (const effect of fixture.effects) effect();
  // Drain the serialized request promise chain.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  fixture.loaded = true;
  fixture.meetingsRebuilding = true;
  fixture.leadGenRebuilding = true;
  fixture.effects = [];
  fixture.request.mockClear();
});

describe("dashboard report readiness", () => {
  it.each(["booked-calls", "qualifications"] as const)("requests %s while day buckets rebuild", async (kind) => {
    await mountDashboard(kind);
    expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ reportKind: kind }));
  });

  it.each(["sales-calls", "lead-gen"] as const)("waits for %s buckets", async (kind) => {
    await mountDashboard(kind);
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each(["sales-calls", "lead-gen"] as const)("requests %s when its own buckets are ready", async (kind) => {
    if (kind === "sales-calls") fixture.meetingsRebuilding = false;
    else fixture.leadGenRebuilding = false;
    await mountDashboard(kind);
    expect(fixture.request).toHaveBeenCalledOnce();
  });

  it.each(["booked-calls", "qualifications", "sales-calls", "lead-gen"] as const)("loads tenant settings before requesting %s", async (kind) => {
    fixture.loaded = false;
    fixture.meetingsRebuilding = false;
    fixture.leadGenRebuilding = false;
    await mountDashboard(kind);
    expect(fixture.request).not.toHaveBeenCalled();
  });
});
