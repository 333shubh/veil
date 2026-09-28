// Phase 4 gate: every performance claim in VEIL_RESEARCH.md next to the number measured for it.
// Run after e1, e2, e3, e4, e8 and e9: npm run claims   (writes experiments/results/claims.md)
import { readFileSync, writeFileSync } from 'node:fs';
import { ms } from './lib.ts';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./results/${name}.json`, import.meta.url), 'utf8'));
const e1 = load('e1');
const e2 = load('e2');
const e3 = load('e3');
const e4 = load('e4');
const e8 = load('e8');
const e9 = load('e9');

type E1Row = { scheme: string; k?: number; bits?: number; stats: { median: number; p95: number } };
const e1Row = (scheme: string, key: { k?: number; bits?: number }) =>
  (e1.rows as E1Row[]).find((r) => r.scheme.startsWith(scheme) && r.k === key.k && r.bits === key.bits)!;
const masking = (k: number) => e1Row('Veil masking', { k }).stats;
const whole = (k: number) => e1Row('Veil whole round', { k }).stats;
const paillier = (bits: number) => e1Row('Paillier', { bits }).stats;
const e2Row = (k: number, dropouts: boolean) => e2.rows.find((r: { k: number; dropouts: string }) => r.k === k && (r.dropouts === 'none') !== dropouts);
type E3Row = { scheme: string; n: number; coordinator: { median: number } };
const e3Rows = (match: (scheme: string) => boolean) => (e3.rows as E3Row[]).filter((r) => match(r.scheme));
const veilRows = e3Rows((s) => s === 'Veil (E7 k)');
const silentRows = e3Rows((s) => s.startsWith('Veil (E7 k),') && s.includes('silent'));
const coordinatorAt = (rows: E3Row[]) => rows.map((r) => `${ms(r.coordinator.median)} ms at N = ${r.n}`).join(', ');
const lastE8 = e8.rows.at(-1);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
type E4Row = { rate: number; published: number; exact: number };
const random = e4.random as E4Row[];
const published = random.reduce((a, r) => a + r.published, 0);
const exact = random.reduce((a, r) => a + r.exact, 0);
const lastFull = random.filter((r) => r.published === 20).at(-1)!;
type Crash = { variant: string; published: number; exact: number; aborted: number };
const crashes = e4.crash as Crash[];
const round54 = e2Row(54, false);
type E9Verified = { name: string; proofSample: number; rounds: number; aborted: number; liarLeftOut: number; liePublished: number };
const verified = e9.verified as E9Verified[];

const claims: [string, string, string, string][] = [
  [
    'Veil costs "under 1 ms" per report (original write-up)',
    'Gaps, row 8',
    `Masking median ${ms(masking(38).median)} ms at k = 38, ${ms(masking(80).median)} ms at k = 80 (p95 ${ms(masking(80).p95)}); the meter's whole round ${ms(whole(38).median)} ms at k = 38, ${ms(whole(80).median)} ms at k = 80 (E1)`,
    "Holds for masking; a meter's whole round costs more",
  ],
  [
    'Paillier costs "50 ms on 1 GHz" (original write-up)',
    'Gaps, row 8',
    `Encryption median ${ms(paillier(1024).median)} ms at 1024 bits, ${ms(paillier(2048).median)} ms at 2048 bits, OpenSSL on the same machine (E1)`,
    'Replaced by these measured numbers',
  ],
  [
    'A meter needs no modular exponentiation per report',
    'Verdict',
    `Masking is ChaCha20 and HMAC only (${ms(masking(38).median)} ms at k = 38 against ${ms(paillier(2048).median)} ms for Paillier-2048); each round also costs one Ed25519 signature for the active-set co-signature (E1)`,
    'Holds for the report; the hardened round adds one elliptic-curve signature per round, and verified mode a range proof',
  ],
  [
    "The operator's per-round work is linear in the number of meters",
    'Verdict',
    `Veil coordinator median ${coordinatorAt(veilRows)}; growth exponent ${e3.growth['Veil (E7 k)']}, against ${e3.growth['Veil on a complete graph']} on a complete graph and ${e3.growth['Paillier-2048']} for Paillier-2048 (E3)`,
    `${e3.growth['Veil (E7 k)'] < 1.15 ? 'Holds as measured' : 'Not linear as measured'}: meters reveal their own self-masks, so the coordinator rebuilds from shares only for meters that go silent (${coordinatorAt(silentRows)} with 1% silent after checking)`,
  ],
  [
    'A report is roughly 32 bytes before transport headers',
    'Implementation blueprint',
    `Report ${e2.reportBytes} bytes; a meter's whole round at k = 54 sends ${round54.sent} and receives ${round54.received} bytes without dropouts (E2)`,
    `Holds for the report; the rest of the round costs about ${Math.round((round54.sent - e2.reportBytes) / 54)} bytes sent and ${Math.round(round54.received / 54)} received per neighbour`,
  ],
  [
    'Setup and recovery messages scale with k, not with N',
    'Implementation blueprint',
    `Sent bytes grow with k (${e2Row(8, false).sent} at k = 8 to ${e2Row(80, false).sent} at k = 80); the announced sets are roster bitmaps, ${round54.announcements} bytes per round at N = 200 (E2)`,
    'Holds for what meters send; the set bitmaps still grow with N, 32 times more slowly than id lists; setup includes the O(N) roster',
  ],
  [
    'Sparse graphs use "20 to 30 percent of the resources of the complete-graph scheme" (Bell et al., cited)',
    'Related work',
    `At N = ${lastE8.n} (k = ${lastE8.sparse.k} against ${lastE8.complete.k}): setup ${pct(lastE8.ratio.setup)}, meter time ${pct(lastE8.ratio.meter)}, coordinator time ${pct(lastE8.ratio.coordinator)}, bytes ${pct(lastE8.ratio.bytes)} of the complete graph (E8)`,
    'Measured for Veil itself; the ratio keeps falling as N grows because k grows only with log N',
  ],
  [
    'Recovery gives the exact total of the active meters under dropouts',
    'Protocol, E4',
    `${exact}/${published} published rounds exact across 0-50% random dropout, every round published up to ${lastFull.rate * 100}%; with crashes after the deadline, ${crashes.map((c) => `${c.exact}/${c.published} exact and ${c.aborted} aborted (${c.variant})`).join('; ')} (E4)`,
    'Holds: every published total is exact; rounds are suppressed or abort rather than publish a wrong total',
  ],
  [
    'A meter that sees itself in the consistent final set can release its own round seed ("fast path", proposed without proof)',
    'Protocol',
    `Built as the release step, after t neighbours agree on the final set; argument in docs/rounds.md; every final-set split fails below t corrupt neighbours (test/attacks.test.ts); coordinator ${ms(veilRows[0]!.coordinator.median)} ms at N = ${veilRows[0]!.n} (E3)`,
    'Holds with the agreement check; without it the final set can be split to unmask a meter (experiments/results/final-split-phase7.md)',
  ],
  [
    'Range proofs in an optional verified mode catch false inputs',
    'Gaps, row 16',
    `${verified.map((v) => `${v.name}, ${pct(v.proofSample)} of proofs checked: ${v.aborted} aborted, liar left out ${v.liarLeftOut}, lie published ${v.liePublished} of ${v.rounds} rounds`).join('; ')}; a ${e9.costs.proofBytes}-byte proof takes ${ms(e9.costs.prove.median)} ms to make and ${ms(e9.costs.verify.median)} ms to check (E9)`,
    'Holds for out-of-range and inconsistent inputs; a false reading within range cannot be caught',
  ],
];

const md = [
  '# Claims against measurements',
  '',
  'Generated by `npm run claims` from experiments/results/e1, e2, e3, e4, e8 and e9 (each file records its machine and seed).',
  '',
  '| claim | where | measured | verdict |',
  '|---|---|---|---|',
  ...claims.map((c) => `| ${c.join(' | ')} |`),
];
writeFileSync(new URL('./results/claims.md', import.meta.url), md.join('\n') + '\n');
console.log(md.slice(4).join('\n'));
