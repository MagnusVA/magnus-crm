"use client";

import { useId, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import {
  ActionRow,
  NoteLine,
  SettingRow,
  StatusWord,
} from "@/app/workspace/settings/_components/settings-ui";
import {
  CARD,
  CardHead,
  FIGURE,
} from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";
import {
  callCount,
  checkResultWords,
  checkWarning,
  formatUsd,
  type CheckResult,
} from "@/lib/callInsights/report-display";
import { cn } from "@/lib/utils";
import type { CallInsightsSettingsView } from "./call-insights-page-client";
import type { ConfirmRequest } from "./confirm-dialog";

const ConfirmDialog = dynamic(() => import("./confirm-dialog"));

type Settings = NonNullable<CallInsightsSettingsView["settings"]>;
type Patch = {
  mode?: "off" | "shadow" | "on";
  suggestions?: "off" | "hidden" | "on";
  amountPrefill?: boolean;
  noShowCertain?: boolean;
  noShowWaitMinutes?: number | null;
  monthlyCapUsd?: number;
  evalMonthlyUsd?: number;
  itemCheck?: boolean;
};
/** The four switches whose quality bars the Quality tab grades. */
type Capability =
  | "whatTheySaid"
  | "suggestions"
  | "amountPrefill"
  | "noShowCertain";

const GATEWAY_WARNING =
  "Check that the AI Gateway usage limit in the Convex dashboard is unset or well above your monthly limit. Reaching that limit pauses the whole app.";

/**
 * Call insights' own settings: turning it on, who sees what, the monthly
 * limit it shares with Second opinion, reading older calls, and turning it
 * off. Each control saves on its own.
 */
export function SettingsTab({
  view,
  onOpenQuality,
}: {
  view: CallInsightsSettingsView;
  onOpenQuality: () => void;
}) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  return (
    <div className="flex flex-col gap-3.5 short:gap-3">
      {view.enabled && view.settings ? (
        <>
          <OnCard
            view={view}
            settings={view.settings}
            onConfirm={setConfirm}
            onOpenQuality={onOpenQuality}
          />
          <OlderCallsCard view={view} />
          <TurnOffCard onConfirm={setConfirm} />
        </>
      ) : (
        <OffCard view={view} onConfirm={setConfirm} />
      )}
      {confirm ? (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      ) : null}
    </div>
  );
}

// ─── Off ─────────────────────────────────────────────────────────────────────

function OffCard({
  view,
  onConfirm,
}: {
  view: CallInsightsSettingsView;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const enable = useMutation(api.callInsights.admin.enable);
  const cap = view.settings?.monthlyCapUsd ?? view.defaults.monthlyCapUsd;
  return (
    <section aria-labelledby="call-insights-off-title" className={CARD}>
      <CardHead title={<span id="call-insights-off-title">Call insights</span>}>
        <StatusWord tone="muted">Off</StatusWord>
      </CardHead>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <NoteLine tone="ok">
          Turning it on reads each recorded sales call once its Fathom recording
          is matched.
        </NoteLine>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] leading-[1.45] text-muted-foreground">
          <li>
            Claude reads the calls through Convex&apos;s AI Gateway. The
            provider keeps no data.
          </li>
          <li>
            Only owners and admins see what it found until you choose otherwise.
          </li>
          <li>
            It costs about 3 to 12 cents a call, inside a monthly limit of{" "}
            {formatUsd(cap)} that Second opinion shares.
          </li>
        </ul>
      </div>
      <ActionRow>
        <Button
          type="button"
          size="sm"
          className="font-semibold"
          onClick={() =>
            onConfirm({
              title: "Turn on Call insights?",
              description:
                "New calls are read once their recording is matched. Owners and admins see the results.",
              warning: GATEWAY_WARNING,
              confirmLabel: "Turn on Call insights",
              pendingLabel: "Turning on…",
              run: async () => {
                await enable({});
                toast.success("Call insights is on.");
              },
            })
          }
        >
          Turn on Call insights
        </Button>
      </ActionRow>
    </section>
  );
}

// ─── On ──────────────────────────────────────────────────────────────────────

