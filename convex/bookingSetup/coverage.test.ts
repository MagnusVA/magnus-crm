import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createFixture,
  PORTAL_SLUG,
  routeTeamA,
  type Fixture,
} from "../../tests/teamRoutesFixture";

async function bootstrap(fixture: Fixture) {
  return await fixture.t.query(
    internal.linkPortal.portalQueries.getPortalBootstrapForSession,
    { tenantId: fixture.tenantId, publicSlug: PORTAL_SLUG, sessionVersion: 1 },
  );
}

// Event type id -> sorted team ids, for comparing what each team gets.
async function linksByEventType(fixture: Fixture) {
  const result = await bootstrap(fixture);
  return Object.fromEntries(
    result.bookablePrograms
      .map((row) => [row.eventTypeConfigId, [...row.teamIds].sort()] as const)
      .filter(([, teamIds]) => teamIds.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function copy(
  fixture: Fixture,
  dmCloserId: Id<"dmClosers">,
  eventTypeConfigId: Id<"eventTypeConfigs">,
) {
  return fixture.t.mutation(internal.linkPortal.copyMutations.insertCopyEvent, {
    tenantId: fixture.tenantId,
    publicSlug: PORTAL_SLUG,
    sessionVersion: 1,
    sessionIdHash: "session",
    eventTypeConfigId,
    dmCloserId,
    campaignPresetId: fixture.campaignId,
  });
}

describe("booking coverage", () => {
  it("keeps every team's links the same through the migration", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);
    const before = await linksByEventType(fixture);

    await expect(
      fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {}),
    ).resolves.toBe(true);
    await expect(
      fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {}),
    ).resolves.toBe(false);

    expect(await linksByEventType(fixture)).toEqual(before);
    const coverage = await fixture.admin.query(api.bookingSetup.queries.getCoverage, {});
    expect(coverage.migrated).toBe(true);
    expect(coverage.teams.find((team) => team._id === fixture.teamA)?.usesShared).toBe(false);
    expect(coverage.teams.find((team) => team._id === fixture.teamB)?.usesShared).toBe(true);
    expect(
      coverage.sharedRoutes.map((route) => [route.mode, route.eventTypeConfigId]).sort(),
    ).toEqual(
      [
        ["extended", fixture.standardPool],
        ["normal", fixture.sharedPool],
      ].sort(),
    );
  });

  it("keeps one shared event type per cell and drops routes to hidden event types", async () => {
    const fixture = await createFixture();
    const { duplicate, hidden } = await fixture.t.run(async (ctx) => {
      const base = await ctx.db.get("eventTypeConfigs", fixture.sharedPool);
      if (!base) throw new Error("missing fixture");
      const { _id, _creationTime, ...rest } = base;
      void _id;
      void _creationTime;
      const duplicate = await ctx.db.insert("eventTypeConfigs", {
        ...rest,
        calendlyEventTypeUri: `${rest.calendlyEventTypeUri}-copy`,
        displayName: "shared-pool copy",
        createdAt: rest.createdAt - 1000,
      });
      const hidden = await ctx.db.insert("eventTypeConfigs", {
        ...rest,
        calendlyEventTypeUri: `${rest.calendlyEventTypeUri}-hidden`,
        displayName: "hidden pool",
        linkPortalEnabled: false,
      });
      await ctx.db.insert("teamProgramEventTypes", {
        tenantId: fixture.tenantId,
        teamId: fixture.teamA,
        programId: fixture.programId,
        mode: "normal",
        eventTypeConfigId: hidden,
        createdAt: 0,
        updatedAt: 0,
      });
      return { duplicate, hidden };
    });

    const plan = await fixture.t.query(
      internal.bookingSetup.queries.previewCoverageMigration,
      { tenantId: fixture.tenantId },
    );
    const normalCell = plan.sharedCells.find((cell) => cell.mode === "normal");
    expect(normalCell?.eventTypeConfigId).toBe(fixture.sharedPool);
    // poolA is unrouted here, so it was shared too; the newest edit wins.
    expect(normalCell?.dropped).toContain(duplicate);
    expect(plan.routesToRemove).toHaveLength(1);
    expect(plan.teamsNotUsingShared).toEqual([fixture.teamA]);

    await fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {});
    // Team A had only a hidden route: no links before or after.
    const links = await linksByEventType(fixture);
    expect(Object.values(links).flat()).not.toContain(fixture.teamA);
    expect(links[hidden]).toBeUndefined();
  });

  it("falls back to Shared per cell once a team uses Shared", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);
    await expect(
      fixture.admin.mutation(api.bookingSetup.mutations.setTeamUsesShared, {
        teamId: fixture.teamA,
        usesShared: true,
      }),
    ).rejects.toThrow("Open Booking setup once");
    await fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {});

    await expect(copy(fixture, fixture.dmCloserA, fixture.standardPool)).rejects.toThrow(
      "not available for this team",
    );
    await fixture.admin.mutation(api.bookingSetup.mutations.setTeamUsesShared, {
      teamId: fixture.teamA,
      usesShared: true,
    });
    // Its own Priority route wins; the empty Standard cell inherits Shared.
    await expect(copy(fixture, fixture.dmCloserA, fixture.standardPool)).resolves.toBeDefined();
    await expect(copy(fixture, fixture.dmCloserA, fixture.poolA)).resolves.toBeDefined();
    await expect(copy(fixture, fixture.dmCloserA, fixture.sharedPool)).rejects.toThrow(
      "not available for this team",
    );

    // A broken own route doesn't fall back to Shared.
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch("eventTypeConfigs", fixture.poolA, { isExtended: true });
    });
    await expect(copy(fixture, fixture.dmCloserA, fixture.sharedPool)).rejects.toThrow(
      "not available for this team",
    );
    expect((await linksByEventType(fixture))[fixture.poolA]).toBeUndefined();
  });

  it("publishes an event type by putting it in a cell", async () => {
    const fixture = await createFixture();
    await fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {});
    const unpublished = await fixture.t.run(async (ctx) => {
      const base = await ctx.db.get("eventTypeConfigs", fixture.poolA);
      if (!base) throw new Error("missing fixture");
      const { _id, _creationTime, ...rest } = base;
      void _id;
      void _creationTime;
      return await ctx.db.insert("eventTypeConfigs", {
        ...rest,
        calendlyEventTypeUri: `${rest.calendlyEventTypeUri}-new`,
        displayName: "new pool",
        linkPortalEnabled: undefined,
      });
    });

    const result = await fixture.admin.mutation(api.bookingSetup.mutations.setCell, {
      teamId: fixture.teamA,
      programId: fixture.programId,
      mode: "normal",
      eventTypeConfigId: unpublished,
    });
    expect(result.previousEventTypeConfigId).toBeNull();
    await expect(copy(fixture, fixture.dmCloserA, unpublished)).resolves.toBeDefined();
    await expect(copy(fixture, fixture.dmCloserB, unpublished)).rejects.toThrow(
      "not available for this team",
    );

    await expect(
      fixture.admin.mutation(api.bookingSetup.mutations.setCell, {
        teamId: null,
        programId: fixture.programId,
        mode: "extended",
        eventTypeConfigId: unpublished,
      }),
    ).rejects.toThrow("is a Priority event type");
    await expect(
      fixture.closer.mutation(api.bookingSetup.mutations.setCell, {
        teamId: null,
        programId: fixture.programId,
        mode: "normal",
        eventTypeConfigId: null,
      }),
    ).rejects.toThrow("Insufficient permissions");

    const cleared = await fixture.admin.mutation(api.bookingSetup.mutations.setCell, {
      teamId: fixture.teamA,
      programId: fixture.programId,
      mode: "normal",
      eventTypeConfigId: null,
    });
    expect(cleared.previousEventTypeConfigId).toBe(unpublished);
  });

  it("undoes a cleared cell back to its broken event type", async () => {
    const fixture = await createFixture();
    await routeTeamA(fixture);
    await fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {});
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch("eventTypeConfigs", fixture.poolA, { isExtended: true });
    });
    const cell = { teamId: fixture.teamA, programId: fixture.programId, mode: "normal" as const };

    const { previousEventTypeConfigId } = await fixture.admin.mutation(
      api.bookingSetup.mutations.setCell,
      { ...cell, eventTypeConfigId: null },
    );
    expect(previousEventTypeConfigId).toBe(fixture.poolA);
    await expect(
      fixture.admin.mutation(api.bookingSetup.mutations.setCell, {
        ...cell,
        eventTypeConfigId: fixture.poolA,
      }),
    ).rejects.toThrow("is a Standard event type");
    await fixture.admin.mutation(api.bookingSetup.mutations.setCell, {
      ...cell,
      eventTypeConfigId: fixture.poolA,
      restore: true,
    });
    const coverage = await fixture.admin.query(api.bookingSetup.queries.getCoverage, {});
    expect(
      coverage.teamRoutes.find((route) => route.teamId === fixture.teamA && route.mode === "normal")
        ?.eventTypeConfigId,
    ).toBe(fixture.poolA);
  });

  it("sorts an event type out as not a sales call and back", async () => {
    const fixture = await createFixture();
    await fixture.admin.mutation(api.bookingSetup.mutations.ensureCoverage, {});

    const previous = await fixture.admin.mutation(api.bookingSetup.mutations.sortEventType, {
      eventTypeConfigId: fixture.sharedPool,
      sorting: { kind: "not_sales_call" },
    });
    expect(previous).toEqual({ kind: "program", programId: fixture.programId, mode: "normal" });
    const config = await fixture.t.run((ctx) => ctx.db.get("eventTypeConfigs", fixture.sharedPool));
    expect(config).toMatchObject({ bookingProgramMappingStatus: "unmapped" });
    expect(config?.notSalesCallAt).toBeTypeOf("number");
    // Its Shared cell now points at an unmapped event type, so no team gets it.
    await expect(copy(fixture, fixture.dmCloserB, fixture.sharedPool)).rejects.toThrow(
      "Portal event type is not available.",
    );

    await fixture.admin.mutation(api.bookingSetup.mutations.sortEventType, {
      eventTypeConfigId: fixture.sharedPool,
      sorting: previous,
    });
    const restored = await fixture.t.run((ctx) => ctx.db.get("eventTypeConfigs", fixture.sharedPool));
    expect(restored).toMatchObject({
      bookingProgramMappingStatus: "mapped",
      bookingProgramId: fixture.programId,
    });
    expect(restored?.notSalesCallAt).toBeUndefined();
    await expect(copy(fixture, fixture.dmCloserB, fixture.sharedPool)).resolves.toBeDefined();
  });
});
