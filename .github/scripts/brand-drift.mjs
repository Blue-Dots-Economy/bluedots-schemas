#!/usr/bin/env node
// Brand-clone drift report (see issue #23).
//
// Brands under a dot folder start as verbatim clones of one another —
// blue_dot/ka-dhwd was copied wholesale from blue_dot/up-gzb. From then on
// they diverge two ways that look identical in git: on purpose (a region
// needs different colleges, different copy) and by accident (a fix lands in
// one brand and is forgotten in the other). Nothing distinguishes them, and
// nobody is going to eyeball two 2500-line files to find out.
//
// This reports the differences so a reviewer acknowledges them. It never
// fails the job: divergence is frequently correct, and a check that cries
// wolf gets switched off.

import { readFileSync, appendFileSync } from 'node:fs';
import { fileList } from './lib/files.mjs';

const files = await fileList();

// Brand files live at <dot>/<brand>/network.json. Anything shallower is the
// dot's own base schema, not a brand clone.
const brands = new Map(); // dot -> [{ brand, path, doc }]
for (const path of files) {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[2] !== 'network.json') continue;
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Don't drop it in silence: with only two brands under a dot, losing one
    // leaves nothing to compare and the report would claim there was no pair.
    console.log(`::warning file=${path}::excluded from the drift report, it does not parse: ${err.message}`);
    continue;
  }
  const [dot, brand] = parts;
  if (!brands.has(dot)) brands.set(dot, []);
  brands.get(dot).push({ brand, path, doc });
}

