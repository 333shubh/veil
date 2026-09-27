// The demo's engine: one group of simulated Indian homes running the real protocol round by round. It plays the
// coordinator and the ledger; the meters run in shards on other threads (shard.ts) and are reached only by messages.
// Everything it reports is computed by the protocol code; the true readings are kept to show the privacy risk in Raw
// mode and to check exactness.
import { randomBytes } from 'node:crypto';
import { ed25519Keygen, type SigningKey } from '../src/crypto.ts';
import { audit, Ledger, recordFor, signAnchor } from '../src/ledger.ts';
import { simulateLoad, type Load } from '../src/load.ts';
import { choose, DESIGN, MIN_GROUP_SIZE } from '../src/params.ts';
import {
  anchoredParams,
  Coordinator,
  isAborted,
  type Aborted,
  type Confirm,
  type Encapsulation,
  type GroupParams,
  type MeterId,
  type PublicKeys,
  type Release,
  type Report,
  type RoundEvidence,
} from '../src/protocol.ts';
import { hydrate, type Request, type Response } from './shard.ts';

export const HOUSES = 240; // enough that 10% dropout still leaves at least MIN_GROUP_SIZE in the total
const SAMPLE = 60; // simulated seconds per round
const BACKGROUND_DROPOUT = 0.01; // transient misses, as in CEEW's short gaps
const BILLING = 30; // minutes per billing register reading

/** A message port to a shard: a browser Worker or a Node worker thread. */
export interface Channel {
  send(req: Request): void;
  listen(fn: (res: Response) => void): void;
}

export class Remote {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

  private readonly channel: Channel;

  constructor(channel: Channel) {
    this.channel = channel;
    channel.listen((res) => {
      const w = this.waiting.get(res.seq)!;
      this.waiting.delete(res.seq);
      if (res.error) w.reject(new Error(res.error));
      else w.resolve({ ...res, value: hydrate(res.value) });
    });
  }

  call<T>(method: string, ...args: unknown[]): Promise<{ value: T; ms: number }> {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      this.waiting.set(seq, { resolve: resolve as (r: Response) => void, reject });
      this.channel.send({ seq, method, args });
    });
  }
}

export interface Counters {
  rounds: number;
  published: number;
  exact: number;
  mismatches: number;
  suppressed: number;
  aborted: number;
}

export type Phase = 'report' | 'close' | 'confirm' | 'collect' | 'release' | 'recover';

export interface Snapshot {
  round: number;
  minute: number; // simulated minute of the day
  status: 'published' | 'suppressed' | 'aborted';
  reason?: string;
  total: number | null; // W, the published total
  truth: number | null; // W, the true total of the same homes
  included: number;
  counters: Counters;
  readings: Int32Array; // W per house: what the operator would see without Veil
  state: Uint8Array; // per house: 0 in the total, 1 left out this round, 2 unplugged
  masked: string[]; // masked reports the coordinator received, as hex
  maskedCount: number;
  ms: Record<Phase, number>; // wall time per phase, meters working in parallel
  meterMs: number; // the slowest meter's own CPU time this round
  aborts: string[];
  billing: { house: MeterId; kwh: number[] }; // coarse register over the separate billing channel
}

const flat = <T>(xs: { value: T[] }[]) => xs.flatMap((x) => x.value);

export class Engine {
  readonly ids: MeterId[];
  readonly k: number;
  readonly t: number;
  readonly setupMs: Record<string, number> = {};
  private readonly shards: { remote: Remote; ids: MeterId[] }[];
  private readonly load: Load;
  private readonly registry: Map<MeterId, Uint8Array>;
  private readonly operator = ed25519Keygen();
  private readonly ledger: Ledger;
  private readonly coordinator: Coordinator;
  private readonly devices: Map<MeterId, SigningKey>;
  private readonly secrets: Map<MeterId, Uint8Array>;
  private params!: GroupParams;
  private readonly unplugged = new Set<MeterId>();
  private readonly counters: Counters = { rounds: 0, published: 0, exact: 0, mismatches: 0, suppressed: 0, aborted: 0 };
  private round = 0;
  private billed: MeterId;
  private last?: { round: number; total: bigint; evidence: RoundEvidence; recorded: boolean };
  private seed = 1;

