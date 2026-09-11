import { describe, expect, it } from "vitest";
import {
  qualificationDashboardFromLive,
  qualificationDashboardFromSnapshot,
  type QualificationSnapshotInput,
} from "./qualification-dashboard";
import {
  bookedCallsDashboardFromLive,
  bookedCallsDashboardFromSnapshot,
  type BookedCallsSnapshotInput,
} from "./booked-dashboard";

const identity = {
  identityId: "member-1",
  identityName: "Avery",
  identityEmail: "avery@example.com",
  identityImageUrl: null,
  identityImageSource: "none",
  identitySecondaryLabel: "Setter",
  identityIsActive: true,
  identitySource: "slack",
} as const;

describe("operations report dashboard adapters", () => {
  it("maps a qualifications snapshot to the same view model used by the live dashboard", () => {
    const snapshot = {
      summary: {
        payload: {
          dailyQuota: 4,
          target: 80,
          progress: 7,
          businessDayCount: 20,
          qualifiedAfter: 100,
          qualifiedBefore: 200,
        },
      },
      openers: [
        {
          rowKey: "slack-avery",
          payload: {
            label: "Avery",
            qualified: 7,
            scheduledHours: 2,
            qualifiedPerHour: 3.5,
            lastEventAt: 150,
            ...identity,
          },
        },
      ],
    } as unknown as QualificationSnapshotInput;

    const report = qualificationDashboardFromSnapshot(snapshot);
    expect(report.error).toBeNull();
    expect(report.data).not.toBeNull();
    const data = report.data!;
    const live = qualificationDashboardFromLive({
      openers: data.openers,
      goal: data.goal,
      window: data.window,
    } as Parameters<typeof qualificationDashboardFromLive>[0]);

    expect(data).toEqual(live);
    expect(data.openers[0]?.avatar).toMatchObject({
      id: "member-1",
      name: "Avery",
      imageSource: "none",
      source: "slack",
    });
  });

  it("maps a booked-calls snapshot to the same view model used by the live dashboard", () => {
    const snapshot = {
      summary: {
        payload: {
          totalTarget: 80,
          progress: 9,
          businessDayCount: 20,
          start: 100,
          end: 200,
        },
      },
      dmClosers: [
        {
          rowKey: "closer-avery",
          payload: {
            label: "Avery",
            teamLabel: "North",
            booked: 9,
            scheduledHours: 3,
            bookedPerHour: 3,
            hourlyRateMinor: 2500,
            ...identity,
          },
        },
      ],
      teams: [
        {
          rowKey: "team-north",
          payload: {
            label: "North",
            dailyQuota: 4,
            target: 80,
            progress: 9,
          },
        },
      ],
    } as unknown as BookedCallsSnapshotInput;

    const report = bookedCallsDashboardFromSnapshot(snapshot);
    expect(report.error).toBeNull();
    expect(report.data).not.toBeNull();
    const data = report.data!;
    const live = bookedCallsDashboardFromLive({
      dmClosers: data.dmClosers,
      goal: data.goal,
      window: data.window,
    } as Parameters<typeof bookedCallsDashboardFromLive>[0]);

    expect(data).toEqual(live);
    expect(data.dmClosers[0]?.avatar).toMatchObject({
      id: "member-1",
      name: "Avery",
      imageSource: "none",
      source: "slack",
    });
  });

  it("keeps a usable fallback identity when a historical member no longer exists", () => {
    const report = qualificationDashboardFromSnapshot({
      summary: {
        payload: {
          dailyQuota: null,
          target: null,
          progress: 0,
          businessDayCount: 1,
          qualifiedAfter: 100,
          qualifiedBefore: 200,
        },
      },
      openers: [
        {
          rowKey: "departed-opener",
          payload: {
            label: "Former opener",
            qualified: 0,
            scheduledHours: null,
            qualifiedPerHour: null,
            lastEventAt: null,
          },
        },
      ],
    } as unknown as QualificationSnapshotInput);

    expect(report).toMatchObject({
      data: {
        openers: [
          {
            avatar: {
              id: "departed-opener",
              name: "Former opener",
              imageSource: "none",
              source: "unknown",
            },
          },
        ],
      },
      error: null,
    });
  });
});
