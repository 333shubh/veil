// A shard of meters on its own thread. Meters are separate devices, so the demo spreads them over threads and the
// coordinator talks to them only through messages, as it would over the network. The same host runs in a browser
// worker (shard-worker.ts) and in a Node thread for the soak run (shard-thread.ts).
import { Buffer } from 'buffer';
import type { SigningKey } from '../src/crypto.ts';
import { Meter, type Confirm, type Encapsulation, type EpochAnchor, type GroupParams, type MeterId, type PublicKeys } from '../src/protocol.ts';
import { Collusion } from './collusion.ts';

export interface Request {
  seq: number;
  method: string;
  args: unknown[];
}

export interface Response {
  seq: number;
  value?: unknown;
  error?: string;
  ms: number; // CPU time the shard spent on the request
}

/** Structured clone turns Buffers into plain Uint8Arrays; turn them back so the protocol code sees what it expects. */
export function hydrate<T>(v: T): T {
  if (v instanceof Uint8Array) return (Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength)) as T;
  if (v instanceof Map) {
    for (const [k, x] of v) v.set(k, hydrate(x));
    return v;
  }
  if (v instanceof Set || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = hydrate(v[i]);
    return v;
  }
  for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = hydrate((v as Record<string, unknown>)[k]);
  return v;
}

/** The methods a shard answers. Each takes the ids of its meters that should act, where that varies. */
export function host(): (req: Request) => Response {
  const meters = new Map<MeterId, Meter>();
  let collusion: Collusion | undefined;
  const all = () => [...meters.values()];
  const methods: Record<string, (...args: never[]) => unknown> = {
    init(devices: [MeterId, SigningKey][], secrets: Map<MeterId, Uint8Array>, registry: Map<MeterId, Uint8Array>) {
      for (const [id, device] of devices) meters.set(id, new Meter(id, device, secrets.get(id)!, registry));
    },
    startEpoch: (params: GroupParams, anchor: EpochAnchor): PublicKeys[] => all().map((m) => m.startEpoch(params, anchor)),
    keyExchange: (directory: ReadonlyMap<MeterId, PublicKeys>): Encapsulation[] => all().flatMap((m) => m.keyExchange(directory)),
    finishKeys(inbox: Map<MeterId, Encapsulation[]>) {
      for (const m of all()) m.finishKeys(inbox.get(m.id) ?? []);
    },
    report: (round: number, readings: Map<MeterId, bigint>) => [...readings].map(([id, r]) => meters.get(id)!.report(round, r)),
    confirm: (round: number, active: ReadonlySet<MeterId>, ids: MeterId[]) => ids.map((id) => meters.get(id)!.confirm(round, active)),
    release: (round: number, final: ReadonlySet<MeterId>, inbox: Map<MeterId, Confirm[]>) =>
      [...inbox].map(([id, confirms]) => meters.get(id)!.release(round, final, confirms)),
    collusion(corrupt: number, reading: bigint) {
      collusion ??= new Collusion();
      return collusion.attack(corrupt, reading);
    },
  };
  return (req) => {
    const start = performance.now();
    try {
      const value = methods[req.method]!(...(hydrate(req.args) as never[]));
      return { seq: req.seq, value, ms: performance.now() - start };
    } catch (e) {
      return { seq: req.seq, error: (e as Error).stack ?? String(e), ms: performance.now() - start };
    }
  };
}
