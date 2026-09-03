#!/usr/bin/env node
// Structural lint for network.json form definitions (see issue #23).
//
// These files parse as valid JSON while still being internally broken: a
// conditional can name a field that no longer exists, a layout section can
// list a field that was deleted, a property can be flagged both private and
// vectorize (which signals-search throws on at registry load). None of that
// is visible to a JSON parser, and all of it has bitten a review already.
//
// Failures print as ::error file=...:: so they land inline on the PR diff.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
// --warn reports problems without failing the job, so the lint informs a
// review rather than blocking it. Only the JSON parse check gates merges.
const warnOnly = argv.includes('--warn');
const files = argv.filter((a) => a !== '--warn');
if (files.length === 0) {
  console.error('usage: lint-network.mjs [--warn] <file.json>...');
  process.exit(2);
}
const level = warnOnly ? 'warning' : 'error';

/** Options live on `enum` for scalars and `items.enum` for multi-selects. */
const optionsOf = (prop) => prop?.enum ?? prop?.items?.enum ?? null;

/** Every item_schema in a network.json, with a human-readable path. */
function* itemSchemas(doc) {
  for (const [i, domain] of (doc.domains ?? []).entries()) {
    const domainId = domain?.id ?? domain?.name ?? String(i);
    for (const [name, schema] of Object.entries(domain?.item_schemas ?? {})) {
      if (schema && typeof schema === 'object') yield [`${domainId}/${name}`, schema];
    }
  }
}

function lintSchema(where, schema, report) {
  const props = schema.properties ?? {};
  const at = (prop) => `${where}.${prop}`;

  for (const [name, prop] of Object.entries(props)) {
    // 1 + 2: conditionals must name a real sibling and trigger on real options.
    for (const [dep, raw] of Object.entries(prop?.['x-show-if'] ?? {})) {
      if (!(dep in props)) {
        report(`${at(name)}: x-show-if depends on "${dep}", which is not a property of this schema`);
        continue;
      }
      const options = optionsOf(props[dep]);
      if (options === null) continue; // free-text dependency: nothing to check against
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (!options.includes(value)) {
          report(`${at(name)}: x-show-if triggers on ${dep} === ${JSON.stringify(value)}, which is not one of its options`);
        }
      }
    }

    // 4: signals-search throws on this at registry load, taking ingestion down.
    if (prop?.vectorize === true && prop?.private === true) {
      report(`${at(name)}: is both private and vectorize — signals-search throws on this at registry load`);
    }

    // 5: enum and enumNames are paired by position.
    if (Array.isArray(prop?.enum) && Array.isArray(prop?.enumNames) && prop.enum.length !== prop.enumNames.length) {
      report(`${at(name)}: enum has ${prop.enum.length} values but enumNames has ${prop.enumNames.length} labels`);
    }
  }

  // 3: layout and properties must agree in both directions.
  const sections = schema['x-form-layout']?.sections;
  if (!Array.isArray(sections)) return;

  const placed = new Map(); // field -> [section titles]
  for (const [i, section] of sections.entries()) {
    const title = section?.title ?? `sections[${i}]`;
    for (const field of section?.fields ?? []) {
      placed.set(field, [...(placed.get(field) ?? []), title]);
    }
  }
  for (const [field, titles] of placed) {
    if (!(field in props)) {
      report(`${where}: x-form-layout section "${titles[0]}" lists field "${field}", which is not a property`);
    }
    if (titles.length > 1) {
      report(`${where}: field "${field}" is laid out in ${titles.length} sections (${titles.join(', ')})`);
    }
  }
  for (const name of Object.keys(props)) {
    if (!placed.has(name)) {
      report(`${where}: property "${name}" is in no x-form-layout section, so it never renders`);
    }
  }
}

let failed = 0;
let checked = 0;

for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // The parse job already annotates this; don't double-report, just don't crash.
    console.log(`${file}: skipped (does not parse)`);
    continue;
  }
  if (!Array.isArray(doc?.domains)) {
    console.log(`${file}: skipped (no domains array)`);
    continue;
  }

  const findings = [];
  for (const [where, schema] of itemSchemas(doc)) {
    lintSchema(where, schema, (msg) => findings.push(msg));
  }

  checked += 1;
  if (findings.length === 0) {
    console.log(`${file}: ok`);
  } else {
    failed += 1;
    for (const finding of findings) console.log(`::${level} file=${file}::${finding}`);
    console.log(`${file}: ${findings.length} problem(s)`);
  }
}

console.log(`\nlinted ${checked} network file(s), ${failed} with problems`);
if (failed > 0 && warnOnly) {
  console.log('advisory run: not failing the job — fix these in a schema PR');
}
process.exit(failed === 0 || warnOnly ? 0 : 1);
