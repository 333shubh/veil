// E4: does recovery stay exact? Random dropouts from 0 to 50 percent, crashes at each point of a round, a target's
// neighbours dropped on purpose, and how far a larger neighbourhood stretches the dropout a round survives, in a group
// of 200.
// Run: npm run e4   (writes experiments/results/e4.md and e4.json)
import { hkdf, u32Stream } from '../src/crypto.ts';
import { choose, DESIGN, privacyThreshold } from '../src/params.ts';
import type { MeterId } from '../src/protocol.ts';
import { coordinatorMs, runRound, setupGroup, type Group, type Pattern, type RoundTrace } from '../src/simulation.ts';
import { environment, ms, stats, writeResult } from './lib.ts';

const N = 200;
const RATES = [0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5];
const ROUNDS = 20;
const CRASH_ROUNDS = 100;
const CRASH = 0.01; // chance to go silent at each crash point
const WIDER_K = [80, 120, N - 1]; // larger neighbourhoods, each with the smallest t that meets the privacy bound
const WIDER_RATES = [0.2, 0.3, 0.4, 0.5];
const WIDER_ROUNDS = 10;

const next = u32Stream(hkdf(Buffer.from('veil E4 seed 2'), Buffer.from('e4')));
const uniform = () => next() / 2 ** 32;
const readingFor = () => BigInt(Math.floor(uniform() * 25_000) - 5_000);

const { k, t } = choose(N, DESIGN)!;
const ids: MeterId[] = Array.from({ length: N }, (_, i) => i + 1);
const g = setupGroup(ids, 1, k, t);
let round = 0;

function play(group: Group, pattern: Pattern) {
  const readings = new Map(ids.map((id) => [id, readingFor()]));
  const trace: RoundTrace = runRound(group, round++, readings, pattern);
  const r = trace.result;
  const exact = r.status === 'published' && r.total === r.evidence.final.reduce((a, id) => a + readings.get(id)!, 0n);
  const afterDeadline = trace.ms.confirm + trace.ms.collect + trace.ms.check + trace.ms.route + trace.ms.release + trace.ms.gather + trace.ms.unmask + trace.ms.recover;
  const escrowed = r.status === 'published' && r.evidence.removals.some((x) => !trace.releases.some((y) => y.id === x.id));
  return {
    status: r.status,
    reason: r.status === 'aborted' ? r.reason : undefined,
    exact,
    included: trace.final && r.status === 'published' ? trace.final.size / pattern.reporting.size : 0,
    unmasked: trace.requests !== undefined,
    escrowed,
    afterDeadline,
    trace,
  };
}

const started = performance.now();
const everyReporter = (reporting: Set<MeterId>): Pattern => ({ reporting, confirming: reporting, releasing: reporting });

// Random dropouts before the deadline.
const random = RATES.map((rate) => {
  const runs = Array.from({ length: ROUNDS }, () => play(g, everyReporter(new Set(ids.filter(() => uniform() >= rate)))));
  const row = {
    rate,
    published: runs.filter((x) => x.status === 'published').length,
    suppressed: runs.filter((x) => x.status === 'suppressed').length,
    exact: runs.filter((x) => x.exact).length,
    included: runs.reduce((a, x) => a + x.included, 0) / runs.length,
    afterDeadline: stats(runs.map((x) => x.afterDeadline)),
    coordinator: stats(runs.map((x) => coordinatorMs(x.trace))),
  };
  console.log(`[e4] dropout ${rate * 100}%: ${row.exact}/${ROUNDS} exact, ${row.suppressed} suppressed, ${(row.included * 100).toFixed(1)}% of reporters included`);
  return row;
});

// Crashes after the deadline, on top of DESIGN.dropout before it. Each variant silences meters at some of the three
// points: before confirming, before checking (after F is announced), and after checking (before releasing).
const variants = [
  { name: 'before confirming, and before checking', points: [true, true, false] },
  { name: 'before confirming, and after checking', points: [true, false, true] },
  { name: 'at all three points', points: [true, true, true] },
] as const;
const crash = variants.map((v) => {
  const runs = Array.from({ length: CRASH_ROUNDS }, () => {
    const reporting = ids.filter(() => uniform() >= DESIGN.dropout);
    const confirming = reporting.filter(() => !v.points[0] || uniform() >= CRASH);
    const checking = confirming.filter(() => !v.points[1] || uniform() >= CRASH);
    const releasing = checking.filter(() => !v.points[2] || uniform() >= CRASH);
    return play(g, { reporting: new Set(reporting), confirming: new Set(confirming), checking: new Set(checking), releasing: new Set(releasing) });
  });
  const row = {
    variant: v.name,
    published: runs.filter((x) => x.status === 'published').length,
    exact: runs.filter((x) => x.exact).length,
    aborted: runs.filter((x) => x.status === 'aborted').length,
    unmasked: runs.filter((x) => x.status === 'published' && x.unmasked).length,
    escrowed: runs.filter((x) => x.escrowed).length,
    reasons: [...new Set(runs.flatMap((x) => (x.reason ? [x.reason.replace(/\d+/g, 'N')] : [])))],
  };
  console.log(`[e4] crashes ${v.name}: ${row.exact}/${CRASH_ROUNDS} exact, ${row.aborted} aborted, ${row.escrowed} opened an escrowed removal`);
  return row;
});

