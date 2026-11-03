import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createFixture } from "../../tests/teamRoutesFixture";

describe("enabling a DM team or DM closer", () => {
  it("refuses a duplicate of an active UTM value, even behind many disabled ones", async () => {
    const fixture = await createFixture();
    const ids = await fixture.t.run(async (ctx) => {
      const team = (slug: string, isActive: boolean) =>
        ctx.db.insert("attributionTeams", {
          tenantId: fixture.tenantId,
          slug,
          displayName: slug,
          utmSource: "dup",
          normalizedUtmSource: "dup",
          isActive,
          createdAt: 0,
          updatedAt: 0,
        });
      const closer = (slug: string, isActive: boolean) =>
        ctx.db.insert("dmClosers", {
          tenantId: fixture.tenantId,
          teamId: fixture.teamB,
          slug,
          displayName: slug,
          utmMedium: "dup",
          normalizedUtmMedium: "dup",
          isActive,
          createdAt: 0,
          updatedAt: 0,
        });
      // Six older disabled rows come first in the index, then the active one.
      for (let index = 0; index < 6; index += 1) {
        await team(`old-team-${index}`, false);
        await closer(`old-closer-${index}`, false);
      }
      const activeCloser = await closer("active-closer", true);
      await team("active-team", true);
      return {
        twinTeam: await team("twin-team", false),
        twinCloser: await closer("twin-closer", false),
        activeCloser,
      };
    });

    await expect(
      fixture.admin.mutation(api.attribution.teams.setTeamActive, { teamId: ids.twinTeam, isActive: true }),
    ).rejects.toThrow("already uses this UTM source");
    await expect(
      fixture.admin.mutation(api.attribution.dmClosers.setDmCloserActive, {
        dmCloserId: ids.twinCloser,
        isActive: true,
      }),
    ).rejects.toThrow("already uses this UTM medium");

    // Disabling the active one frees the value.
    await fixture.admin.mutation(api.attribution.dmClosers.setDmCloserActive, {
      dmCloserId: ids.activeCloser as Id<"dmClosers">,
      isActive: false,
    });
    await expect(
      fixture.admin.mutation(api.attribution.dmClosers.setDmCloserActive, {
        dmCloserId: ids.twinCloser,
        isActive: true,
      }),
    ).resolves.toBe(ids.twinCloser);
  });
});