function OnCard({
  view,
  settings,
  onConfirm,
  onOpenQuality,
}: {
  view: CallInsightsSettingsView;
  settings: Settings;
  onConfirm: (request: ConfirmRequest) => void;
  onOpenQuality: () => void;
}) {
  const ids = useId();
  const update = useMutation(api.callInsights.admin.updateSettings);
  const { isAuthenticated } = useConvexAuth();
  const status = useQuery(
    api.callInsights.eval.reports.capabilityStatus,
    isAuthenticated ? {} : "skip",
  );
  const [saving, setSaving] = useState<keyof Patch | null>(null);

  const checks: Partial<Record<Capability, CheckResult>> = {};
  for (const capability of status?.capabilities ?? [])
    checks[capability.key as Capability] = capability.result;

  const save = async (key: keyof Patch, patch: Patch) => {
    setSaving(key);
    try {
      await update(patch);
      return true;
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't save the setting."));
      return false;
    } finally {
      setSaving(null);
    }
  };

  /** Turning on a graded switch asks first, and says so when its checks haven't passed. */
  const confirmOn = (
    key: keyof Patch,
    patch: Patch,
    capability: Capability,
    copy: { title: string; description: string; confirmLabel: string },
  ) =>
    onConfirm({
      ...copy,
      note: checkWarning(checks[capability]),
      pendingLabel: "Saving…",
      run: async () => {
        setSaving(key);
        try {
          await update(patch);
        } finally {
          setSaving(null);
        }
      },
    });

  const busy = saving !== null;
  const badge = (capability: Capability) => (
    <CheckBadge
      result={
        status === undefined
          ? undefined
          : (checks[capability] ?? "inconclusive")
      }
      onOpenQuality={onOpenQuality}
    />
  );
  const pendingMark = (key: keyof Patch) =>
    saving === key ? (
      <Spinner className="size-4 text-muted-foreground" aria-label="Saving" />
    ) : null;

  const waitSet = settings.noShowWaitMinutes !== undefined;
  const { budget } = view;

  return (
    <section aria-labelledby="call-insights-on-title" className={CARD}>
      <CardHead title={<span id="call-insights-on-title">Call insights</span>}>
        <StatusWord tone="ok">
          {settings.mode === "on"
            ? "On for closers too"
            : "On for owners and admins"}
        </StatusWord>
      </CardHead>
      <FieldGroup className="gap-0 divide-y divide-border">
        <SettingRow
          label="Who sees What they said"
          htmlFor={`${ids}-mode`}
          description="Closers see it on their own calls straight away, before they save the result."
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Select
              value={settings.mode === "on" ? "on" : "shadow"}
              disabled={busy}
              onValueChange={(next) => {
                if (next === "on") {
                  confirmOn("mode", { mode: "on" }, "whatTheySaid", {
                    title: "Show What they said to closers?",
                    description:
                      "Closers see what prospects said on their own calls, before they save the result.",
                    confirmLabel: "Show to closers",
                  });
                } else void save("mode", { mode: "shadow" });
              }}
            >
              <SelectTrigger id={`${ids}-mode`} className="w-60 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="shadow">Owners and admins</SelectItem>
                  <SelectItem value="on">
                    Closers too, on their own calls
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {pendingMark("mode")}
            {badge("whatTheySaid")}
          </div>
        </SettingRow>

        <SettingRow
          label="Suggested results"
          htmlFor={`${ids}-suggestions`}
          description="In the background they're stored and graded but shown on no meeting. Shown, everyone who can open the meeting sees one until a result is saved."
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Select
              value={settings.suggestions}
              disabled={busy}
              onValueChange={(next) => {
                const value = next as Settings["suggestions"];
                if (value === "on") {
                  confirmOn(
                    "suggestions",
                    { suggestions: "on" },
                    "suggestions",
                    {
                      title: "Show suggested results on meetings?",
                      description:
                        "Everyone who can open a meeting sees the suggested result until a result is saved. A person still confirms every save.",
                      confirmLabel: "Show on meetings",
                    },
                  );
                } else void save("suggestions", { suggestions: value });
              }}
            >
              <SelectTrigger
                id={`${ids}-suggestions`}
                className="w-60 max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="hidden">
                    Checked in the background
                  </SelectItem>
                  <SelectItem value="on">Shown on meetings</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {pendingMark("suggestions")}
            {badge("suggestions")}
          </div>
        </SettingRow>

        <SettingRow
          label="Fill the payment amount from the call"
          htmlFor={`${ids}-amount`}
          description="Off, the amount heard shows as a hint and the person types it."
        >
          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
            <Switch
              id={`${ids}-amount`}
              checked={settings.amountPrefill}
              disabled={busy}
              onCheckedChange={(on) => {
                if (on) {
                  confirmOn(
                    "amountPrefill",
                    { amountPrefill: true },
                    "amountPrefill",
                    {
                      title: "Fill the payment amount from the call?",
                      description:
                        "The payment form starts with the amount heard on the call. The person can change it.",
                      confirmLabel: "Fill the amount",
                    },
                  );
                } else void save("amountPrefill", { amountPrefill: false });
              }}
            />
            {pendingMark("amountPrefill")}
            {badge("amountPrefill")}
          </div>
        </SettingRow>

        <SettingRow
          label="One-step confirm for clear no-shows"
          htmlFor={`${ids}-certain`}
          description={
            waitSet
              ? "A clear no-show still needs one person's confirm. Off, it reads as Review."
              : "Decide the wait first."
          }
        >
          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
            <Switch
              id={`${ids}-certain`}
              checked={settings.noShowCertain}
              disabled={busy || (!waitSet && !settings.noShowCertain)}
              onCheckedChange={(on) => {
                if (on) {
                  confirmOn(
                    "noShowCertain",
                    { noShowCertain: true },
                    "noShowCertain",
                    {
                      title: "Turn on the one-step no-show confirm?",
                      description:
                        "When only the closer is heard past the wait, the no-show asks for one confirm. A person still saves it.",
                      confirmLabel: "Turn on",
                    },
                  );
                } else void save("noShowCertain", { noShowCertain: false });
              }}
            />
            {pendingMark("noShowCertain")}
            {badge("noShowCertain")}
          </div>
        </SettingRow>

        <SettingRow
          label="The wait before a no-show can be clear"
          htmlFor={`${ids}-wait`}
          description="How long the closer must have waited. Until it's decided, no call is a clear no-show."
        >
          <div className="flex items-center gap-3">
            <Select
              value={
                settings.noShowWaitMinutes === undefined
                  ? "none"
                  : String(settings.noShowWaitMinutes)
              }
              disabled={busy}
              onValueChange={(next) =>
                void save("noShowWaitMinutes", {
                  noShowWaitMinutes: next === "none" ? null : Number(next),
                })
              }
            >
              <SelectTrigger id={`${ids}-wait`} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="none">Not decided</SelectItem>
                  <SelectItem value="5">5 minutes</SelectItem>
                  <SelectItem value="7">7 minutes</SelectItem>
                  <SelectItem value="10">10 minutes</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            {pendingMark("noShowWaitMinutes")}
          </div>
        </SettingRow>

        <SettingRow
          label="Jev checks each item"
          htmlFor={`${ids}-check`}
          description="Jev confirms each item against the lines it came from and hides the ones it rejects."
        >
          <div className="flex min-h-8 items-center gap-3">
            <Switch
              id={`${ids}-check`}
              checked={settings.itemCheck}
              disabled={busy}
              onCheckedChange={(on) =>
                void save("itemCheck", { itemCheck: on })
              }
            />
            {pendingMark("itemCheck")}
          </div>
        </SettingRow>

        <SettingRow
          label="Monthly limit for all model calls"
          htmlFor={`${ids}-cap`}
          description={
            <>
              Second opinion keeps {formatUsd(budget.secondOpinionShareUsd)} of
              the {formatUsd(budget.capUsd)}. Call insights can use{" "}
              {formatUsd(budget.limitUsd)} this month:{" "}
              {formatUsd(budget.spentUsd)} spent,{" "}
              {formatUsd(budget.reservedUsd)} reserved.
              {budget.limitUsd <= 0 ? (
                <span className="mt-1 block text-warning-ink">
                  Second opinion&apos;s own limit uses the whole monthly limit.
                  Lower it in Second opinion&apos;s settings or raise this
                  limit.
                </span>
              ) : null}
              <span className="mt-1 block">
                {view.waiting === 0
                  ? "No call is waiting for room."
                  : `${callCount(view.waiting)} ${view.waiting === 1 ? "is" : "are"} waiting for room under the limit.`}
              </span>
            </>
          }
        >
          <AmountField
            id={`${ids}-cap`}
            value={settings.monthlyCapUsd}
            disabled={busy}
            pending={saving === "monthlyCapUsd"}
            validate={(amount) =>
              amount < 1 || amount > 10_000
                ? "Enter an amount from $1 to $10,000."
                : null
            }
            onSave={(amount) =>
              save("monthlyCapUsd", { monthlyCapUsd: amount })
            }
          />
        </SettingRow>

        <SettingRow
          label="Evals allowance"
          htmlFor={`${ids}-evals`}
          description={`The most quality checks may spend a month, inside the limit. ${formatUsd(budget.evalSpentUsd)} of ${formatUsd(budget.evalCapUsd)} spent this month.`}
        >
          <AmountField
            id={`${ids}-evals`}
            value={settings.evalMonthlyUsd}
            disabled={busy}
            pending={saving === "evalMonthlyUsd"}
            validate={(amount) =>
              amount < 0 || amount > settings.monthlyCapUsd
                ? `Enter an amount from $0 to the monthly limit, ${formatUsd(settings.monthlyCapUsd)}.`
                : null
            }
            onSave={(amount) =>
              save("evalMonthlyUsd", { evalMonthlyUsd: amount })
            }
          />
        </SettingRow>
      </FieldGroup>
    </section>
  );
}

