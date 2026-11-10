import type { Committer } from "./prepare";

/**
 * Every admin change, by its prepare tool's name. `magnus_commit` and the
 * approval page look a stored change up here, so each committer module is
 * imported explicitly: a registry filled at import time would be empty in a
 * function file that never imports the tool.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const COMMITTERS: Record<string, Committer<any>> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function committerFor(tool: string): Committer<any> | null {
  return COMMITTERS[tool] ?? null;
}
