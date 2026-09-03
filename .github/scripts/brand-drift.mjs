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
    if (only.length === 0) {
      // Nothing unique here, so this side is either a reorder or a subset.
      return v.length === other.length ? `${label} (reordered)` : `${label} (all also present on the other side)`;
    }
    const shown = only.slice(0, 4).map(elementLabel);
    return `${label}, only here: ${shown.join(', ')}${only.length > 4 ? `, +${only.length - 4}` : ''}`;
  }
  if (typeof v === 'object') {
    const n = Object.keys(v).length;
    const label = `{${n} key${n === 1 ? '' : 's'}}`;
    if (!other || typeof other !== 'object' || Array.isArray(other)) return label;
    const diff = keysOf(v, other).filter((k) => !same(v[k], other[k]));
    if (diff.length === 0) return label;
    // Name the differing key *and* its value: two cells reading "differs: c"
    // still leave the reviewer with no idea what changed.
    const compact = (x) => {
      const j = JSON.stringify(x) ?? 'undefined';
      return j.length > 24 ? j.slice(0, 21) + '…' : j;
    };
    const parts = diff.slice(0, 3).map((k) => `${k}=${compact(v[k])}`);
    return `${label} ${parts.join(', ')}${diff.length > 3 ? `, +${diff.length - 3}` : ''}`;
  }
  const str = String(v);
  if (str.length <= 48) return '`' + str + '`';
  // Truncating from the start renders two long strings that share a prefix as
  // the same cell, which is the most likely shape of per-region copy drift.
  if (typeof other === 'string') {
    let i = 0;
    while (i < str.length && i < other.length && str[i] === other[i]) i += 1;
    if (i > 20) {
      const from = Math.max(0, i - 12);
      return '`…' + str.slice(from, from + 46) + (from + 46 < str.length ? '…' : '') + '`';
    }
  }
  return '`' + str.slice(0, 45) + '…`';
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Workflow commands are line-based; table cells must not break the row. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

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

// Keys walked in detail elsewhere; everything else is compared wholesale so
// nothing can diverge unreported while the summary claims "identical".
const WALKED_DOMAIN_KEYS = new Set(['item_schemas']);
const WALKED_SCHEMA_KEYS = new Set(['properties', 'required', 'x-form-layout']);

