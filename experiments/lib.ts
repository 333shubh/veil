// Shared by the experiments: the environment line, timing statistics, and result files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';

export function environment(): string {
  const cpu = cpus();
  const pinned = process.env.VEIL_PINNED_CPU ? `, pinned to logical CPU ${process.env.VEIL_PINNED_CPU} (a performance core)` : '';
  return `${cpu[0]?.model.trim()} (${cpu.length} threads${pinned}), ${process.platform} ${release()}, Node ${process.version}, OpenSSL ${process.versions.openssl}`;
}

export interface Stats {
  n: number;
  median: number;
  p95: number;
  mean: number;
  max: number;
}

/** Nearest-rank percentiles. */
export function stats(samples: readonly number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, median: rank(0.5), p95: rank(0.95), mean: s.reduce((a, b) => a + b, 0) / s.length, max: s.at(-1)! };
}

/** Run fn and return its value with the wall time in milliseconds. */
export function timed<T>(fn: () => T): [T, number] {
  const start = performance.now();
  const value = fn();
  return [value, performance.now() - start];
}

export const ms = (x: number) => (x < 0.1 ? x.toFixed(4) : x < 10 ? x.toFixed(3) : x.toFixed(1));

/** Write results/<name>.md for people and results/<name>.json for the claims table. */
export function writeResult(name: string, markdown: string[], data: unknown): void {
  const dir = new URL('./results/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(`${name}.md`, dir), markdown.join('\n') + '\n');
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}
