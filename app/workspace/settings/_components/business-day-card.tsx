"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { businessDayDisclosure, businessDayHourLabel, DEFAULT_BUSINESS_DAY, type BusinessDaySetting } from "@/lib/businessDay";
import { getErrorMessage } from "@/lib/errors";
import { FormFooter, NoteLine, SettingRow } from "./settings-ui";
import { FormCardSkeleton } from "./settings-skeleton";

/**
 * When a reporting day starts, in the Form card grammar. Saving rebuilds the
 * day totals; while that runs (or after it fails) a status line says so.
 */
export function BusinessDayCard() {
  const tenant = useQuery(api.tenants.getCurrentTenant, {});
  const retry = useMutation(api.businessDays.retryBusinessDayRebuild);
  const update = useMutation(api.businessDays.updateBusinessDay);
  const [draft, setDraft] = useState<BusinessDaySetting | null>(null);
  const [saving, setSaving] = useState(false);
  const setting = draft ?? tenant?.businessDay ?? DEFAULT_BUSINESS_DAY;
  const zones = useMemo(() => [...new Set([...Intl.supportedValuesOf("timeZone"), setting.timeZone])].sort(), [setting.timeZone]);

  if (tenant === undefined) {
    return <FormCardSkeleton label="Loading the business day" rows={2} />;
  }

  const rebuild = tenant?.businessDayRebuild;
  const rebuilding = rebuild?.state === "running";
  const failed = rebuild?.state === "failed";
  const disabled = saving || rebuilding;
  const changed = draft !== null;
  const save = async () => {
    setSaving(true);
    try { await update({ setting }); setDraft(null); toast.success("Business day saved. Day totals are being rebuilt."); }
    catch (error) { toast.error(getErrorMessage(error, "Could not save the business day.")); }
    finally { setSaving(false); }
  };
  const retryFailed = async () => {
    setSaving(true);
    try { await retry({}); toast.success("Day totals rebuild restarted."); }
    catch (error) { toast.error(getErrorMessage(error, "Could not retry the rebuild.")); }
    finally { setSaving(false); }
  };

  return (
    <section aria-labelledby="business-day-title" className={CARD}>
      <CardHead
        title={<span id="business-day-title">Business day</span>}
        meta="When a reporting day starts. Changing it rebuilds meeting and lead gen day totals."
      />
      <FieldGroup className="gap-0 divide-y divide-border">
        <SettingRow
          label="Time zone"
          htmlFor="business-day-zone"
          description="Reports, goals and day totals count days in this zone."
        >
          <Select value={setting.timeZone} onValueChange={timeZone => setDraft({ ...setting, timeZone })} disabled={disabled}>
            <SelectTrigger id="business-day-zone" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{zones.map(zone => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label="Day starts at"
          tip="A call or capture before this hour counts for the day before. Night shifts that run past midnight stay on one day."
          htmlFor="business-day-hour"
          description="The hour a new reporting day begins."
        >
          <Select value={String(setting.dayStartHour)} onValueChange={hour => setDraft({ ...setting, dayStartHour: Number(hour) })} disabled={disabled}>
            <SelectTrigger id="business-day-hour" className="w-full font-condensed text-[15px] tabular-nums"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{Array.from({ length: 24 }, (_, hour) => <SelectItem key={hour} value={String(hour)}>{businessDayHourLabel({ ...setting, dayStartHour: hour })}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </SettingRow>
      </FieldGroup>
      <div className="flex flex-col gap-2 border-t border-border px-4 py-2.5">
        <NoteLine>{businessDayDisclosure(setting)}{changed ? ", once saved." : "."}</NoteLine>
        {rebuilding ? (
          <NoteLine role="status" className="flex items-center gap-2">
            <Spinner className="size-3.5" />
            Day totals are being rebuilt after a business day change. Reports and exports will be available when it finishes.
          </NoteLine>
        ) : null}
        {failed ? (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <NoteLine tone="danger">
              Day totals rebuild failed: {rebuild.error ?? "Unknown error"}. Reports and exports remain unavailable.
            </NoteLine>
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void retryFailed()}>
              {saving ? "Retrying…" : "Retry rebuild"}
            </Button>
          </div>
        ) : null}
      </div>
      <FormFooter>
        {changed ? (
          <Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
            Discard
          </Button>
        ) : null}
        <Button
          variant={changed ? "default" : "outline"}
          className={changed ? "font-semibold" : undefined}
          disabled={disabled || !changed}
          onClick={() => void save()}
        >
          {saving && changed ? "Saving…" : "Save business day"}
        </Button>
      </FormFooter>
    </section>
  );
}
