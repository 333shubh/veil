// In-process simulation of one group: devices, meters, coordinator and ledger, driven epoch by epoch and round by
// round. Tests, experiments and the demo all use it.
import { randomBytes } from 'node:crypto';
import { ed25519Keygen, type SigningKey } from './crypto.ts';
import { Ledger, signAnchor } from './ledger.ts';
import {
  anchoredParams,
  Coordinator,
  isAborted,
  Meter,
  type Confirm,
  type EpochAnchor,
  type GroupParams,
  type MeterId,
  type PublicKeys,
  type Release,
  type Report,
  type RoundResult,
} from './protocol.ts';

export interface Group {
  ids: MeterId[];
  registry: Map<MeterId, Uint8Array>;
  operator: SigningKey;
  ledger: Ledger;
  meters: Map<MeterId, Meter>;
  coordinator: Coordinator;
  params: GroupParams;
  anchor: EpochAnchor;
  keys: PublicKeys[]; // the epoch's signed keys, one per meter
}

/** Devices, meters, coordinator and ledger for a roster, then its first epoch. */
export function setupGroup(ids: MeterId[], epoch: number, k: number, threshold: number, minGroupSize = 3): Group {
  const devices = new Map(ids.map((id) => [id, ed25519Keygen()]));
  const registry = new Map(ids.map((id) => [id, devices.get(id)!.publicKey]));
  const secrets = new Map(ids.map((id) => [id, randomBytes(32)]));
  const operator = ed25519Keygen();
  const g = {
    ids,
    registry,
    operator,
    ledger: new Ledger(operator.publicKey, registry),
    meters: new Map(ids.map((id) => [id, new Meter(id, devices.get(id)!, secrets.get(id)!, registry)])),
    coordinator: new Coordinator(secrets, registry),
  } as Group;
  startEpoch(g, epoch, k, threshold, minGroupSize);
  return g;
}

/** Epoch setup: anchor roster and beacon on the ledger, derive the graph, exchange device-signed keys and ML-KEM secrets. */
export function startEpoch(g: Group, epoch: number, k: number, threshold: number, minGroupSize = 3): void {
  g.anchor = signAnchor(g.operator, { epoch, roster: g.ids, beacon: randomBytes(32), k });
  g.ledger.anchor(g.anchor);
  g.params = anchoredParams(g.anchor, g.registry, threshold, minGroupSize);
  g.coordinator.startEpoch(g.params, g.anchor);
  g.keys = [...g.meters.values()].map((m) => m.startEpoch(g.params, g.anchor));
  const directory = g.coordinator.register(g.keys);
  const inbox = g.coordinator.relay([...g.meters.values()].flatMap((m) => m.keyExchange(directory)));
  for (const m of g.meters.values()) m.finishKeys(inbox.get(m.id) ?? []);
}

/** Who answers each phase of a round: reporting ⊇ confirming ⊇ releasing. */
export interface Pattern {
  reporting: ReadonlySet<MeterId>;
  confirming: ReadonlySet<MeterId>;
  releasing: ReadonlySet<MeterId>;
}

export const everyone = (ids: MeterId[]): Pattern => ({ reporting: new Set(ids), confirming: new Set(ids), releasing: new Set(ids) });

/** Everything that happened in a round, with wall time per phase (meter phases summed over meters). */
export interface RoundTrace {
  result: RoundResult;
  aborts: string[];
  reports: Report[];
  active?: ReadonlySet<MeterId>;
  confirms: Confirm[];
  final?: ReadonlySet<MeterId>;
  inbox?: Map<MeterId, Confirm[]>;
  releases: Release[];
  ms: { report: number; close: number; confirm: number; collect: number; release: number; recover: number };
}

export function runRound(g: Group, round: number, readings: ReadonlyMap<MeterId, bigint>, pattern: Pattern): RoundTrace {
  const ms = { report: 0, close: 0, confirm: 0, collect: 0, release: 0, recover: 0 };
  const clock = <T>(phase: keyof typeof ms, fn: () => T): T => {
    const start = performance.now();
    const value = fn();
    ms[phase] += performance.now() - start;
    return value;
  };
  const trace: RoundTrace = { result: { status: 'suppressed' }, aborts: [], reports: [], confirms: [], releases: [], ms };

  for (const id of pattern.reporting) trace.reports.push(clock('report', () => g.meters.get(id)!.report(round, readings.get(id)!)));
  const closed = clock('close', () => g.coordinator.close(round, trace.reports));
  if (closed.status === 'suppressed') return trace;
  trace.active = closed.active;
  for (const id of closed.active) {
    if (!pattern.confirming.has(id)) continue;
    const c = clock('confirm', () => g.meters.get(id)!.confirm(round, closed.active));
    if (isAborted(c)) trace.aborts.push(c.aborted);
    else trace.confirms.push(c);
  }
  const collected = clock('collect', () => g.coordinator.collect(trace.confirms));
  if (collected.status === 'suppressed') return trace;
  trace.final = collected.final;
  trace.inbox = collected.inbox;
  for (const id of collected.confirmed) {
    if (!pattern.releasing.has(id)) continue;
    const r = clock('release', () => g.meters.get(id)!.release(round, collected.final, collected.inbox.get(id) ?? []));
    if (isAborted(r)) trace.aborts.push(r.aborted);
    else trace.releases.push(r);
  }
  trace.result = clock('recover', () => g.coordinator.recover(trace.releases));
  return trace;
}
