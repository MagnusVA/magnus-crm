"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The Coverage tab's motion and fills, from concept C: a half-cell flips
 * when what it shows changes, a gap glows, counts tick, a new row or phone
 * tile slides in. Reduced motion turns them off.
 */
const CSS = `
@keyframes cov-flip{0%{transform:perspective(260px) rotateX(-95deg);opacity:.15;filter:brightness(.7)}55%{transform:perspective(260px) rotateX(14deg);opacity:1;filter:none}100%{transform:none}}
@keyframes cov-glow{0%,100%{background-color:color-mix(in oklab,var(--color-destructive) 5%,var(--color-card));border-color:color-mix(in oklab,var(--color-destructive) 55%,transparent)}50%{background-color:color-mix(in oklab,var(--color-destructive) 16%,var(--color-card));border-color:var(--color-destructive)}}
@keyframes cov-tick{0%{transform:none}30%{transform:translateY(-3px)}100%{transform:none}}
@keyframes cov-row-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
@keyframes cov-enter{from{opacity:0;transform:translateX(26px)}to{opacity:1;transform:none}}
@keyframes cov-new{0%,20%{background-color:color-mix(in oklab,var(--color-stage-booked) 20%,var(--color-card))}100%{background-color:var(--color-card)}}
@keyframes cov-swap{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}
@keyframes cov-sheet-up{from{transform:translateY(100%)}to{transform:none}}
.cov-hatch{background:repeating-linear-gradient(135deg,var(--color-muted) 0 5px,color-mix(in oklab,var(--color-border) 80%,var(--color-muted)) 5px 6px)}
@media (prefers-reduced-motion:no-preference){
  .cov-flip{animation:cov-flip .56s cubic-bezier(.3,1.35,.5,1) both}
  .cov-glow{animation:cov-glow 2.4s ease-in-out infinite}
  .cov-tick{animation:cov-tick .7s ease}
  .cov-row-in{animation:cov-row-in .5s cubic-bezier(.2,.8,.2,1) both}
  .cov-enter{animation:cov-enter .55s cubic-bezier(.2,.9,.3,1.2) both,cov-new 1.8s ease}
  .cov-new{animation:cov-new 1.8s ease}
  .cov-swap{animation:cov-swap .4s ease}
  .cov-sheet-up{animation:cov-sheet-up .3s cubic-bezier(.2,.8,.2,1) both}
}
`;

export function CoverageMotionStyles() {
  return (
    <style href="booking-coverage-motion" precedence="default">
      {CSS}
    </style>
  );
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A count that ticks from its old value to the new one when it changes. */
export function TickingNumber({ value, className }: { value: number; className?: string }) {
  const [target, setTarget] = useState(value);
  const [from, setFrom] = useState(value);
  const [shown, setShown] = useState(value);
  if (target !== value) {
    setFrom(shown);
    setTarget(value);
  }
  const ticking = shown !== target;

  useEffect(() => {
    if (from === target) return;
    const duration = reducedMotion() ? 0 : 700;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(from + (target - from) * eased));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [from, target]);

  return <span className={cn("inline-block tabular-nums", ticking && "cov-tick", className)}>{ticking ? shown : value}</span>;
}

/** True for one animation after `signature` changes (not on first render). */
export function useChanged(signature: string) {
  const [seen, setSeen] = useState(signature);
  const [changed, setChanged] = useState(false);
  if (seen !== signature) {
    setSeen(signature);
    setChanged(true);
  }
  return [changed, () => setChanged(false)] as const;
}
