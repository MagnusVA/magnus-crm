import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createFixture,
  PORTAL_SLUG,
  routeTeamA,
} from "../../tests/teamRoutesFixture";

describe("team program event types", () => {
  it("validates program and mode, and rejects closers", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.admin.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.programId,
          mode: "extended",
          eventTypeConfigId: fixture.poolA,
        },
      ),
    ).rejects.toThrow("is not a Standard event type");

    await expect(
      fixture.admin.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.programId,
          mode: "normal",
          eventTypeConfigId: fixture.standardPool,
        },
      ),
    ).rejects.toThrow("is not a Priority event type");

    await expect(
      fixture.admin.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.otherProgramId,
          mode: "normal",
          eventTypeConfigId: fixture.poolA,
        },
      ),
    ).rejects.toThrow("is not mapped to");

    await expect(
      fixture.closer.mutation(
        api.attribution.teamProgramEventTypes.setTeamProgramEventType,
        {
          teamId: fixture.teamA,
          programId: fixture.programId,
          mode: "normal",
          eventTypeConfigId: fixture.poolA,
        },
      ),
    ).rejects.toThrow("Insufficient permissions");
  });

  it("shows a routed team only its event types and other teams the shared ones", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);

    const bootstrap = await fixture.t.query(
      internal.linkPortal.portalQueries.getPortalBootstrapForSession,
      { tenantId: fixture.tenantId, publicSlug: PORTAL_SLUG, sessionVersion: 1 },
    );

    const poolA = bootstrap.bookablePrograms.find(
      (row) => row.eventTypeConfigId === fixture.poolA,
    );
    const shared = bootstrap.bookablePrograms.find(
      (row) => row.eventTypeConfigId === fixture.sharedPool,
    );
    expect(poolA).toMatchObject({ teamIds: [fixture.teamA] });
    expect(shared).toMatchObject({ teamIds: [fixture.teamB] });
  });

  it("rejects copying a link for an event type the team can't use", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);

    const copy = (
      dmCloserId: Id<"dmClosers">,
      eventTypeConfigId: Id<"eventTypeConfigs">,
    ) =>
      fixture.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
        tenantId: fixture.tenantId,
        publicSlug: PORTAL_SLUG,
        sessionVersion: 1,
        sessionIdHash: "session",
        eventTypeConfigId,
        dmCloserId,
        campaignPresetId: fixture.campaignId,
      });

    await expect(copy(fixture.dmCloserA, fixture.poolA)).resolves.toBeDefined();
    await expect(copy(fixture.dmCloserA, fixture.sharedPool)).rejects.toThrow(
      "not available for this team",
    );
    await expect(copy(fixture.dmCloserB, fixture.poolA)).rejects.toThrow(
      "not available for this team",
    );
    await expect(copy(fixture.dmCloserB, fixture.sharedPool)).resolves.toBeDefined();
  });

  it("ignores a route whose event type moved to another program", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch("eventTypeConfigs", fixture.poolA, {
        bookingProgramId: fixture.otherProgramId,
      });
    });

    await expect(
      fixture.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
        tenantId: fixture.tenantId,
        publicSlug: PORTAL_SLUG,
        sessionVersion: 1,
        sessionIdHash: "session",
        eventTypeConfigId: fixture.poolA,
        dmCloserId: fixture.dmCloserA,
        campaignPresetId: fixture.campaignId,
      }),
    ).rejects.toThrow("not available for this team");
  });
});
