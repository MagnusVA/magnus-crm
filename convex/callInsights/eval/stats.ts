/** Exact one-sided 95% binomial confidence limits, without a statistics dependency. */
const ALPHA = 0.05;

function count(k: number, n: number) {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(k) ||
    n < 0 ||
    k < 0 ||
    k > n
  )
    throw new Error("Invalid binomial counts");
}

/** P(X <= k), summing log probabilities to keep tails stable. */
function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n || p === 0) return 1;
  if (p === 1) return 0;
  let logChoose = 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logChoose + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return Math.min(1, sum);
}

export function lowerBound(successes: number, n: number): number {
  count(successes, n);
  if (successes === 0) return 0;
  // P(X >= successes) = alpha; equivalently P(X <= successes - 1) = 1 - alpha.
  let low = 0,
    high = 1;
  for (let i = 0; i < 65; i++) {
    const mid = (low + high) / 2;
    if (binomialCdf(successes - 1, n, mid) > 1 - ALPHA) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export function upperBound(failures: number, n: number): number {
  count(failures, n);
  if (failures === n) return 1;
  return 1 - lowerBound(n - failures, n);
}

export function minNForZeroErrors(tolerance: number): number {
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1)
    throw new Error("Tolerance must be between zero and one");
  return Math.ceil(Math.log(ALPHA) / Math.log1p(-tolerance));
}
