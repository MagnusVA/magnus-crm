/**
 * Filing motion: a copy of the card lifts, tilts and flies to where it was
 * filed (the band's matching figure when it is on screen, else up and out),
 * while the real card is replaced underneath. Web Animations only, so it
 * needs no CSS; with reduced motion it does nothing.
 */
export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function flyAway(card: HTMLElement | null, target: Element | null) {
  if (!card || prefersReducedMotion()) return;
  const from = card.getBoundingClientRect();
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    zIndex: "60",
    pointerEvents: "none",
    transformOrigin: "center center",
    boxShadow: "0 18px 40px rgb(20 26 40 / 0.22)",
  });
  document.body.appendChild(ghost);

  const to = target?.getBoundingClientRect();
  const dx = to ? to.left + to.width / 2 - (from.left + from.width / 2) : from.width * 0.1;
  const dy = to ? to.top + to.height / 2 - (from.top + from.height / 2) : -from.height * 0.6;
  const animation = ghost.animate(
    [
      { transform: "translate(0, 0) rotate(0deg) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.12}px, ${dy * 0.12 - 18}px) rotate(-3deg) scale(0.86)`, opacity: 1, offset: 0.3 },
      { transform: `translate(${dx}px, ${dy}px) rotate(-6deg) scale(0.12)`, opacity: 0 },
    ],
    { duration: 620, easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" },
  );
  const done = () => ghost.remove();
  animation.onfinish = done;
  animation.oncancel = done;
}

/** The incoming card rises from the stack beneath it. */
export function riseIn(card: HTMLElement | null) {
  if (!card || prefersReducedMotion()) return;
  card.animate(
    [
      { transform: "translateY(12px) scale(0.975)", opacity: 0.6 },
      { transform: "none", opacity: 1 },
    ],
    { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}
