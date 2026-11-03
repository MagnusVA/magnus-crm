import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { createFixture } from "../../tests/teamRoutesFixture";

describe("enabling a DM team or DM closer", () => {
  it("refuses a duplicate of an active UTM value, and allows a unique one", async () => {
    const fixture = await createFixture();
    const { twinTeam, twinCloser } = await fixture.t.run(async (ctx) => {
      const twinTeam = await ctx.db.insert("attributionTeams", {
        tenantId: fixture.tenantId,
        slug: "team-a-old",
        displayName: "Team A (old)",
        utmSource: "team-a",
        normalizedUtmSource: "team-a",
        isActive: false,
        createdAt: 0,
        updatedAt: 0,
      });
      const twinCloser = await ctx.db.insert("dmClosers", {
        tenantId: fixture.tenantId,
        teamId: fixture.teamB,
        slug: "dm-a-old",
        displayName: "dm-a old",
        utmMedium: "dm-a",
        normalizedUtmMedium: "dm-a",
        isActive: false,
        createdAt: 0,
        updatedAt: 0,
      });
      return { twinTeam, twinCloser };
    });

    await expect(
      fixture.admin.mutation(api.attribution.teams.setTeamActive, { teamId: twinTeam, isActive: true }),
    ).rejects.toThrow("already uses this UTM source");
    await expect(
      fixture.admin.mutation(api.attribution.dmClosers.setDmCloserActive, { dmCloserId: twinCloser, isActive: true }),
    ).rejects.toThrow("already uses this UTM medium");

    // Disabling the active one frees the value.
    await fixture.admin.mutation(api.attribution.dmClosers.setDmCloserActive, {
      dmCloserId: fixture.dmCloserA,
      isActive: false,
    });
    await expect(
      fixture.admin.mutation(api.attribution.dmClosers.setDmCloserActive, { dmCloserId: twinCloser, isActive: true }),
    ).resolves.toBe(twinCloser);
  });
});
