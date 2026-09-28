// E9: what stops a meter that lies? The plausibility checks on published totals (the default), and verified mode:
// Pedersen commitments with range proofs, the aggregate check, and validators checking proofs. Measures what each
// catches and what verified mode costs.
// Run: npm run e9   (writes experiments/results/e9.md and e9.json)
import { makeLiar } from '../src/adversary.ts';
import { hkdf, u32Stream } from '../src/crypto.ts';
import { Ledger, recordFor } from '../src/ledger.ts';
import { simulateLoad } from '../src/load.ts';
import { choose, DESIGN, PLAUSIBLE, VERIFIED_BITS } from '../src/params.ts';
import { commit, prove, proofBytes, verify } from '../src/pedersen.ts';
import { implausible, type Plausibility } from '../src/plausibility.ts';
import type { MeterId, RoundEvidence } from '../src/protocol.ts';
import { coordinatorMs, everyone, runRound, setupGroup } from '../src/simulation.ts';
import { environment, ms, stats, timed, writeResult } from './lib.ts';
import { reportBytes } from './wire.ts';

const HOMES = 200;
const INTERVAL = 10; // seconds per round
const EPISODE = 180; // rounds a lie lasts: 30 minutes
const EPISODES = 60;
const LIES = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000]; // W added by one meter
const RAMP = 10 * 60; // seconds over which the slow liar ramps up its lie
const started = performance.now();
const next = u32Stream(hkdf(Buffer.from('veil E9 seed 1'), Buffer.from('e9')));
const pick = (n: number) => Math.floor((next() / 2 ** 32) * n);

// Part A. Plausibility bounds from one simulated day, evaluated on another. The published total equals the sum of the
// readings (every published Veil total is exact), so a liar's total is the true total plus its lie.
const homes: MeterId[] = Array.from({ length: HOMES }, (_, i) => i + 1);
const totals = (seed: string) => {
  const load = simulateLoad(homes, 1, INTERVAL, seed);
  return Array.from({ length: load.samples }, (_, s) => homes.reduce((a, h) => a + load.power.get(h)![s]!, 0));
};
const calibration = totals('veil E9 calibration day');
const means = calibration.map((x) => x / HOMES);
const observed = {
  min: Math.min(...means),
  max: Math.max(...means),
  step: Math.max(...means.slice(1).map((m, i) => Math.abs(m - means[i]!))),
};
const range = observed.max - observed.min;
const derived: Plausibility = {
  minPerHome: Math.floor(observed.min - 0.25 * range),
  maxPerHome: Math.ceil(observed.max + 0.25 * range),
  maxStepPerHome: Math.ceil(2 * observed.step),
};
const matches = JSON.stringify(derived) === JSON.stringify(PLAUSIBLE);
console.log(`[e9] calibration: mean per home ${observed.min.toFixed(1)}..${observed.max.toFixed(1)} W, largest step ${observed.step.toFixed(2)} W; bounds ${JSON.stringify(derived)} (params.ts ${matches ? 'matches' : 'DIFFERS'})`);

const day = totals('veil E9 evaluation day');
const flagged = (series: number[]) => series.map((x, s) => implausible({ total: BigInt(Math.round(x)), homes: HOMES }, PLAUSIBLE, s > 0 ? { total: BigInt(Math.round(series[s - 1]!)), homes: HOMES } : undefined).length > 0);
const falseAlarms = flagged(day).filter(Boolean).length;
console.log(`[e9] false alarms on the clean evaluation day: ${falseAlarms}/${day.length} rounds`);

