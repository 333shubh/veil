// Phase 4 gate: every performance claim in VEIL_RESEARCH.md next to the number measured for it.
// Run after e1, e2, e3, e4 and e8: npm run claims   (writes experiments/results/claims.md)
import { readFileSync, writeFileSync } from 'node:fs';
import { ms } from './lib.ts';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./results/${name}.json`, import.meta.url), 'utf8'));
const e1 = load('e1');
const e2 = load('e2');
const e3 = load('e3');
const e4 = load('e4');
const e8 = load('e8');

type E1Row = { scheme: string; k?: number; bits?: number; stats: { median: number; p95: number } };
const e1Row = (scheme: string, key: { k?: number; bits?: number }) =>
  (e1.rows as E1Row[]).find((r) => r.scheme.startsWith(scheme) && r.k === key.k && r.bits === key.bits)!;
const masking = (k: number) => e1Row('Veil masking', { k }).stats;
const whole = (k: number) => e1Row('Veil whole round', { k }).stats;
const paillier = (bits: number) => e1Row('Paillier', { bits }).stats;
const e2Row = (k: number, dropouts: boolean) => e2.rows.find((r: { k: number; dropouts: string }) => r.k === k && (r.dropouts === 'none') !== dropouts);
const e3Rows = (scheme: string) => e3.rows.filter((r: { scheme: string }) => r.scheme === scheme);
const lastE8 = e8.rows.at(-1);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const upTo30 = e4.random.filter((r: { rate: number }) => r.rate <= 0.3);
const exactUpTo30 = upTo30.reduce((a: number, r: { exact: number }) => a + r.exact, 0);
const roundsUpTo30 = upTo30.length * 20;
const veilRows = e3Rows('Veil (E7 k)');

const claims: [string, string, string, string][] = [
  [
    'Veil costs "under 1 ms" per report (original write-up)',
    'Gaps, row 8',
    `Masking median ${ms(masking(38).median)} ms at k = 38, ${ms(masking(80).median)} ms at k = 80 (p95 ${ms(masking(80).p95)}); the meter's whole round ${ms(whole(38).median)} ms at k = 38, ${ms(whole(80).median)} ms at k = 80 (E1, laptop)`,
    'Holds for masking on a laptop; a whole round costs more, and meter-class hardware is not yet measured',
  ],
  [
    'Paillier costs "50 ms on 1 GHz" (original write-up)',
    'Gaps, row 8',
    `Encryption median ${ms(paillier(1024).median)} ms at 1024 bits, ${ms(paillier(2048).median)} ms at 2048 bits, OpenSSL on the same laptop (E1)`,
    'Replaced by these laptop numbers; the 1 GHz figure is unmeasured and still needs a Pi or Cortex-M run',
  ],
  [
    'A meter needs no modular exponentiation per report',
    'Verdict',
    `Masking is ChaCha20 and HMAC only (${ms(masking(38).median)} ms at k = 38 against ${ms(paillier(2048).median)} ms for Paillier-2048); each round also costs one Ed25519 signature for the active-set co-signature (E1)`,
    'Holds for the report; the hardened round adds one elliptic-curve signature per round',
  ],
  [
    "The operator's per-round work is linear in the number of meters",
    'Verdict',
    `Veil coordinator median ${veilRows.map((r: { n: number; coordinator: { median: number } }) => `${ms(r.coordinator.median)} ms at N = ${r.n}`).join(', ')}; growth exponent ${e3.growth['Veil (E7 k)']}, against ${e3.growth['Veil on a complete graph']} on a complete graph and ${e3.growth['Paillier-2048']} for Paillier-2048 (E3)`,
    `${e3.growth['Veil (E7 k)'] < 1.15 ? 'Holds' : 'Not linear as measured'}: k and t grow with log N, and rebuilding each self-mask from t shares costs O(t^2)`,
  ],
  [
    'A report is roughly 32 bytes before transport headers',
    'Implementation blueprint',
    `Report ${e2.reportBytes} bytes; a meter's whole round at k = 54 sends ${e2Row(54, false).sent} and receives ${e2Row(54, false).received} bytes without dropouts (E2)`,
    'Holds for the report; the recovery exchange every round costs about 110 bytes per neighbour each way',
  ],
  [
    'Setup and recovery messages scale with k, not with N',
    'Implementation blueprint',
    `Sent bytes grow with k (${e2Row(8, false).sent} at k = 8 to ${e2Row(80, false).sent} at k = 80); the active- and final-set announcements are ${e2Row(54, false).announcements} bytes at N = 200 and grow as 8N (E2)`,
    'Holds for what meters send; announcements as implemented grow with N (a neighbour bitmap would fix it); setup includes the O(N) roster',
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
    `${exactUpTo30}/${roundsUpTo30} rounds exact at 0-30% random dropout; ${e4.crash.exact}/${e4.crash.published} published rounds exact with crashes between phases, ${e4.crash.aborted} aborted (E4)`,
    'Holds: every published total is exact; rounds abort rather than publish a wrong total',
  ],
  [
    'ML-DSA-44 signing takes about 183 ms on a Cortex-M0+ (cited)',
    'Limitations',
    'Not re-measured: no Cortex-M board here',
    'Stays a cited number',
  ],
];

const md = [
  '# Claims against measurements',
  '',
  'Generated by `npm run claims` from experiments/results/e1, e2, e3, e4 and e8 (each file records its machine and seed).',
  '',
  '| claim | where | measured | verdict |',
  '|---|---|---|---|',
  ...claims.map((c) => `| ${c.join(' | ')} |`),
];
writeFileSync(new URL('./results/claims.md', import.meta.url), md.join('\n') + '\n');
console.log(md.slice(4).join('\n'));
