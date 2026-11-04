// Reads an unmatched utm_source / utm_medium pair against the DM teams and DM
// closers and says what it most likely is, with only the fixes the backend
// can do: enable a disabled team or closer, rewrite a stored UTM value that
// has a space or capitals, or add a team or closer. Pure, so it can be tested.
//
// Attribution matches as `normalizeUtmValue` does (trim, lower case, collapse
// spaces), so "Miguel Dacosta" on the closer never matches "miguel_dacosta"
// on a link someone typed by hand.

export type UtmTeam = { _id: string; displayName: string; utmSource: string; isActive: boolean };
export type UtmCloser = {
  _id: string;
  displayName: string;
  utmMedium: string;
  isActive: boolean;
  teamId: string;
};
export type UnmatchedGroup = {
  utmSource: string | null;
  utmMedium: string | null;
  bookings: number;
  lastBookedAt: number;
};

/** A sentence made of words and UTM values (rendered in mono). */
export type Message = Array<string | { code: string }>;

export type UtmFix =
  | { kind: "enable_team"; team: UtmTeam }
  | { kind: "enable_closer"; closer: UtmCloser }
  | { kind: "set_team_source"; team: UtmTeam; to: string }
  | { kind: "set_closer_medium"; closer: UtmCloser; to: string }
  | { kind: "open_team"; team: UtmTeam }
  | { kind: "open_closer"; closer: UtmCloser }
  | { kind: "new_team"; utmSource: string }
  | { kind: "new_closer"; utmMedium: string; team: UtmTeam | null };

export type UtmReading = {
  /** The value it is about. */
  part: "utm_source" | "utm_medium";
  value: string;
  /** How sure: a fix that matches exactly, a near miss, or nothing like it. */
  strength: "exact" | "near" | "none";
  message: Message;
  fixes: UtmFix[];
  /** The team this value points at, if any (a closer added from here joins it). */
  team: UtmTeam | null;
};

export type GroupReading = {
  readings: UtmReading[];
  /** The registry now matches this pair: new bookings get credit. */
  nowMatches: { team: UtmTeam | null; closer: UtmCloser | null } | null;
  fixes: UtmFix[];
};

