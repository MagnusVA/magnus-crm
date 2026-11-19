/** The sync toast's note when some round robins' hosts couldn't be confirmed. */
export function hostCheckWarning(count: number) {
  return `${count} round-robin event ${count === 1 ? "type" : "types"} couldn't be checked with Calendly, so closer links on them may be paused. Sync again in a minute.`;
}