  private constructor(channels: Channel[], houses: number) {
    this.ids = Array.from({ length: houses }, (_, i) => i + 1);
    const c = choose(houses, DESIGN)!;
    [this.k, this.t] = [c.k, c.t];
    this.load = simulateLoad(this.ids, 2, SAMPLE, 'veil demo');
    this.devices = new Map(this.ids.map((id) => [id, ed25519Keygen()]));
    this.registry = new Map(this.ids.map((id) => [id, this.devices.get(id)!.publicKey]));
    this.secrets = new Map(this.ids.map((id) => [id, randomBytes(32)]));
    this.ledger = new Ledger(this.operator.publicKey, this.registry);
    this.coordinator = new Coordinator(this.secrets, this.registry);
    const size = Math.ceil(houses / channels.length);
    this.shards = channels.map((ch, s) => ({ remote: new Remote(ch), ids: this.ids.slice(s * size, (s + 1) * size) }));
    this.billed = this.ids[0]!;
  }

  /** Build the group and run epoch setup: anchor, graph, device-signed keys, ML-KEM encapsulations. */
  static async create(channels: Channel[], progress: (step: string) => void = () => {}, houses = HOUSES): Promise<Engine> {
    let clock = performance.now();
    const e = new Engine(channels, houses);
    const lap = (name: string) => {
      const now = performance.now();
      e.setupMs[name] = now - clock;
      clock = now;
    };
    lap('devices');
    progress(`${houses} meters in ${channels.length} threads; k=${e.k}, t=${e.t}. Anchoring the roster`);
    await e.each((s) => s.remote.call('init', s.ids.map((id) => [id, e.devices.get(id)]), new Map(s.ids.map((id) => [id, e.secrets.get(id)])), e.registry));
    const anchor = signAnchor(e.operator, { epoch: 1, roster: e.ids, beacon: randomBytes(32), k: e.k });
    e.ledger.anchor(anchor);
    e.params = anchoredParams(anchor, e.registry, e.t, MIN_GROUP_SIZE);
    e.coordinator.startEpoch(e.params, anchor);
    lap('anchor');
    progress('Meters drawing epoch keys (X25519, ML-KEM-768)');
    const keys = flat(await e.each((s) => s.remote.call<PublicKeys[]>('startEpoch', e.params, anchor)));
    const directory = e.coordinator.register(keys);
    lap('keys');
    progress('Meters checking neighbours’ signed keys and encapsulating pair secrets');
    const inbox = e.coordinator.relay(flat(await e.each((s) => s.remote.call<Encapsulation[]>('keyExchange', directory))));
    lap('keyExchange');
    progress('Meters deriving pair keys');
    await e.each((s) => s.remote.call('finishKeys', new Map(s.ids.map((id) => [id, inbox.get(id) ?? []]))));
    lap('finishKeys');
    return e;
  }

  private each<T>(fn: (s: { remote: Remote; ids: MeterId[] }) => Promise<T>): Promise<T[]> {
    return Promise.all(this.shards.map(fn));
  }

  toggle(house: MeterId): void {
    if (this.unplugged.has(house)) this.unplugged.delete(house);
    else this.unplugged.add(house);
  }

  bill(house: MeterId): void {
    this.billed = house;
  }