/** One liar adds `lie` W for an episode; `ramp` spreads the lie's onset over RAMP seconds. */
function episodes(lie: number, ramp: boolean) {
  let caught = 0;
  let flaggedRounds = 0;
  for (let e = 0; e < EPISODES; e++) {
    const start = 1 + pick(day.length - EPISODE - 1);
    const series = [...day];
    for (let s = start; s < start + EPISODE; s++) series[s]! += ramp ? lie * Math.min(1, ((s - start + 1) * INTERVAL) / RAMP) : lie;
    const f = flagged(series).slice(start, start + EPISODE);
    if (f.some(Boolean)) caught++;
    flaggedRounds += f.filter(Boolean).length;
  }
  return { lie, caught, flaggedShare: flaggedRounds / (EPISODES * EPISODE) };
}
const sudden = LIES.map((lie) => episodes(lie, false));
const ramped = LIES.map((lie) => episodes(lie, true));
for (const [name, rows] of [['sudden', sudden], ['ramped', ramped]] as const) {
  console.log(`[e9] ${name} lies caught: ${rows.map((r) => `${r.lie / 1000} kW ${r.caught}/${EPISODES}`).join(', ')}`);
}

// Part B. Verified mode against each kind of lie, through the protocol, in a group of 50 at E7's k and t.
const small = 50;
const { k: sk, t: st } = choose(small, DESIGN)!;
const smallIds: MeterId[] = Array.from({ length: small }, (_, i) => i + 1);
const readingsFor = () => new Map(smallIds.map((id) => [id, BigInt(pick(4_000))]));
const LIE = 50_000n; // beyond the 16-bit range, so no valid proof exists
const IN_RANGE_LIE = 5_000n;
const B_ROUNDS = 10;
const SAMPLE = 0.1;
const SAMPLED_ROUNDS = 100;

function trial(name: string, proofSample: number, rounds: number, lie: (g: ReturnType<typeof setupGroup>, liar: MeterId) => void) {
  const g = setupGroup(smallIds, 1, sk, st, 3, { rangeBits: VERIFIED_BITS, proofSample });
  const strict = new Ledger(g.operator.publicKey, g.registry, { checkProofs: true });
  strict.anchor(g.anchor);
  const liar = smallIds[0]!;
  lie(g, liar);
  const out = { name, proofSample, rounds, aborted: 0, liarLeftOut: 0, liePublished: 0, validatorsRefused: 0 };
  for (let r = 0; r < rounds; r++) {
    const readings = readingsFor();
    const trace = runRound(g, r, readings, everyone(smallIds));
    const res = trace.result;
    if (res.status === 'aborted') out.aborted++;
    if (res.status !== 'published') continue;
    const truth = res.evidence.final.reduce((a, id) => a + readings.get(id)!, 0n);
    if (!res.evidence.final.includes(liar)) out.liarLeftOut++;
    else if (res.total !== truth) {
      out.liePublished++;
      try {
        strict.record(recordFor(g.operator, res.evidence, res.total), new Map(trace.reports.map((x) => [x.id, x.proof!])));
      } catch {
        out.validatorsRefused++;
      }
    }
  }
  console.log(`[e9] ${name}, proofs sampled ${proofSample}: ${JSON.stringify(out)}`);
  return out;
}
const verified = [
  trial('changes its masked value only', 1, B_ROUNDS, (g, id) => makeLiar(g, id, { masked: LIE })),
  trial('claims an out-of-range reading', 1, B_ROUNDS, (g, id) => makeLiar(g, id, { claimed: LIE })),
  trial('claims an out-of-range reading', SAMPLE, SAMPLED_ROUNDS, (g, id) => makeLiar(g, id, { claimed: LIE })),
  trial('claims a false reading within range', 1, B_ROUNDS, (g, id) => {
    const m = g.meters.get(id)!;
    const honest = m.report.bind(m);
    m.report = (round, reading) => honest(round, reading + IN_RANGE_LIE);
  }),
];