function compareSchemas(where, a, b, rows) {
  for (const key of keysOf(a, b)) {
    if (WALKED_SCHEMA_KEYS.has(key)) continue;
    if (!same(a[key], b[key])) rows.push([`${where}.${key}`, show(a[key], b[key]), show(b[key], a[key])]);
  }

  const pa = a.properties ?? {};
  const pb = b.properties ?? {};

  // Property order drives render order for anything not placed in a section.
  const orderA = Object.keys(pa);
  const orderB = Object.keys(pb);
  if (!same(orderA, orderB) && same([...orderA].sort(), [...orderB].sort())) {
    rows.push([`${where} property order`, orderA.join(' → '), orderB.join(' → ')]);
  }

  for (const name of keysOf(pa, pb)) {
    const x = pa[name];
    const y = pb[name];
    if (x === undefined || y === undefined) {
      rows.push([`${where}.${name}`, x === undefined ? '—' : 'present', y === undefined ? '—' : 'present']);
      continue;
    }
    // A null or non-object definition would make keysOf/x[key] throw, turning
    // an advisory job red.
    if (!x || typeof x !== 'object' || !y || typeof y !== 'object') {
      if (!same(x, y)) rows.push([`${where}.${name}`, show(x, y), show(y, x)]);
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
      return [title, x ?? {}];
    }));
  };
  const sa = secs(a);
  const sb = secs(b);
  const titlesA = Object.keys(sa);
  const titlesB = Object.keys(sb);
  if (!same(titlesA, titlesB) && same([...titlesA].sort(), [...titlesB].sort())) {
    rows.push([`${where} section order`, titlesA.join(' → '), titlesB.join(' → ')]);
  }
  for (const title of keysOf(sa, sb)) {
    const secA = sa[title];
    const secB = sb[title];
    if (secA === undefined || secB === undefined) {
      rows.push([`${where} layout "${title}"`, secA === undefined ? '—' : 'present', secB === undefined ? '—' : 'present']);
      continue;
    }
    // Every key on the section, so nothing beyond title/fields diverges unseen.
    for (const key of keysOf(secA, secB)) {
      if (!same(secA[key], secB[key])) {
        rows.push([`${where} layout "${title}".${key}`, show(secA[key], secB[key]), show(secB[key], secA[key])]);
      }
    }
  }

  // Any x-form-layout key beyond sections/twoColumn, which are walked above.
  const la = a['x-form-layout'] ?? {};
  const lb = b['x-form-layout'] ?? {};
  for (const key of keysOf(la, lb)) {
    if (key === 'sections' || key === 'twoColumn') continue;
    if (!same(la[key], lb[key])) {
      rows.push([`${where} layout.${key}`, show(la[key], lb[key]), show(lb[key], la[key])]);
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

  // lint-network guards this with Array.isArray; drift must too, or an
  // unexpected shape throws and the advisory job exits non-zero.
  const doms = (d) => {
    if (!Array.isArray(d?.domains)) return null;
    const out = {};
    const dupes = [];
    for (const [i, x] of d.domains.entries()) {
      const id = x?.id ?? String(i);
      if (id in out) dupes.push(id);
      out[id] = x;
    }
    return { map: out, dupes };
  };
  const ra = doms(a.doc);
  const rb = doms(b.doc);
  if (!ra || !rb) {
    rows.push(['domains', ra ? `${Object.keys(ra.map).length} domain(s)` : 'not an array', rb ? `${Object.keys(rb.map).length} domain(s)` : 'not an array']);
    return rows;
  }
  // F9: duplicate ids collapse, so a whole domain could vanish unreported.
  for (const [side, r] of [[a.brand, ra], [b.brand, rb]]) {
    for (const id of new Set(r.dupes)) rows.push([`domain id "${id}" appears more than once in ${side}`, '', '']);
  }
  const da = ra.map;
  const db = rb.map;

  const orderA = Object.keys(da);
  const orderB = Object.keys(db);
  if (!same(orderA, orderB) && same([...orderA].sort(), [...orderB].sort())) {
    rows.push(['domain order', orderA.join(' → '), orderB.join(' → ')]);
  }

  for (const id of keysOf(da, db)) {
    if (!da[id] || !db[id]) {
      rows.push([`domain ${id}`, da[id] ? 'present' : '—', db[id] ? 'present' : '—']);
      continue;
    }
    for (const key of keysOf(da[id], db[id])) {
      if (WALKED_DOMAIN_KEYS.has(key)) continue;
      if (!same(da[id][key], db[id][key])) {
        rows.push([`domain ${id}.${key}`, show(da[id][key], db[id][key]), show(db[id][key], da[id][key])]);
      }
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
    console.log(`::warning file=${esc(path)}::${esc(`excluded from the drift report, it does not parse: ${err.message}`)}`);
    continue;
  }
  const [dot, brand] = parts;
  if (!brands.has(dot)) brands.set(dot, []);
  brands.get(dot).push({ brand, path, doc });
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
      for (const [field, x, y] of rows.slice(0, 60)) out.push(`| ${cell(field)} | ${cell(x)} | ${cell(y)} |`);
      if (rows.length > 60) out.push(`| _…and ${rows.length - 60} more_ | | |`);
      out.push('');
      console.log(`::notice::${dot}: ${a.brand} vs ${b.brand} — ${rows.length} difference(s); see the job summary`);
      console.log(`${dot}: ${a.brand} vs ${b.brand} — ${rows.length} difference(s)`);
    }
  }
}

if (files.length === 0) {
  console.log('::error::no network files were passed to the drift report — the file list is broken');
  process.exit(1);
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
    '_Scope: `network.json` only, and only where two or more brands under a dot have one. Brand folders carrying just `brand.json` / `consent.json` (`blue_dot/upsdm`, `orange_dot/onetac`) are not compared._',
    '',
  ];
  const summary = [...header, ...out].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  else console.log('\n' + summary);
}

process.exit(0); // advisory only, never blocks a merge
