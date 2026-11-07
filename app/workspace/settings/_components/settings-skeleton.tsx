import { Skeleton } from "@/components/ui/skeleton";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import { SETTINGS_TABS, SettingsBandFrame, TAB_CLASS } from "./settings-band-frame";
import { SETTINGS_ROOT } from "./settings-ui";

// Skeletons at the real heights and container steps: the band with its tabs,
// then the Integrations layout (Calendly and Slack side by side from @4xl,
// then Fathom and AI assistants, API keys under them).

function TitleRow({ width = "w-24", word = true }: { width?: string; word?: boolean }) {
  return (
    <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4 py-2">
      <Skeleton className={cn("h-4", width)} />
      {word ? <Skeleton className="ml-auto h-3.5 w-20" /> : null}
    </div>
  );
}

function FactRows({ count }: { count: number }) {
  return (
    <div className="border-b border-border py-1">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      ))}
    </div>
  );
}

/** A Calendly or Slack card: title row, fact groups, the 40px action row. */
export function IntegrationCardSkeleton({ label, groups = [2, 1, 2] }: { label: string; groups?: number[] }) {
  return (
    <div role="status" aria-label={label} className={CARD}>
      <TitleRow />
      {groups.map((count, index) => (
        <FactRows key={index} count={count} />
      ))}
      <div className="flex min-h-10 items-center gap-1.5 px-4 py-1.5">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-24" />
      </div>
    </div>
  );
}

export function ApiKeysCardSkeleton() {
  return (
    <div role="status" aria-label="Loading API keys" className={CARD}>
      <TitleRow word={false} />
      <div className="border-b border-border px-4 py-2.5">
        <Skeleton className="h-3.5 w-full max-w-[640px]" />
      </div>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex h-11 items-center gap-4 border-b border-border px-4 last:border-b-0">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A form card: title row, ruled field rows, the paper footer. */
export function FormCardSkeleton({ label, rows, id }: { label: string; rows: number; id?: string }) {
  return (
    <div id={id} role="status" aria-label={label} className={cn(CARD, id && "scroll-mt-20")}>
      <TitleRow width="w-36" word={false} />
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid gap-1.5 px-4 py-3 @lg:grid-cols-[7.5rem_minmax(0,1fr)] @lg:gap-x-3 @4xl:grid-cols-[7.5rem_minmax(0,20rem)_minmax(0,1fr)] @4xl:gap-x-5">
            <Skeleton className="h-3.5 w-20 @lg:mt-2.5" />
            <Skeleton className="h-8 w-full max-w-64" />
            <Skeleton className="h-3.5 w-56 max-w-full @lg:col-start-2 @4xl:col-start-3 @4xl:row-start-1 @4xl:mt-2.5" />
          </div>
        ))}
      </div>
      <div className="flex justify-end border-t border-border bg-background px-4 py-3">
        <Skeleton className="h-8 w-32" />
      </div>
    </div>
  );
}

export function IntegrationsSkeleton() {
  return (
    <div className="grid gap-3.5 @4xl:grid-cols-2 @4xl:items-start">
      <IntegrationCardSkeleton label="Loading Calendly connection" />
      <IntegrationCardSkeleton label="Loading Slack integration" groups={[2, 5]} />
      <IntegrationCardSkeleton label="Loading Fathom connection" groups={[3, 2]} />
      <IntegrationCardSkeleton label="Loading AI assistant settings" groups={[3]} />
      <div className="@4xl:col-span-2">
        <ApiKeysCardSkeleton />
      </div>
    </div>
  );
}

export function SettingsPageSkeleton() {
  return (
    <div className={SETTINGS_ROOT} role="status" aria-label="Loading settings">
      <SettingsBandFrame
        tabs={SETTINGS_TABS.map((tab, index) => (
          <span key={tab.value} aria-current={index === 0 ? "page" : undefined} className={TAB_CLASS}>
            {tab.label}
          </span>
        ))}
      />
      <IntegrationsSkeleton />
    </div>
  );
}
