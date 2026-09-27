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
  type Check,
  type Confirm,
  type EpochAnchor,
  type GroupParams,
  type MeterId,
  type PublicKeys,
  type Release,
  type Report,
  type RoundResult,
  type CoordinatorOptions,
  type Unmask,
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
  rangeBits?: number; // verified mode
}

export interface GroupOptions extends CoordinatorOptions {
  rangeBits?: number; // verified mode, anchored for every epoch of the group
}

/** Devices, meters, coordinator and ledger for a roster, then its first epoch. */
export function setupGroup(ids: MeterId[], epoch: number, k: number, threshold: number, minGroupSize = 3, options: GroupOptions = {}): Group {
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
    coordinator: new Coordinator(secrets, registry, options),
    rangeBits: options.rangeBits,
  } as Group;
  startEpoch(g, epoch, k, threshold, minGroupSize);
  return g;
}

/** Epoch setup: anchor roster and beacon on the ledger, derive the graph, exchange device-signed keys and ML-KEM secrets. */
export function startEpoch(g: Group, epoch: number, k: number, threshold: number, minGroupSize = 3): void {
  g.anchor = signAnchor(g.operator, { epoch, roster: g.ids, beacon: randomBytes(32), k, ...(g.rangeBits ? { rangeBits: g.rangeBits } : {}) });
  g.ledger.anchor(g.anchor);
  g.params = anchoredParams(g.anchor, g.registry, threshold, minGroupSize);
  g.coordinator.startEpoch(g.params, g.anchor);
  g.keys = [...g.meters.values()].map((m) => m.startEpoch(g.params, g.anchor));
  const directory = g.coordinator.register(g.keys);
  const inbox = g.coordinator.relay([...g.meters.values()].flatMap((m) => m.keyExchange(directory)));
  for (const m of g.meters.values()) m.finishKeys(inbox.get(m.id) ?? []);
}

/**
 * Who answers each phase of a round: reporting ⊇ confirming ⊇ checking ⊇ releasing. A meter outside `checking` goes
 * silent after confirming; one outside `releasing` goes silent after checking (it neither releases nor unmasks).
 */
export interface Pattern {
  reporting: ReadonlySet<MeterId>;
  confirming: ReadonlySet<MeterId>;
  checking?: ReadonlySet<MeterId>; // defaults to `confirming`
  releasing: ReadonlySet<MeterId>;
}

export const everyone = (ids: MeterId[]): Pattern => ({ reporting: new Set(ids), confirming: new Set(ids), releasing: new Set(ids) });

export type Phase = 'report' | 'close' | 'confirm' | 'collect' | 'check' | 'route' | 'release' | 'gather' | 'unmask' | 'recover';
export const METER_PHASES: readonly Phase[] = ['report', 'confirm', 'check', 'release', 'unmask'];
export const COORDINATOR_PHASES: readonly Phase[] = ['close', 'collect', 'route', 'gather', 'recover'];

/** Everything that happened in a round, with wall time per phase (meter phases summed over meters). */
export interface RoundTrace {
  result: RoundResult;
  aborts: string[];
  reports: Report[];
  active?: ReadonlySet<MeterId>;
  confirms: Confirm[];
  final?: ReadonlySet<MeterId>;
  inbox?: Map<MeterId, Confirm[]>; // confirmations routed to each neighbour, with the final set
  checks: Check[];
  routed?: Map<MeterId, Check[]>; // checks routed to each neighbour in F
  releases: Release[];
  requests?: Map<MeterId, Set<MeterId>>; // unmask requests, only when a meter in F went silent
  unmasks: Unmask[];
  ms: Record<Phase, number>;
}

/** Run one round. `onMeter` sees each meter call's wall time, for per-meter costs. */
export function runRound(
  g: Group,
  round: number,
  readings: ReadonlyMap<MeterId, bigint>,
  pattern: Pattern,
  onMeter?: (id: MeterId, phase: Phase, ms: number) => void,
): RoundTrace {
  const ms = { report: 0, close: 0, confirm: 0, collect: 0, check: 0, route: 0, release: 0, gather: 0, unmask: 0, recover: 0 };
  const clock = <T>(phase: Phase, fn: () => T, id?: MeterId): T => {
    const start = performance.now();
    const value = fn();
    const spent = performance.now() - start;
    ms[phase] += spent;
    if (id !== undefined) onMeter?.(id, phase, spent);
    return value;
  };
  const trace: RoundTrace = { result: { status: 'suppressed' }, aborts: [], reports: [], confirms: [], checks: [], releases: [], unmasks: [], ms };
  const checking = pattern.checking ?? pattern.confirming;
  const keep = <T extends object>(list: T[], x: T | { aborted: string }) => ('aborted' in x ? trace.aborts.push(x.aborted) : list.push(x as T));

  for (const id of pattern.reporting) trace.reports.push(clock('report', () => g.meters.get(id)!.report(round, readings.get(id)!), id));
  const closed = clock('close', () => g.coordinator.close(round, trace.reports));
  if (closed.status === 'suppressed') return trace;
  trace.active = closed.active;
  for (const id of closed.active) if (pattern.confirming.has(id)) keep(trace.confirms, clock('confirm', () => g.meters.get(id)!.confirm(round, closed.active), id));
  const collected = clock('collect', () => g.coordinator.collect(trace.confirms));
  if (collected.status === 'suppressed') return trace;
  trace.final = collected.final;
  trace.inbox = collected.inbox;
  for (const id of collected.confirmed) {
    if (checking.has(id)) keep(trace.checks, clock('check', () => g.meters.get(id)!.check(round, collected.final, collected.inbox.get(id) ?? []), id));
  }
  const routed = clock('route', () => g.coordinator.route(trace.checks));
  trace.routed = routed;
  for (const c of trace.checks) {
    if (collected.final.has(c.id) && pattern.releasing.has(c.id)) keep(trace.releases, clock('release', () => g.meters.get(c.id)!.release(round, routed.get(c.id) ?? []), c.id));
  }
  const gathered = clock('gather', () => g.coordinator.gather(trace.releases));
  if (gathered.status === 'aborted') {
    trace.result = gathered;
    return trace;
  }
  if (gathered.status === 'unmask') {
    trace.requests = gathered.requests;
    for (const [id, want] of gathered.requests) {
      if (checking.has(id) && pattern.releasing.has(id)) keep(trace.unmasks, clock('unmask', () => g.meters.get(id)!.unmask(round, want), id));
    }
  }
  trace.result = clock('recover', () => g.coordinator.recover(trace.unmasks));
  return trace;
}

/** Coordinator time in a round. */
export const coordinatorMs = (t: RoundTrace) => COORDINATOR_PHASES.reduce((a, p) => a + t.ms[p], 0);
/** Meter time in a round, summed over meters. */
export const meterMs = (t: RoundTrace) => METER_PHASES.reduce((a, p) => a + t.ms[p], 0);
