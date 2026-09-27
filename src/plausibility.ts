// The default defence against false readings: cheap checks on each published total, with no cryptography. Masking
// hides a meter's input, so a meter can report anything; its lie moves the total by the same amount. These checks catch
// a lie only when it pushes the group's mean load per home outside what homes draw, or moves it faster than homes do.
// Verified mode (src/pedersen.ts) catches out-of-range readings whatever their size.

export interface Plausibility {
  minPerHome: number; // W: lowest plausible mean load per home in a total (negative with rooftop solar)
  maxPerHome: number; // W: highest plausible mean load per home
  maxStepPerHome: number; // W: largest plausible change of that mean from one round to the next
}

export interface Published {
  total: bigint; // W
  homes: number;
}

/** Reasons a total is implausible; empty when it passes. `previous` is the group's last published total, if any. */
export function implausible(p: Published, bounds: Plausibility, previous?: Published): string[] {
  const mean = Number(p.total) / p.homes;
  const problems: string[] = [];
  if (mean < bounds.minPerHome) problems.push(`mean ${mean.toFixed(0)} W per home is below ${bounds.minPerHome} W`);
  if (mean > bounds.maxPerHome) problems.push(`mean ${mean.toFixed(0)} W per home is above ${bounds.maxPerHome} W`);
  if (previous) {
    const step = Math.abs(mean - Number(previous.total) / previous.homes);
    if (step > bounds.maxStepPerHome) problems.push(`mean moved ${step.toFixed(0)} W per home in one round, more than ${bounds.maxStepPerHome} W`);
  }
  return problems;
}
