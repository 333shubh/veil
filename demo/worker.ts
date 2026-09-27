// The engine's thread: runs the coordinator and ledger, drives rounds back to back, and posts a snapshot after each.
// Meters live in their own workers; one more worker runs the collusion replay and the verified-mode group so they
// never stall the rounds.
import type { CollusionResult } from './collusion.ts';
import type { LieKind, VerifiedResult } from './verified.ts';
import { Engine, Remote, type Channel, type Snapshot } from './engine.ts';
import type { Response } from './shard.ts';

export type Command =
  | { type: 'toggle'; id: number }
  | { type: 'bill'; id: number }
  | { type: 'tamper'; delta: number }
  | { type: 'collusion'; corrupt: number; reading: string }
  | { type: 'verified'; kind: LieKind }
  | { type: 'lie'; id: number; watts: number }
  | { type: 'pause'; paused: boolean };

export type Event =
  | { type: 'progress'; text: string }
  | { type: 'ready'; houses: number; k: number; t: number; threads: number; setupMs: number }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'tamper'; result: ReturnType<Engine['tamper']> }
  | { type: 'collusion'; result: CollusionResult }
  | { type: 'verified'; result: VerifiedResult }
  | { type: 'error'; message: string };

const post = (e: Event) => self.postMessage(e);

function channel(): Channel {
  const w = new Worker(new URL('./shard-worker.js', import.meta.url), { type: 'module' });
  return { send: (req) => w.postMessage(req), listen: (fn) => (w.onmessage = (e: MessageEvent<Response>) => fn(e.data)) };
}

const threads = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
const collusion = new Remote(channel());
let engine: Engine | undefined;
let paused = false;
let wake: (() => void) | undefined;

self.onmessage = async (e: MessageEvent<Command>) => {
  const c = e.data;
  if (c.type === 'collusion') {
    const r = await collusion.call<CollusionResult>('collusion', c.corrupt, BigInt(c.reading));
    post({ type: 'collusion', result: r.value });
  } else if (c.type === 'verified') {
    const r = await collusion.call<VerifiedResult>('verified', c.kind);
    post({ type: 'verified', result: r.value });
  } else if (c.type === 'pause') {
    paused = c.paused;
    if (!paused) wake?.();
  } else if (engine) {
    if (c.type === 'toggle') engine.toggle(c.id);
    else if (c.type === 'bill') engine.bill(c.id);
    else if (c.type === 'lie') engine.lie(c.id, c.watts);
    else if (c.type === 'tamper') post({ type: 'tamper', result: engine.tamper(c.delta) });
  }
};

try {
  const start = performance.now();
  engine = await Engine.create(Array.from({ length: threads }, channel), (text) => post({ type: 'progress', text }));
  post({ type: 'ready', houses: engine.ids.length, k: engine.k, t: engine.t, threads, setupMs: performance.now() - start });
  for (;;) {
    if (paused) await new Promise<void>((resolve) => (wake = resolve));
    const snap = await engine.step();
    self.postMessage({ type: 'snapshot', snap } satisfies Event, { transfer: [snap.readings.buffer, snap.state.buffer] });
  }
} catch (err) {
  post({ type: 'error', message: (err as Error).stack ?? String(err) });
}