export function normalizeUtm(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Without case, spaces or separators: "Miguel Dacosta" and "miguel_dacosta" agree. */
function loose(value: string) {
  return normalizeUtm(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

const CLEAN = /^[a-z0-9]+(?:[_.-][a-z0-9]+)*$/;

/** "has a space", "has capitals": why a stored value is easy to mistype. */
function oddity(stored: string): string | null {
  if (/\s/.test(stored.trim())) return "with a space";
  if (stored !== stored.toLowerCase()) return "with capitals";
  return null;
}

/** Optimal string alignment distance: edits, with a swap of two letters as one. */
export function editDistance(a: string, b: string) {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * A likely typo: one edit for short values, two for longer ones, and the
 * numbers must agree (dm_team_6 is not a typo of dm_team_5).
 */
function isNear(value: string, candidate: string) {
  const a = normalizeUtm(value);
  const b = normalizeUtm(candidate);
  if (a === b) return false;
  if ((a.match(/\d+/g) ?? []).join(",") !== (b.match(/\d+/g) ?? []).join(",")) return false;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 3) return false;
  const allowed = shorter <= 5 ? 1 : 2;
  return editDistance(a, b) <= allowed;
}

/** "kendany" for "kendanyalvarado": a cut-short value. */
function isPrefix(value: string, candidate: string) {
  const a = loose(value);
  const b = loose(candidate);
  return a !== b && Math.min(a.length, b.length) >= 5 && (b.startsWith(a) || a.startsWith(b));
}

// Sources that name a channel rather than a team: "ig" is the Instagram bio.
const CHANNELS: Record<string, string> = {
  ig: "an Instagram",
  insta: "an Instagram",
  instagram: "an Instagram",
  fb: "a Facebook",
  facebook: "a Facebook",
  meta: "a Meta ads",
  tiktok: "a TikTok",
  tt: "a TikTok",
  yt: "a YouTube",
  youtube: "a YouTube",
  google: "a Google",
  linktree: "a Linktree",
  linkinbio: "a link-in-bio",
  bio: "a link-in-bio",
  email: "an email",
  newsletter: "a newsletter",
  twitter: "an X",
  x: "an X",
  threads: "a Threads",
  whatsapp: "a WhatsApp",
  sms: "a text message",
};

function readSource(value: string, teams: readonly UtmTeam[]): UtmReading {
  const norm = normalizeUtm(value);
  const base = { part: "utm_source" as const, value };

  const disabled = teams.find((team) => !team.isActive && normalizeUtm(team.utmSource) === norm);
  if (disabled) {
    return {
      ...base,
      strength: "exact",
      team: disabled,
      message: [`${disabled.displayName} uses this utm_source, but the team is disabled.`],
      fixes: [{ kind: "enable_team", team: disabled }, { kind: "open_team", team: disabled }],
    };
  }

  const active = teams.filter((team) => team.isActive);
  const sameLetters = active.find((team) => loose(team.utmSource) === loose(value));
  if (sameLetters) {
    const odd = oddity(sameLetters.utmSource);
    if (odd && CLEAN.test(value)) {
      return {
        ...base,
        strength: "exact",
        team: sameLetters,
        message: [
          `${sameLetters.displayName}’s utm_source is `,
          { code: sameLetters.utmSource },
          `, ${odd}. Links made outside the portal used this one.`,
        ],
        fixes: [{ kind: "set_team_source", team: sameLetters, to: value.trim() }],
      };
    }
    return {
      ...base,
      strength: "near",
      team: sameLetters,
      message: ["Same letters as ", { code: sameLetters.utmSource }, ` (${sameLetters.displayName}), written differently.`],
      fixes: [{ kind: "open_team", team: sameLetters }],
    };
  }

  const near = active.find((team) => isNear(value, team.utmSource));
  if (near) {
    return {
      ...base,
      strength: "near",
      team: near,
      message: ["Looks like a typo of ", { code: near.utmSource }, ` (${near.displayName}).`],
      fixes: [{ kind: "open_team", team: near }],
    };
  }

  const nearDisabled = teams.find((team) => !team.isActive && isNear(value, team.utmSource));
  if (nearDisabled) {
    return {
      ...base,
      strength: "near",
      team: nearDisabled,
      message: ["Close to ", { code: nearDisabled.utmSource }, ` (${nearDisabled.displayName}), which is disabled.`],
      fixes: [{ kind: "open_team", team: nearDisabled }],
    };
  }

  const channel = CHANNELS[loose(value)];
  if (channel) {
    return {
      ...base,
      strength: "none",
      team: null,
      message: [`No team uses it. Probably ${channel} link, not a DM team.`],
      fixes: [{ kind: "new_team", utmSource: value.trim() }],
    };
  }

  return {
    ...base,
    strength: "none",
    team: null,
    message: ["No DM team uses this utm_source."],
    fixes: [{ kind: "new_team", utmSource: value.trim() }],
  };
}

function readMedium(
  value: string,
  closers: readonly UtmCloser[],
  teamsById: ReadonlyMap<string, UtmTeam>,
  sourceTeam: UtmTeam | null,
): UtmReading {
  const norm = normalizeUtm(value);
  const base = { part: "utm_medium" as const, value };
  const teamName = (closer: UtmCloser) => teamsById.get(closer.teamId)?.displayName ?? "another team";
  // Prefer a closer on the team the utm_source points at.
  const rank = (list: UtmCloser[]) =>
    [...list].sort((a, b) => Number(b.teamId === sourceTeam?._id) - Number(a.teamId === sourceTeam?._id));

  const exact = closers.filter((closer) => normalizeUtm(closer.utmMedium) === norm);
  const activeExact = exact.filter((closer) => closer.isActive);
  if (activeExact.length > 1) {
    return {
      ...base,
      strength: "exact",
      team: null,
      message: [
        `${activeExact.map((closer) => `${closer.displayName} (${teamName(closer)})`).join(" and ")} share this utm_medium, and the utm_source didn’t say which team.`,
      ],
      fixes: activeExact.slice(0, 2).map((closer) => ({ kind: "open_closer" as const, closer })),
    };
  }
  const disabled = exact.find((closer) => !closer.isActive);
  if (disabled && activeExact.length === 0) {
    return {
      ...base,
      strength: "exact",
      team: teamsById.get(disabled.teamId) ?? null,
      message: [`${disabled.displayName} on ${teamName(disabled)} uses this utm_medium, but is disabled.`],
      fixes: [{ kind: "enable_closer", closer: disabled }, { kind: "open_closer", closer: disabled }],
    };
  }

  const active = closers.filter((closer) => closer.isActive);
  const sameLetters = rank(active.filter((closer) => loose(closer.utmMedium) === loose(value)))[0];
  if (sameLetters) {
    const odd = oddity(sameLetters.utmMedium);
    if (odd && CLEAN.test(value)) {
      return {
        ...base,
        strength: "exact",
        team: teamsById.get(sameLetters.teamId) ?? null,
        message: [
          `${sameLetters.displayName}’s utm_medium is `,
          { code: sameLetters.utmMedium },
          `, ${odd}. Links made outside the portal used this one.`,
        ],
        fixes: [{ kind: "set_closer_medium", closer: sameLetters, to: value.trim() }],
      };
    }
    return {
      ...base,
      strength: "near",
      team: teamsById.get(sameLetters.teamId) ?? null,
      message: [
        "Same letters as ",
        { code: sameLetters.utmMedium },
        ` (${sameLetters.displayName} on ${teamName(sameLetters)}), written differently.`,
      ],
      fixes: [{ kind: "open_closer", closer: sameLetters }],
    };
  }

  const byName = rank(active.filter((closer) => loose(closer.displayName) === loose(value)))[0];
  if (byName) {
    return {
      ...base,
      strength: "near",
      team: teamsById.get(byName.teamId) ?? null,
      message: [`Matches the name of ${byName.displayName} on ${teamName(byName)}, whose utm_medium is `, { code: byName.utmMedium }, "."],
      fixes: [{ kind: "open_closer", closer: byName }],
    };
  }

  const near = rank(active.filter((closer) => isNear(value, closer.utmMedium) || isPrefix(value, closer.utmMedium)))[0];
  if (near) {
    return {
      ...base,
      strength: "near",
      team: teamsById.get(near.teamId) ?? null,
      message: [`Close to ${near.displayName} (`, { code: near.utmMedium }, `) on ${teamName(near)}.`],
      fixes: [{ kind: "open_closer", closer: near }],
    };
  }

  return {
    ...base,
    strength: "none",
    team: null,
    message: ["No DM closer uses this utm_medium."],
    fixes: [{ kind: "new_closer", utmMedium: value.trim(), team: sourceTeam }],
  };
}

const FIX_ORDER: Record<UtmFix["kind"], number> = {
  set_closer_medium: 0,
  set_team_source: 1,
  enable_team: 2,
  enable_closer: 3,
  new_closer: 4,
  open_closer: 5,
  open_team: 6,
  new_team: 7,
};

function fixKey(fix: UtmFix) {
  switch (fix.kind) {
    case "enable_team":
    case "open_team":
    case "set_team_source":
      return `${fix.kind}:${fix.team._id}`;
    case "enable_closer":
    case "open_closer":
    case "set_closer_medium":
      return `${fix.kind}:${fix.closer._id}`;
    case "new_team":
      return fix.kind;
    case "new_closer":
      return fix.kind;
  }
}

/** Would attribution credit this pair now (after a fix)? Same rule as the server. */
export function matchNow(
  group: Pick<UnmatchedGroup, "utmSource" | "utmMedium">,
  teams: readonly UtmTeam[],
  closers: readonly UtmCloser[],
): GroupReading["nowMatches"] {
  const source = group.utmSource ? normalizeUtm(group.utmSource) : null;
  const medium = group.utmMedium ? normalizeUtm(group.utmMedium) : null;
  const team = source ? (teams.find((row) => row.isActive && normalizeUtm(row.utmSource) === source) ?? null) : null;
  const candidates = medium
    ? closers.filter((closer) => closer.isActive && normalizeUtm(closer.utmMedium) === medium)
    : [];
  const closer = team
    ? (candidates.find((candidate) => candidate.teamId === team._id) ?? null)
    : candidates.length === 1
      ? candidates[0]
      : null;
  return team || closer ? { team, closer } : null;
}

export function readUnmatched(
  group: UnmatchedGroup,
  teams: readonly UtmTeam[],
  closers: readonly UtmCloser[],
): GroupReading {
  const teamsById = new Map(teams.map((team) => [team._id, team]));
  const nowMatches = matchNow(group, teams, closers);
  const source = group.utmSource ? readSource(group.utmSource, teams) : null;
  const medium = group.utmMedium
    ? readMedium(group.utmMedium, closers, teamsById, source?.team ?? null)
    : null;

  const generic = (reading: UtmReading | null) => reading !== null && reading.strength === "none" && reading.message.length === 1 && /^No DM (team|closer) uses this/.test(String(reading.message[0]));
  const readings =
    source && medium && generic(source) && generic(medium)
      ? [{ ...medium, message: ["No DM team or DM closer uses these values."] }, { ...source, message: [] }]
      : [source, medium].filter((reading): reading is UtmReading => reading !== null);
  // A closer that's clearly identified makes "new team" noise for the source.
  const closerKnown = medium !== null && medium.strength !== "none";
  const fixes = new Map<string, UtmFix>();
  for (const reading of readings) {
    for (const fix of reading.fixes) {
      if (fix.kind === "new_team" && closerKnown) continue;
      fixes.set(fixKey(fix), fix);
    }
  }
  return {
    readings,
    nowMatches,
    fixes: [...fixes.values()].sort((a, b) => FIX_ORDER[a.kind] - FIX_ORDER[b.kind]).slice(0, 2),
  };
}
