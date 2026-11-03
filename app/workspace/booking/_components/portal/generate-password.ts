// Readable portal passwords in concept C's shape ("orbit-maple-472"): three
// words and three digits from the browser's CSPRNG. 128 words give 21 bits,
// the digits 10 more; the unlock action is rate-limited per IP in Convex.

const WORDS = [
  "amber", "anchor", "apple", "arrow", "aspen", "atlas", "badge", "bamboo", "basil", "beacon", "birch", "blaze",
  "bloom", "breeze", "brook", "cabin", "cactus", "canyon", "cedar", "chalk", "cherry", "cinder", "citrus", "clover",
  "cobalt", "comet", "coral", "cotton", "crane", "creek", "crystal", "dawn", "delta", "desert", "drift", "dune",
  "eagle", "ember", "falcon", "fern", "fiesta", "flint", "forest", "fox", "frost", "galaxy", "garnet", "ginger",
  "glacier", "granite", "grove", "harbor", "hazel", "heron", "honey", "indigo", "iris", "island", "ivory", "jade",
  "jasper", "juniper", "kayak", "kelp", "kiwi", "lagoon", "lantern", "lemon", "lily", "linen", "lotus", "lunar",
  "maple", "marble", "meadow", "mint", "mosaic", "nectar", "noble", "nova", "oak", "oasis", "olive", "onyx",
  "orbit", "orchid", "otter", "pebble", "pepper", "pine", "planet", "plum", "polar", "prairie", "quartz", "quill",
  "radar", "raven", "reef", "ripple", "river", "robin", "ruby", "saffron", "sage", "salt", "sierra", "silver",
  "sonic", "spruce", "summit", "sunset", "tango", "thistle", "tiger", "topaz", "tulip", "tundra", "velvet", "violet",
  "walnut", "willow", "winter", "zenith", "zephyr", "yarrow", "canvas", "meteor",
];

export function generatePortalPassword() {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  const [a = 0, b = 0, c = 0, d = 0] = values;
  const pick = (value: number) => WORDS[value % WORDS.length];
  const digits = String(d % 1000).padStart(3, "0");
  return `${pick(a)}-${pick(b)}-${pick(c)}-${digits}`;
}