/** A switch's quality checks as a small chip, with the way to the Quality tab. */
function CheckBadge({
  result,
  onOpenQuality,
}: {
  result: CheckResult | undefined;
  onOpenQuality: () => void;
}) {
  if (result === undefined) return null;
  return (
    <span className="inline-flex items-center gap-2 text-[13px]">
      <span
        className={cn(
          "inline-flex h-5 items-center rounded-[4px] px-1.5 text-xs font-semibold whitespace-nowrap",
          result === "pass" && "bg-muted text-foreground",
          result === "fail" && "bg-destructive/10 text-danger-ink",
          result === "inconclusive" && "bg-muted text-muted-foreground",
        )}
      >
        {checkResultWords(result)}
      </span>
      <a
        href="?tab=quality"
        className="rounded-sm text-muted-foreground underline decoration-muted-foreground/40 underline-offset-[3px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            event.button !== 0
          )
            return;
          event.preventDefault();
          onOpenQuality();
        }}
      >
        Quality
      </a>
    </span>
  );
}

/** A USD amount that saves on its own button once it changes. */
function AmountField({
  id,
  value,
  disabled,
  pending,
  validate,
  onSave,
}: {
  id: string;
  value: number;
  disabled: boolean;
  pending: boolean;
  validate: (amount: number) => string | null;
  /** Resolves true once saved; a failure keeps the draft. */
  onSave: (amount: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);
  const amount = Number(text);
  const error =
    draft === null
      ? null
      : text.trim() === "" || !Number.isFinite(amount)
        ? "Enter an amount."
        : validate(amount);
  const changed = draft !== null && amount !== value;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">
            $
          </span>
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min={0}
            step="1"
            value={text}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && changed && !error) {
                event.preventDefault();
                void onSave(amount).then((saved) => saved && setDraft(null));
              }
            }}
            className={cn(FIGURE, "w-28 pl-6")}
          />
        </div>
        {changed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || error !== null}
            onClick={() =>
              void onSave(amount).then((saved) => saved && setDraft(null))
            }
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-[13px] text-danger-ink">{error}</p> : null}
    </div>
  );
}