// Part C. Costs at N = 200, E7's k and t, plain and verified.
const { k, t } = choose(HOMES, DESIGN)!;
const C_ROUNDS = 5;
const ctx = Buffer.from('e9 cost context');
const proveMs: number[] = [];
const verifyMs: number[] = [];
const commitMs: number[] = [];
for (let i = 0; i < 200; i++) {
  const x = BigInt(pick(20_000) - 5_000);
  const r = BigInt(pick(2 ** 31)) * 7919n;
  commitMs.push(timed(() => commit(x, r))[1]);
  const [proof, p] = timed(() => prove(x, r, VERIFIED_BITS, ctx));
  proveMs.push(p);
  verifyMs.push(timed(() => verify(commit(x, r), proof, VERIFIED_BITS, ctx))[1]);
}
function costs(label: string, rangeBits: number | undefined, proofSample: number) {
  const g = setupGroup(homes, 1, k, t, 3, { rangeBits, proofSample });
  const plainLedger = new Ledger(g.operator.publicKey, g.registry);
  const strictLedger = new Ledger(g.operator.publicKey, g.registry, { checkProofs: true });
  plainLedger.anchor(g.anchor);
  strictLedger.anchor(g.anchor);
  const meterReport: number[] = [];
  const coord: number[] = [];
  const close: number[] = [];
  const ledger: number[] = [];
  const ledgerProofs: number[] = [];
  for (let r = 0; r < C_ROUNDS; r++) {
    const readings = new Map(homes.map((id) => [id, BigInt(pick(4_000))]));
    const trace = runRound(g, r, readings, everyone(homes), (_, phase, dt) => {
      if (phase === 'report') meterReport.push(dt);
    });
    if (trace.result.status !== 'published') throw new Error(`${label} round ${r}: ${trace.result.status}`);
    const { total, evidence } = trace.result as { total: bigint; evidence: RoundEvidence };
    coord.push(coordinatorMs(trace));
    close.push(trace.ms.close);
    const record = recordFor(g.operator, evidence, total);
    ledger.push(timed(() => plainLedger.record(record))[1]);
    if (rangeBits) ledgerProofs.push(timed(() => strictLedger.record(record, new Map(trace.reports.map((x) => [x.id, x.proof!]))))[1]);
  }
  const row = {
    label,
    report: stats(meterReport).median,
    close: stats(close).median,
    coordinator: stats(coord).median,
    ledger: stats(ledger).median,
    ledgerProofs: ledgerProofs.length ? stats(ledgerProofs).median : undefined,
  };
  console.log(`[e9] costs ${label}: ${JSON.stringify(row)}`);
  return row;
}
const costRows = [costs('plain', undefined, 1), costs('verified, every proof checked', VERIFIED_BITS, 1), costs(`verified, ${SAMPLE * 100}% of proofs checked`, VERIFIED_BITS, SAMPLE)];

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const kw = (w: number) => `${w / 1000} kW`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const md = [
  '# E9: what stops a meter that lies?',
  '',
  `Generated by \`npm run e9\` on ${new Date().toISOString().slice(0, 10)}: ${environment()}. Run time ${seconds} s.`,
  '',
  'Masking hides each input, so a meter can report any value and the published total moves by its lie. Two defences: ' +
    'plausibility checks on each published total (the default), and verified mode, in which each report carries a ' +
    `Pedersen commitment on ristretto255 and a ${VERIFIED_BITS}-bit range proof (readings from ${-(2 ** (VERIFIED_BITS - 1))} ` +
    `to ${2 ** (VERIFIED_BITS - 1) - 1} W), the coordinator checks every total against the sum of the commitments, and ` +
    'validators can check the proofs.',
  '',
  '## Plausibility checks',
  '',
  `Bounds come from one simulated summer day of ${HOMES} homes at ${INTERVAL}-second rounds (\`src/load.ts\`): the ` +
    `group's mean load per home ranged from ${observed.min.toFixed(1)} to ${observed.max.toFixed(1)} W and moved at most ` +
    `${observed.step.toFixed(2)} W per home between rounds. The bounds widen the range by a quarter on each side and ` +
    `double the step: mean per home in [${PLAUSIBLE.minPerHome}, ${PLAUSIBLE.maxPerHome}] W, step at most ` +
    `${PLAUSIBLE.maxStepPerHome} W per home (\`PLAUSIBLE\` in src/params.ts; derived again here: ${matches ? 'same' : 'DIFFERENT'}).`,
  '',
  `On a second simulated day with no liar, ${falseAlarms} of ${day.length} rounds were flagged. Then one meter lies for ` +
    `${EPISODE} rounds (30 minutes) from a random start, ${EPISODES} times per size: suddenly, or ramping up over ` +
    `${RAMP / 60} minutes. A lie is caught if any of its rounds is flagged.`,
  '',
  `| lie by one meter | sudden: caught | sudden: rounds flagged | ramped: caught | ramped: rounds flagged |`,
  '|---|---|---|---|---|',
  ...sudden.map((s, i) => `| ${kw(s.lie)} | ${s.caught}/${EPISODES} | ${pct(s.flaggedShare)} | ${ramped[i]!.caught}/${EPISODES} | ${pct(ramped[i]!.flaggedShare)} |`),
  '',
  '## Verified mode',
  '',
  `Group of ${small} at E7's k = ${sk}, t = ${st}; one meter lies in every round. "Out of range" adds ${LIE} W, which no ` +
    `${VERIFIED_BITS}-bit proof can cover; "within range" adds ${IN_RANGE_LIE} W and proves it honestly.`,
  '',
  '| the liar | proofs checked by the coordinator | rounds | aborted | liar left out | lie published | of those, refused by validators checking every proof |',
  '|---|---|---|---|---|---|---|',
  ...verified.map((v) => `| ${v.name} | ${pct(v.proofSample)} | ${v.rounds} | ${v.aborted} | ${v.liarLeftOut} | ${v.liePublished} | ${v.validatorsRefused} |`),
  '',
  'A meter that changes its masked value without its commitment makes the aggregate check fail, whatever share of ' +
    'proofs is checked. A meter that claims an out-of-range reading is left out when its proof is checked; when the ' +
    'coordinator samples proofs, the lies it misses are published and validators that check every proof refuse to ' +
    'record them. A false reading within range is a valid reading as far as any proof can tell.',
  '',
  '## Cost of verified mode',
  '',
  `One proof is ${proofBytes(VERIFIED_BITS)} bytes and a commitment 32, on top of the ${reportBytes}-byte report. Pure ` +
    `JavaScript (@noble/curves), one laptop core, ${proveMs.length} runs:`,
  '',
  '| operation | median (ms) | p95 (ms) |',
  '|---|---|---|',
  `| commit | ${ms(stats(commitMs).median)} | ${ms(stats(commitMs).p95)} |`,
  `| prove (${VERIFIED_BITS} bits) | ${ms(stats(proveMs).median)} | ${ms(stats(proveMs).p95)} |`,
  `| verify (${VERIFIED_BITS} bits) | ${ms(stats(verifyMs).median)} | ${ms(stats(verifyMs).p95)} |`,
  '',
  `Group of ${HOMES}, k = ${k}, t = ${t}, no dropouts, ${C_ROUNDS} rounds per row, medians:`,
  '',
  '| mode | meter report (ms) | coordinator close (ms) | coordinator, whole round (ms) | validators, arithmetic (ms) | validators, every proof (ms) |',
  '|---|---|---|---|---|---|',
  ...costRows.map((c) => `| ${c.label} | ${ms(c.report)} | ${ms(c.close)} | ${ms(c.coordinator)} | ${ms(c.ledger)} | ${c.ledgerProofs === undefined ? '' : ms(c.ledgerProofs)} |`),
];
writeResult('e9', md, {
  environment: environment(),
  seconds: Number(seconds),
  observed,
  derived,
  plausible: PLAUSIBLE,
  matches,
  falseAlarms,
  rounds: day.length,
  sudden,
  ramped,
  verified,
  costs: { commit: stats(commitMs), prove: stats(proveMs), verify: stats(verifyMs), proofBytes: proofBytes(VERIFIED_BITS), rows: costRows },
});
console.log(`[e9] done in ${seconds} s`);
