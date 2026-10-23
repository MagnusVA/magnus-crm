"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { businessDayDisclosure, businessDayHourLabel, DEFAULT_BUSINESS_DAY, type BusinessDaySetting } from "@/lib/businessDay";
import { getErrorMessage } from "@/lib/errors";

export function BusinessDayCard() {
  const tenant = useQuery(api.tenants.getCurrentTenant, {});
  const retry = useMutation(api.businessDays.retryBusinessDayRebuild);
  const update = useMutation(api.businessDays.updateBusinessDay);
  const [draft, setDraft] = useState<BusinessDaySetting | null>(null);
  const [saving, setSaving] = useState(false);
  const setting = draft ?? tenant?.businessDay ?? DEFAULT_BUSINESS_DAY;
  const zones = useMemo(() => [...new Set([...Intl.supportedValuesOf("timeZone"), setting.timeZone])].sort(), [setting.timeZone]);
  const rebuild = tenant?.businessDayRebuild;
  const rebuilding = rebuild?.state === "running";
  const failed = rebuild?.state === "failed";
  const disabled = saving || rebuilding || tenant === undefined;
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
  return <Card>
    <CardHeader><CardTitle>Business day</CardTitle><CardDescription>Choose when a reporting day starts. Changing it rebuilds meeting and lead gen day totals.</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      <FieldGroup>
        <Field><FieldLabel htmlFor="business-day-zone">Time zone</FieldLabel>
          <Select value={setting.timeZone} onValueChange={timeZone => setDraft({ ...setting, timeZone })} disabled={disabled}>
            <SelectTrigger id="business-day-zone"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{zones.map(zone => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        <Field><FieldLabel htmlFor="business-day-hour">Day starts at</FieldLabel>
          <Select value={String(setting.dayStartHour)} onValueChange={hour => setDraft({ ...setting, dayStartHour: Number(hour) })} disabled={disabled}>
            <SelectTrigger id="business-day-hour"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{Array.from({ length: 24 }, (_, hour) => <SelectItem key={hour} value={String(hour)}>{businessDayHourLabel({ ...setting, dayStartHour: hour })}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      <p className="text-sm text-muted-foreground">{businessDayDisclosure(setting)}</p>
      {failed && <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p className="text-destructive">Day totals rebuild failed: {rebuild.error ?? "Unknown error"}. Reports and exports remain unavailable.</p>
        <Button variant="outline" disabled={disabled} onClick={() => void retryFailed()}>{saving ? "Retrying..." : "Retry rebuild"}</Button>
      </div>}
      {rebuilding && <p role="status" className="text-sm text-muted-foreground">Day totals are being rebuilt after a business day change. Reports and exports will be available when it finishes.</p>}
    </CardContent>
    <CardFooter><Button disabled={disabled || !draft} onClick={() => void save()}>{saving ? "Saving..." : "Save business day"}</Button></CardFooter>
  </Card>;
}