// ─── Older calls ─────────────────────────────────────────────────────────────

function OlderCallsCard({ view }: { view: CallInsightsSettingsView }) {
  const ids = useId();
  const [scope, setScope] = useState<"unread" | "unread_and_outdated">(
    "unread",
  );
  const { isAuthenticated } = useConvexAuth();
  const preview = useQuery(
    api.callInsights.queries.backfillPreview,
    isAuthenticated ? { scope } : "skip",
  );
  const start = useMutation(api.callInsights.admin.startBackfill);
  const [ceilingDraft, setCeilingDraft] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const format = useLocalFormat();
  const cap = view.settings?.monthlyCapUsd ?? view.budget.capUsd;
  const job = view.job?.status === "running" ? view.job : null;

  const suggested = preview
    ? Math.min(cap, Math.max(1, Math.ceil(preview.estimateUsd * 1.25)))
    : 1;
  const ceilingText = ceilingDraft ?? String(suggested);
  const ceiling = Number(ceilingText);
  const ceilingError =
    ceilingText.trim() === "" ||
    !Number.isFinite(ceiling) ||
    ceiling < 1 ||
    ceiling > cap
      ? `Enter an amount from $1 to the monthly limit, ${formatUsd(cap)}.`
      : null;

  const startJob = async () => {
    setStarting(true);
    try {
      await start({ scope, ceilingUsd: ceiling });
      setCeilingDraft(null);
      toast.success("Reading older calls.");
    } catch (error) {
      toast.error(
        getErrorMessage(error, "Couldn't start reading older calls."),
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <section aria-labelledby={`${ids}-title`} className={CARD}>
      <CardHead
        title={<span id={`${ids}-title`}>Read older calls</span>}
        meta="Calls matched before Call insights was on"
      />
      {job ? (
        <JobProgress job={job} />
      ) : (
        <>
          <div className="border-b border-border px-4 py-3">
            <RadioGroup
              value={scope}
              onValueChange={(next) => setScope(next as typeof scope)}
              aria-label="Which calls"
              className="gap-2"
            >
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="unread" id={`${ids}-unread`} />
                Only calls never read
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem
                  value="unread_and_outdated"
                  id={`${ids}-outdated`}
                />
                Also calls read with an older version
              </label>
            </RadioGroup>
          </div>
          {preview === undefined ? (
            <div
              role="status"
              aria-label="Counting older calls"
              className="px-4 py-3"
            >
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : preview === null ? (
            <div className="px-4 py-3">
              <NoteLine>Turn Call insights on to read older calls.</NoteLine>
            </div>
          ) : (
            <dl className="border-b border-border py-1">
              <PreviewFact label="Calls to read">
                <span className={FIGURE}>{preview.total}</span>
                {scope === "unread_and_outdated" ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {preview.unread} never read · {preview.outdated} older
                    version
                  </span>
                ) : null}
                {preview.capped ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · counted up to a limit, there may be more
                  </span>
                ) : null}
              </PreviewFact>
              <PreviewFact label="Estimated cost">
                <span className={FIGURE}>{formatUsd(preview.estimateUsd)}</span>
              </PreviewFact>
              <PreviewFact label="Soonest expiry">
                {preview.soonestExpiryAt === null ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  <>
                    <span className={FIGURE}>
                      {format(preview.soonestExpiryAt, "MMM d")}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      · Fathom deletes transcripts after 90 days
                    </span>
                  </>
                )}
              </PreviewFact>
              {preview.expired > 0 ? (
                <PreviewFact label="Left out">
                  {callCount(preview.expired)} whose transcript is gone
                </PreviewFact>
              ) : null}
            </dl>
          )}
          {preview ? (
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`${ids}-ceiling`}
                  className="text-[13px] text-muted-foreground"
                >
                  Stop at (USD)
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">
                      $
                    </span>
                    <Input
                      id={`${ids}-ceiling`}
                      type="number"
                      inputMode="decimal"
                      min={1}
                      max={cap}
                      step="1"
                      value={ceilingText}
                      disabled={starting}
                      aria-invalid={ceilingError ? true : undefined}
                      onChange={(event) => setCeilingDraft(event.target.value)}
                      className={cn(FIGURE, "w-28 pl-6")}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      starting || preview.total === 0 || ceilingError !== null
                    }
                    onClick={() => void startJob()}
                  >
                    {starting ? <Spinner data-icon="inline-start" /> : null}
                    {starting ? "Starting…" : "Start"}
                  </Button>
                </div>
                {ceilingError ? (
                  <p className="text-[13px] text-danger-ink">{ceilingError}</p>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    {preview.total === 0
                      ? "No older call needs reading."
                      : "Reading stops when it reaches this amount. It also counts toward the monthly limit."}
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function PreviewFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[7.5rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

const JOB_WORDS: Record<
  NonNullable<CallInsightsSettingsView["job"]>["kind"],
  string
> = {
  backfill: "Reading older calls",
  rerun: "Reading calls again",
  eval_judge: "Quality check: grading calls",
  eval_regression: "Quality check: reading calls again",
};

function JobProgress({
  job,
}: {
  job: NonNullable<CallInsightsSettingsView["job"]>;
}) {
  const cancel = useMutation(api.callInsights.admin.cancelJob);
  const [canceling, setCanceling] = useState(false);
  const finished = job.done + job.failed + job.skipped;
  const share = (count: number) =>
    job.total > 0 ? `${(count / job.total) * 100}%` : "0%";

  const cancelJob = async (jobId: Id<"callInsightJobs">) => {
    setCanceling(true);
    try {
      await cancel({ jobId });
      toast.success("Canceled. Calls already started may still finish.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't cancel the job."));
    } finally {
      setCanceling(false);
    }
  };

  return (
    <>
      <div
        className="flex flex-col gap-2 border-b border-border px-4 py-3"
        aria-live="polite"
      >
        <p className="text-sm font-medium">
          {JOB_WORDS[job.kind]} · <span className={FIGURE}>{finished}</span> of{" "}
          <span className={FIGURE}>{job.total}</span>
        </p>
        <div
          role="progressbar"
          aria-label={JOB_WORDS[job.kind]}
          aria-valuemin={0}
          aria-valuemax={job.total}
          aria-valuenow={finished}
          className="flex h-2 overflow-hidden rounded-[3px] bg-muted"
        >
          <div
            className="h-full bg-foreground/75"
            style={{ width: share(job.done) }}
          />
          <div
            className="h-full bg-destructive"
            style={{ width: share(job.failed) }}
          />
          <div
            className="h-full bg-foreground/30"
            style={{ width: share(job.skipped) }}
          />
        </div>
        <p className="text-[13px] text-muted-foreground">
          {job.done} done · {job.failed} failed · {job.skipped} skipped ·{" "}
          {formatUsd(job.spentUsd)} spent of {formatUsd(job.ceilingUsd)}
        </p>
        <p className="text-[13px] text-muted-foreground">
          Calls keep their current reading until the new one is saved. Cancel
          stops calls that haven&apos;t started.
        </p>
      </div>
      <ActionRow>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={canceling}
          onClick={() => void cancelJob(job.jobId)}
        >
          {canceling ? <Spinner data-icon="inline-start" /> : null}
          {canceling ? "Canceling…" : "Cancel"}
        </Button>
      </ActionRow>
    </>
  );
}

// ─── Turn off ────────────────────────────────────────────────────────────────

function TurnOffCard({
  onConfirm,
}: {
  onConfirm: (request: ConfirmRequest) => void;
}) {
  const update = useMutation(api.callInsights.admin.updateSettings);
  return (
    <section aria-label="Turn off Call insights" className={CARD}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <NoteLine className="min-w-0 flex-1">
          Reading stops and What they said disappears. Saved readings are kept.
        </NoteLine>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-danger-ink hover:text-danger-ink"
          onClick={() =>
            onConfirm({
              title: "Turn off Call insights?",
              description:
                "Reading stops and What they said disappears. Saved readings are kept.",
              confirmLabel: "Turn off",
              pendingLabel: "Turning off…",
              danger: true,
              run: async () => {
                await update({ mode: "off" });
                toast.success("Call insights is off.");
              },
            })
          }
        >
          Turn off
        </Button>
      </div>
    </section>
  );
}