  private uniform(): number {
    this.seed = (this.seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return this.seed / 2 ** 31;
  }

  async step(): Promise<Snapshot> {
    const round = this.round++;
    const sample = round % this.load.samples;
    const readings = new Int32Array(this.ids.length);
    this.ids.forEach((id, i) => (readings[i] = this.load.power.get(id)![sample]!));
    const reporting = new Set(this.ids.filter((id) => !this.unplugged.has(id) && this.uniform() >= BACKGROUND_DROPOUT));

    const ms = { report: 0, close: 0, confirm: 0, collect: 0, release: 0, recover: 0 };
    let meterMs = 0;
    let clock = performance.now();
    const lap = (phase: Phase) => {
      const now = performance.now();
      ms[phase] = now - clock;
      clock = now;
    };
    const parallel = async <T>(fn: (s: { remote: Remote; ids: MeterId[] }) => Promise<{ value: T[]; ms: number }>) => {
      const out = await this.each(fn);
      meterMs += Math.max(...out.map((o) => o.ms)) / Math.max(1, Math.ceil(this.ids.length / this.shards.length));
      return flat(out);
    };

    const aborts: string[] = [];
    const reports = await parallel((s) =>
      s.remote.call<Report[]>('report', round, new Map(s.ids.filter((id) => reporting.has(id)).map((id) => [id, BigInt(readings[id - 1]!)]))),
    );
    lap('report');
    let result: { status: 'published'; total: bigint; evidence: RoundEvidence } | { status: 'suppressed' } | { status: 'aborted'; reason: string } = {
      status: 'suppressed',
    };
    const closed = this.coordinator.close(round, reports);
    lap('close');
    if (closed.status === 'open') {
      const answers = await parallel((s) => s.remote.call<(Confirm | Aborted)[]>('confirm', round, closed.active, s.ids.filter((id) => closed.active.has(id))));
      const confirms: Confirm[] = [];
      for (const c of answers) (isAborted(c) ? aborts.push(c.aborted) : confirms.push(c));
      lap('confirm');
      const collected = this.coordinator.collect(confirms);
      lap('collect');
      if (collected.status !== 'suppressed') {
        const confirmed = new Set(collected.confirmed);
        const released = await parallel((s) =>
          s.remote.call<(Release | Aborted)[]>(
            'release',
            round,
            collected.final,
            new Map(s.ids.filter((id) => confirmed.has(id)).map((id) => [id, collected.inbox.get(id) ?? []])),
          ),
        );
        const releases: Release[] = [];
        for (const r of released) (isAborted(r) ? aborts.push(r.aborted) : releases.push(r));
        lap('release');
        result = this.coordinator.recover(releases);
        lap('recover');
      }
    }

    this.counters.rounds++;
    this.counters[result.status]++;
    let total: number | null = null;
    let truth: number | null = null;
    const included = result.status === 'published' ? new Set(result.evidence.final) : new Set<MeterId>();
    if (result.status === 'published') {
      const expected = result.evidence.final.reduce((a, id) => a + BigInt(readings[id - 1]!), 0n);
      total = Number(result.total);
      truth = Number(expected);
      if (result.total === expected) this.counters.exact++;
      else this.counters.mismatches++;
      this.last = { round, total: result.total, evidence: result.evidence, recorded: false };
    }
    const state = new Uint8Array(this.ids.length);
    this.ids.forEach((id, i) => (state[i] = this.unplugged.has(id) ? 2 : included.has(id) ? 0 : 1));

    return {
      round,
      minute: ((sample * SAMPLE) / 60) % 1440,
      status: result.status,
      reason: result.status === 'aborted' ? result.reason : undefined,
      total,
      truth,
      included: included.size,
      counters: { ...this.counters },
      readings,
      state,
      masked: reports.slice(0, 14).map((r) => r.y.toString(16).padStart(16, '0')),
      maskedCount: reports.length,
      ms,
      meterMs,
      aborts,
      billing: { house: this.billed, kwh: this.billing(this.billed, sample) },
    };
  }

  /** The billing channel: the house's energy per 30-minute block over the last four hours, as a billing meter registers it. */
  private billing(house: MeterId, sample: number): number[] {
    const perBlock = (BILLING * 60) / SAMPLE;
    const p = this.load.power.get(house)!;
    const current = Math.floor(sample / perBlock);
    const kwh: number[] = [];
    for (let b = Math.max(0, current - 7); b <= current; b++) {
      let wh = 0;
      for (let i = b * perBlock; i < Math.min((b + 1) * perBlock, sample + 1); i++) wh += (p[i]! * SAMPLE) / 3600;
      kwh.push(wh / 1000);
    }
    return kwh;
  }

  /** Audit view: record the last total on the ledger, then try to publish it again with `delta` added. */
  tamper(delta: number): { round: number; recorded: string; ledger: string; audit: string[] } | undefined {
    const last = this.last;
    if (!last) return undefined;
    if (!last.recorded) {
      this.ledger.record(recordFor(this.operator, last.evidence, last.total));
      last.recorded = true;
    }
    const forged = recordFor(this.operator, last.evidence, last.total + BigInt(delta));
    let ledger = 'accepted';
    try {
      this.ledger.record(forged);
    } catch (e) {
      ledger = `rejected: ${(e as Error).message}`;
    }
    return {
      round: last.round,
      recorded: String(this.ledger.totalOf(this.params.epoch, last.round)), // W
      ledger,
      audit: audit(forged, last.evidence, this.params.graph, this.registry).problems,
    };
  }
}
