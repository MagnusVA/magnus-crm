"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PauseCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { Button } from "@/components/ui/button";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { cn } from "@/lib/utils";

// One line per thing about automatic results that needs an owner or admin:
// everything paused, a kind gone back to one tap, or Whop not read lately.
// Nothing renders when all is well, and nothing for anyone else.

type Settings = FunctionReturnType<typeof api.automation.settings.getSettings>;
type Breaker = Settings["breakers"][number];

const PANEL_HREF = "/workspace/settings/automatic-results";
const LAG_DISMISSED_KEY = "automation-banner:whop-lag-dismissed";

const KIND_WORDS: Record<Breaker["kind"], string> = {
  payment_win: "Won from a payment",
  additional_payment: "Later payment",
  call_back: "Call back",
  payment_owed: "Payment owed",
  refusal_loss: "Refused on the call",
};

const BREAKER_WORDS: Record<Breaker["reason"], string> = {
  audit_overdue: "a check of an automatic result waited too long",
  wrong_write: "a person found a wrong automatic result",
  not_my_sale_unanswered: "a closer's \"This isn't my sale\" went unanswered for a business day",
  certificate_lapsed: "its clean record no longer covers the current rule",
};

function readDismissed() {
  try {
    return typeof window !== "undefined" && window.sessionStorage.getItem(LAG_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDismissed() {
  try {
    window.sessionStorage.setItem(LAG_DISMISSED_KEY, "1");
  } catch {
    // Storage can be refused; the line then hides for this page view only.
  }
}

/**
 * `onPanel` is set on the Automatic results page itself: the page already
 * says when everything is paused and is the panel the lines link to.
 */
export function AutomationBanner({ onPanel = false }: { onPanel?: boolean }) {
  const { hasPermission } = useRole();
  const allowed = hasPermission("result-automation:view");
  const view = useQuery(api.automation.settings.getSettings, allowed ? {} : "skip");
  if (!allowed || !view) return null;
  return <BannerLines view={view} onPanel={onPanel} />;
}

function BannerLines({ view, onPanel }: { view: Settings; onPanel: boolean }) {
  const [lagDismissed, setLagDismissed] = useState(readDismissed);
  // A pause someone made: pausedAt is set only by pausing.
  const paused = view.paused && view.configured?.pausedAt !== undefined;
  const paymentKindsOn = view.effective.payment_win !== "off" || view.effective.additional_payment !== "off";
  const lagging = view.whopLagging && paymentKindsOn && !lagDismissed;
  const showPause = paused && !onPanel;

  if (!showPause && view.breakers.length === 0 && !lagging) return null;

  return (
    <section aria-label="Automatic results" className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <ul className="divide-y">
        {showPause ? (
          <BannerLine icon={<PauseCircleIcon aria-hidden="true" className="size-4 shrink-0 text-warning-ink" />}>
            Automatic results are paused. Nothing is being recorded automatically.{" "}
            <PanelLink onPanel={onPanel} />
          </BannerLine>
        ) : null}
        {view.breakers.map((breaker) => (
          <BannerLine
            key={breaker.kind}
            icon={<TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-danger-ink" />}
          >
            {KIND_WORDS[breaker.kind]} went back to one tap: {BREAKER_WORDS[breaker.reason]}.{" "}
            <PanelLink onPanel={onPanel} />
          </BannerLine>
        ))}
        {lagging ? (
          <WhopLagLine
            connected={view.whopConnected}
            lastRead={view.whopLastReadAt}
            onDismiss={() => {
              saveDismissed();
              setLagDismissed(true);
            }}
          />
        ) : null}
      </ul>
    </section>
  );
}

function BannerLine({
  icon,
  children,
  action,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li role="status" className="flex min-h-10 items-start gap-2.5 px-4 py-2">
      <span className="flex h-5 items-center">{icon}</span>
      <p className="min-w-0 flex-1 text-[13px] leading-5 font-medium">{children}</p>
      {action}
    </li>
  );
}

function PanelLink({ onPanel }: { onPanel: boolean }) {
  if (onPanel) return null;
  return (
    <Link href={PANEL_HREF} className={cn(detailLinkClass, "inline text-[13px]")}>
      Open Automatic results
    </Link>
  );
}

function WhopLagLine({
  connected,
  lastRead,
  onDismiss,
}: {
  connected: boolean;
  lastRead: number | null;
  onDismiss: () => void;
}) {
  const words = !connected
    ? "Whop is not connected. Automatic payments are waiting."
    : lastRead !== null
      ? `Whop has not been read since ${dayTimeFormat.format(lastRead)}. Automatic payments are waiting.`
      : "Whop has not been read yet. Automatic payments are waiting.";

  return (
    <BannerLine
      icon={<TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning-ink" />}
      action={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="-my-1 -mr-2 shrink-0"
          aria-label="Hide this until the next session"
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      }
    >
      {words}
    </BannerLine>
  );
}
