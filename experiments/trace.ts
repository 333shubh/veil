// Phase 7 gate: every number in the write-up traces to an experiment or a source. Each paragraph, list item or table
// row that states a number must cite at least one tag, and every number in it must appear in a file it cites: an
// experiment's result, the code that fixes a constant, or a source's quoted text in docs/sources.md. A table row
// without its own tag inherits the tags of the paragraph just above the table.
import { readFileSync } from 'node:fs';
import { writeResult } from './lib.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const FILES: Record<string, string> = {
  E1: 'experiments/results/e1.md',
  E2: 'experiments/results/e2.md',
  E3: 'experiments/results/e3.md',
  E4: 'experiments/results/e4.md',
  E5: 'experiments/results/e5.md',
  E6: 'experiments/results/e6.md',
  E7: 'experiments/results/e7.md',
  E8: 'experiments/results/e8.md',
  E9: 'experiments/results/e9.md',
  claims: 'experiments/results/claims.md',
  dropout: 'experiments/results/india-dropout.md',
  load: 'experiments/results/load-validation.md',
  indist: 'experiments/results/indistinguishability.md',
  soak: 'experiments/results/demo-soak.md',
  params: 'src/params.ts',
  wire: 'experiments/wire.ts',
  exactness: 'test/exactness.test.ts',
  attacks: 'test/attacks.test.ts',
  verified: 'test/verified.test.ts',
  consortium: 'test/consortium.test.ts',
  split: 'experiments/results/final-split-phase7.md',
  rounds: 'docs/rounds.md',
  demo: 'demo/engine.ts',
};

/** docs/sources.md: one `- [S<n>] ... Quote: "..."` line per source; a source's numbers must be in its quote. */
const sources = new Map<string, string>();
for (const line of read('docs/sources.md').split(/\r?\n/)) {
  const m = /^- \[(S\d+)\].*?Quote: (.*)$/.exec(line);
  if (m) sources.set(m[1]!, m[2]!);
}

const plain = (s: string) => s.replace(/(?<=\d)[,_](?=\d)/g, '');
const NUMBER = /(?<![\w.\-^/])(?:2\^-?\d+|\d(?:[\d,]*\d)?(?:\.\d+)?)(?![\w^])/g; // 2^-40 counts as one number
const TAG = /\[(E\d|S\d+|claims|dropout|load|indist|soak|params|wire|exactness|attacks|verified|consortium|split|rounds|demo)\]/g;

/** Paragraphs, list items and table rows, without fenced code, headings, inline code and link targets. */
function units(doc: string): string[] {
  const out: string[] = [];
  let para: string[] = [];
  let fenced = false;
  const flush = () => {
    if (para.length) out.push(para.join(' '));
    para = [];
  };
  for (const line of doc.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced || line.startsWith('#') || !line.trim()) {
      flush();
      continue;
    }
    if (/^\s*([-*]|\d+\.|\|)/.test(line)) flush();
    para.push(line);
    if (line.trimStart().startsWith('|')) flush();
  }
  flush();
  return out.map((u) =>
    u
      .replace(/`[^`]*`/g, ' ')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/^\s*\d+\.\s/, ' '),
  );
}

/**
 * An HTML page: text split at block elements, with script, style and anything marked data-trace="skip" left out
 * (chapter stamps, step numbers, live readouts filled in by code). Citations are written in the text as [E1] etc.
 */
const BLOCK = new Set(['p', 'li', 'h1', 'h2', 'h3', 'div', 'section', 'article', 'td', 'ul', 'ol', 'footer', 'aside', 'nav', 'main', 'header', 'table', 'tr', 'body']);
const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'canvas']);
function htmlUnits(doc: string): string[] {
  const out: string[] = [];
  const stack: { name: string; skip: boolean }[] = [];
  let text = '';
  const flush = () => {
    if (text.trim()) out.push(text.replace(/&nbsp;|&amp;|&[a-z]+;/g, ' ').replace(/\s+/g, ' '));
    text = '';
  };
  const skipping = () => stack.some((e) => e.skip);
  const body = doc
    .replace(/<head[\s\S]*?<\/head>/, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<(\/)?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      if (!skipping()) text += m[4];
      continue;
    }
    text += ' '; // a tag separates words, so "[E1]" and "0.128" never run together
    const name = m[2]!.toLowerCase();
    if (BLOCK.has(name)) flush();
    if (VOID.has(name) || m[3]!.trimEnd().endsWith('/')) continue;
    if (m[1]) {
      const i = stack.map((e) => e.name).lastIndexOf(name);
      if (i >= 0) stack.length = i;
    } else stack.push({ name, skip: /data-trace="skip"/.test(m[3]!) });
  }
  flush();
  return out;
}

const problems: string[] = [];
let checkedUnits = 0;
let checkedNumbers = 0;
const docs = process.argv.slice(2).length ? process.argv.slice(2) : ['REPORT.md', 'DATA-PROTECTION.md', 'demo/index.html'];
const cache = new Map<string, string>();
const textOf = (tag: string) => {
  if (!cache.has(tag)) cache.set(tag, plain(tag.startsWith('S') ? (sources.get(tag) ?? '') : read(FILES[tag]!)));
  return cache.get(tag)!;
};

for (const doc of docs) {
  let caption: string[] = [];
  for (const unit of doc.endsWith('.html') ? htmlUnits(read(doc)) : units(read(doc))) {
    const row = unit.trimStart().startsWith('|');
    let tags = [...new Set([...unit.matchAll(TAG)].map((m) => m[1]!))];
    if (!row) caption = tags;
    else if (!tags.length) tags = caption;
    const body = unit.replace(TAG, ' ');
    const numbers = [...body.matchAll(NUMBER)].map((m) => plain(m[0]));
    if (!numbers.length) continue;
    checkedUnits++;
    const where = `${doc}: "${unit.trim().slice(0, 90)}…"`;
    if (!tags.length) {
      problems.push(`${where} states ${numbers.join(', ')} with no citation`);
      continue;
    }
    for (const tag of tags) if (tag.startsWith('S') ? !sources.has(tag) : !FILES[tag]) problems.push(`${where} cites unknown [${tag}]`);
    for (const n of numbers) {
      checkedNumbers++;
      const pattern = new RegExp(`(?<![\\d.])${n.replace(/[.^]/g, '\\$&')}(?![\\d])`);
      if (!tags.some((t) => pattern.test(textOf(t)))) problems.push(`${where}: ${n} is not in ${tags.map((t) => `[${t}]`).join(' ')}`);
    }
  }
}

const md = [
  '# Trace check (Phase 7 gate)',
  '',
  `Generated by \`npm run trace\` over ${docs.join(', ')}. Each paragraph, list item or table row that states a number must cite an experiment result, the code that fixes the number, or a source whose quoted text contains it (docs/sources.md).`,
  '',
  `Units with numbers: ${checkedUnits}. Numbers checked: ${checkedNumbers}. Untraced: ${problems.length}.`,
  '',
  ...(problems.length ? ['| problem |', '|---|', ...problems.map((p) => `| ${p.replaceAll('|', '\\|')} |`)] : ['Every number traces to an experiment or a source.']),
  '',
  `Gate: ${problems.length === 0 ? 'PASS' : 'FAIL'}`,
];
writeResult('trace', md, { docs, units: checkedUnits, numbers: checkedNumbers, problems, pass: problems.length === 0 });
console.log(md.join('\n'));
process.exitCode = problems.length ? 1 : 0;