/** Render a value compactly enough to sit in a table cell. */
function show(v, other) {
  if (v === undefined) return '—';
  if (v === null) return '`null`';
  if (Array.isArray(v)) {
    // A bare count renders same-length drift as two identical cells, which
    // tells a reviewer there is a difference but not what it is.
    const label = `${v.length} item${v.length === 1 ? '' : 's'}`;
    if (!Array.isArray(other)) return label;
    const only = v.filter((x) => !other.some((y) => same(x, y)));
    if (only.length === 0) return `${label} (reordered)`;
    const shown = only.slice(0, 4).map(elementLabel);
    return `${label}, only here: ${shown.join(', ')}${only.length > 4 ? `, +${only.length - 4}` : ''}`;
  }
  if (typeof v === 'object') return `{${Object.keys(v).length} key${Object.keys(v).length === 1 ? '' : 's'}}`;
  const s = String(v);
  return '`' + (s.length > 48 ? s.slice(0, 45) + '…' : s) + '`';
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Name an array element so a reviewer can find it, rather than "{…}". */
function elementLabel(x) {
  if (x === null || typeof x !== 'object') return String(x);
  for (const key of ['instance_name', 'name', 'id', 'title', 'label']) {
    if (typeof x[key] === 'string') return x[key];
  }
  return `{${Object.keys(x).slice(0, 2).join(', ')}…}`;
}

/** Sorted union of two objects' keys. */
const keysOf = (...objs) => [...new Set(objs.flatMap((o) => Object.keys(o ?? {})))].sort();

function compareSchemas(where, a, b, rows) {
  const pa = a.properties ?? {};
  const pb = b.properties ?? {};

  for (const name of keysOf(pa, pb)) {
    const x = pa[name];
    const y = pb[name];
    if (x === undefined || y === undefined) {
      rows.push([`${where}.${name}`, x === undefined ? '—' : 'present', y === undefined ? '—' : 'present']);
      continue;
    }
    for (const key of keysOf(x, y)) {
      if (!same(x[key], y[key])) rows.push([`${where}.${name}.${key}`, show(x[key], y[key]), show(y[key], x[key])]);
    }
  }

  if (!same(a.required, b.required)) {
    rows.push([`${where}.required`, show(a.required, b.required), show(b.required, a.required)]);
  }

  // Layout: compare section titles, then the field list of shared sections.
  const twoA = a['x-form-layout']?.twoColumn;
  const twoB = b['x-form-layout']?.twoColumn;
  if (!same(twoA, twoB)) rows.push([`${where} layout twoColumn`, show(twoA, twoB), show(twoB, twoA)]);

  // Index duplicate titles so two sections sharing a name don't collapse.
  const secs = (s) => {
    const seen = new Map();
    return Object.fromEntries((s['x-form-layout']?.sections ?? []).map((x, i) => {
      let title = x?.title ?? `sections[${i}]`;
      const n = (seen.get(title) ?? 0) + 1;
      seen.set(title, n);
      if (n > 1) title = `${title} #${n}`;
      return [title, x?.fields ?? []];
    }));
  };
  const sa = secs(a);
  const sb = secs(b);
  for (const title of keysOf(sa, sb)) {
    if (!same(sa[title], sb[title])) {
      rows.push([`${where} layout "${title}"`, show(sa[title], sb[title]), show(sb[title], sa[title])]);
    }
  }
}

function compare(a, b) {
  const rows = [];

  // Every top-level key except domains, which is walked in detail below.
  // A hand-picked list silently ignores instances, actions and
  // dashboard_buckets while the summary claims the brands are identical.
  for (const key of keysOf(a.doc, b.doc)) {
    if (key === 'domains') continue;
    if (!same(a.doc[key], b.doc[key])) rows.push([key, show(a.doc[key], b.doc[key]), show(b.doc[key], a.doc[key])]);
  }

  const doms = (d) => Object.fromEntries((d.domains ?? []).map((x, i) => [x?.id ?? String(i), x]));
  const da = doms(a.doc);
  const db = doms(b.doc);

  for (const id of keysOf(da, db)) {
    if (!da[id] || !db[id]) {
      rows.push([`domain ${id}`, da[id] ? 'present' : '—', db[id] ? 'present' : '—']);
      continue;
    }
    const ia = da[id].item_schemas ?? {};
    const ib = db[id].item_schemas ?? {};
    for (const name of keysOf(ia, ib)) {
      if (!ia[name] || !ib[name]) {
        rows.push([`${id}/${name}`, ia[name] ? 'present' : '—', ib[name] ? 'present' : '—']);
        continue;
      }
      compareSchemas(`${id}/${name}`, ia[name], ib[name], rows);
    }
  }
  return rows;
}

const out = [];
let totalPairs = 0;
let totalRows = 0;

for (const [dot, list] of [...brands].sort()) {
  if (list.length < 2) continue;
  list.sort((x, y) => x.brand.localeCompare(y.brand));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      totalPairs += 1;
      const rows = compare(a, b);
      totalRows += rows.length;
      out.push(`### ${dot}: \`${a.brand}\` vs \`${b.brand}\``, '');
      if (rows.length === 0) {
        out.push('No drift — these brands are structurally identical.', '');
        console.log(`${dot}: ${a.brand} vs ${b.brand} — no drift`);
        continue;
      }
      out.push(`| Field | \`${a.brand}\` | \`${b.brand}\` |`, '|---|---|---|');
      for (const [field, x, y] of rows.slice(0, 60)) out.push(`| ${field} | ${x} | ${y} |`);
      if (rows.length > 60) out.push(`| _…and ${rows.length - 60} more_ | | |`);
      out.push('');
      console.log(`::notice::${dot}: ${a.brand} vs ${b.brand} — ${rows.length} difference(s); see the job summary`);
      console.log(`${dot}: ${a.brand} vs ${b.brand} — ${rows.length} difference(s)`);
    }
  }
}

if (totalPairs === 0) {
  console.log('no brand pairs to compare');
} else {
  const header = [
    '## Brand clone drift',
    '',
    `Compared ${totalPairs} brand pair(s); ${totalRows} difference(s) total.`,
    '',
    'Differences are **not** errors — brands are expected to diverge. This is here so divergence is a decision someone made, not something that happened quietly.',
    '',
  ];
  const summary = [...header, ...out].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  else console.log('\n' + summary);
}

process.exit(0); // advisory only, never blocks a merge