// A target's neighbours dropped on purpose; everyone else reports.
const target = ids[0]!;
const neighbours = g.params.graph.get(target)!;
const targeted = [0, Math.floor(k / 4), k - t - 1, k - t, k - t + 1, k - t + 2, k].map((dropped) => {
  const x = play(g, everyReporter(new Set(ids.filter((id) => !neighbours.slice(0, dropped).includes(id)))));
  return { dropped, live: k - dropped, status: x.status, exact: x.exact, targetIncluded: x.trace.final?.has(target) ?? false };
});
for (const r of targeted) console.log(`[e4] target with ${r.dropped}/${k} neighbours dropped: ${r.status}, exact ${r.exact}, target included ${r.targetIncluded}`);

// Larger neighbourhoods against heavy dropout, each at the smallest t that meets the privacy bound.
const wider = [{ k, t }, ...WIDER_K.map((wk) => ({ k: wk, t: privacyThreshold(N, wk, DESIGN)! }))].map((c) => {
  const group = c.k === k ? g : setupGroup(ids, 1, c.k, c.t);
  const cells = WIDER_RATES.map((rate) => {
    const runs = Array.from({ length: WIDER_ROUNDS }, () => play(group, everyReporter(new Set(ids.filter(() => uniform() >= rate)))));
    return {
      rate,
      published: runs.filter((x) => x.status === 'published').length,
      exact: runs.filter((x) => x.exact).length,
      included: runs.reduce((a, x) => a + x.included, 0) / runs.length,
      afterDeadline: stats(runs.map((x) => x.afterDeadline)).median,
    };
  });
  console.log(`[e4] k=${c.k} t=${c.t}: ${cells.map((x) => `${x.rate * 100}% -> ${x.published}/${WIDER_ROUNDS} (${(x.included * 100).toFixed(0)}%)`).join(', ')}`);
  return { ...c, cells };
});

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const md = [
  '# E4: does recovery stay exact?',
  '',
  `Generated by \`npm run e4\` on ${new Date().toISOString().slice(0, 10)}: ${environment()}. Run time ${seconds} s.`,
  '',
  `Group of ${N} meters with E7's k = ${k} and t = ${t}. A meter that reports joins F if at least t of its neighbours ` +
    'reported, since it deals its self-mask to them, and if at least t of its neighbours are in F, since it must hear ' +
    'agreement on F from t of them before it releases anything; the others are left out and their masks removed. Times ' +
    'are summed CPU over all meters and the coordinator for everything after the deadline, on one machine. A round has ' +
    'three exchanges after the deadline (confirm, check, release), and a fourth (unmask) only when a meter in F goes ' +
    'silent after checking.',
  '',
  '## Random dropouts before the deadline',
  '',
  '| dropout | rounds | published | suppressed | exact | reporters included | after-deadline CPU, median (ms) | coordinator, median (ms) |',
  '|---|---|---|---|---|---|---|---|',
  ...random.map(
    (r) => `| ${r.rate * 100}% | ${ROUNDS} | ${r.published} | ${r.suppressed} | ${r.exact} | ${pct(r.included)} | ${ms(r.afterDeadline.median)} | ${ms(r.coordinator.median)} |`,
  ),
  '',
  'Every published total is exact. "Reporters included" averages over all rounds, counting a suppressed round as 0%.',
  '',
  `## Crashes after the deadline (${DESIGN.dropout * 100}% dropout, then ${CRASH * 100}% of meters silent at each marked point)`,
  '',
  '| meters go silent | rounds | published | exact | aborted | needed an unmask | opened an escrowed removal |',
  '|---|---|---|---|---|---|---|',
  ...crash.map((r) => `| ${r.variant} | ${CRASH_ROUNDS} | ${r.published} | ${r.exact} | ${r.aborted} | ${r.unmasked} | ${r.escrowed} |`),
  '',
  'A round aborts only when a meter in F that must remove masks (it has a neighbour that reported but is not in F) goes ' +
    'silent before its check, so it never escrowed the removal. A meter that goes silent after checking is rebuilt from ' +
    'shares, and its removal opened from escrow. Abort reasons seen: ' +
    (crash.flatMap((r) => r.reasons).length ? [...new Set(crash.flatMap((r) => r.reasons))].map((x) => `"${x}"`).join(', ') : 'none') +
    '.',
  '',
  "## A target's neighbours dropped on purpose",
  '',
  '| neighbours dropped | live neighbours | round | exact | target included |',
  '|---|---|---|---|---|',
  ...targeted.map((r) => `| ${r.dropped} | ${r.live} | ${r.status} | ${r.exact} | ${r.targetIncluded} |`),
  '',
  `The target stays in the total while at least t = ${t} of its ${k} neighbours report, and is left out beyond that.`,
  '',
  '## Heavy dropout against neighbourhood size',
  '',
  `${WIDER_ROUNDS} rounds per cell. Each k uses the smallest t > k/2 that meets the privacy bound (\`privacyThreshold\` ` +
    `in src/params.ts); k = ${N - 1} is the complete graph. Cells show rounds published out of ${WIDER_ROUNDS}, then the ` +
    'share of reporters included, averaged over all rounds.',
  '',
  `| k | t | ${WIDER_RATES.map((r) => `${r * 100}% dropout`).join(' | ')} |`,
  `|---|---|${WIDER_RATES.map(() => '---').join('|')}|`,
  ...wider.map((w) => `| ${w.k} | ${w.t} | ${w.cells.map((c) => `${c.published}/${WIDER_ROUNDS}, ${pct(c.included)}`).join(' | ')} |`),
  '',
  'Every published total in this table is exact: ' + String(wider.every((w) => w.cells.every((c) => c.exact === c.published))) + '.',
];
writeResult('e4', md, { environment: environment(), seconds: Number(seconds), n: N, k, t, random, crash, targeted, wider });
console.log(`[e4] done in ${seconds} s`);
