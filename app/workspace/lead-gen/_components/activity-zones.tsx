import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { BandZone, BandZones, ZonePending } from "./setter-ui";

// My activity's five figures as band zones: three a row on a phone (Leads/hr
// spanning two), five across from @xl. Shared with the skeleton.

type Summary = FunctionReturnType<typeof api.leadGen.activity.getMyActivitySummary>;

const count = (value: number) => value.toLocaleString("en-US");

function perHour(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
}

export function ActivityZones({ summary, reloading = false }: { summary: Summary | undefined; reloading?: boolean }) {
  return (
    <div className="-mx-4 @lg:-mx-[18px]">
      <BandZones label="Your figures" busy={reloading || summary === undefined} className="grid-cols-3 @xl:grid-cols-5">
        <BandZone label="Raw leads" tip="Every capture you made, repeat people included.">
          {summary ? count(summary.submissions) : <ZonePending />}
        </BandZone>
        <BandZone label="Resparks" tip="People you resparked from a Respark batch.">
          {summary ? count(summary.resparks) : <ZonePending />}
        </BandZone>
        <BandZone label="Entries" tip="Raw leads + resparks.">
          {summary ? count(summary.entries) : <ZonePending />}
        </BandZone>
        <BandZone label="Not a fit" tip="People you marked not a fit in a Respark batch. They don't count as entries.">
          {summary ? count(summary.notAFit) : <ZonePending />}
        </BandZone>
        <BandZone
          label="Leads/hr"
          className="col-span-2 @xl:col-span-1"
          tip={
            summary && summary.leadsPerHour === null
              ? "Raw leads ÷ your scheduled hours. You have no hours scheduled in this range, so there is no rate."
              : `Raw leads ÷ your scheduled hours${summary ? ` (${count(Math.round(summary.scheduledHours * 10) / 10)} h in this range)` : ""}.`
          }
        >
          {summary ? perHour(summary.leadsPerHour) : <ZonePending />}
        </BandZone>
      </BandZones>
    </div>
  );
}
