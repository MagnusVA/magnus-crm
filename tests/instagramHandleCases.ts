// Both the server's rule tests and the form parity test read these cases.
export const KEPT_INSTAGRAM_HANDLES = [
  ["@campos.coachpro", "campos.coachpro"],
  ["https://www.instagram.com/Campos.CoachPro/", "campos.coachpro"],
  ["jo", "jo"],
  ["@j_9", "j_9"],
] as const;

export const KEPT_INSTAGRAM_PROFILE_URLS = [
  "m.instagram.com/real.handle",
  "HTTPS://WWW.INSTAGRAM.COM/Real.Handle",
  "instagram.com/real.handle/reels/",
  "instagram.com/real.handle/tagged/?x=1",
] as const;

export const PLACEHOLDER_INSTAGRAM_HANDLES = [
  "na",
  "NA",
  "@na",
  "n/a",
  "N/A",
  "none",
  "None",
  "null",
  "nil",
  "no",
  "-",
  "...",
  ".",
  "g",
  "@j",
  "_._",
  "instagram.com/g",
  "test",
  "",
] as const;

export const REJECTED_INSTAGRAM_URLS = [
  "instagram.com/p/abc",
  "instagram.com/reel/abc",
  "m.instagram.com/p/abc",
  "instagram.com/invalid!/reels/",
  "instagram.com/g/tagged/",
  "instagram.com/real.handle/reels/abc",
] as const;
