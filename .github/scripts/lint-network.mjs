#!/usr/bin/env node
// Structural lint for network.json form definitions (see issue #23).
//
// These files parse as valid JSON while still being internally broken: a
// conditional can name a field that no longer exists, a layout section can
// list a field that was deleted, a property can be flagged both private and
// vectorize (which signals-search throws on at registry load). None of that
// is visible to a JSON parser, and all of it has bitten a review already.
//
// Scope: properties directly under domains[*].item_schemas[*]. Nested
// object/array sub-properties are not walked — nothing in this repo uses
// them today, and the top-level *-schema.json files (which do) are outside
// the network.json glob. Widen both if that changes.
//
// --warn reports without failing, so the lint informs a review rather than
// blocking it. Only the JSON parse gate holds up a merge.

import { readFileSync } from 'node:fs';
import { fileList } from './lib/files.mjs';

/** Workflow commands are line-based; an unescaped newline truncates them. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const warnOnly = process.argv.includes('--warn');
const level = warnOnly ? 'warning' : 'error';

/** Options live on `enum` for scalars and `items.enum` for multi-selects. */
const optionsOf = (prop) => prop?.enum ?? prop?.items?.enum ?? null;

/** `in` walks the prototype chain, so a field named toString or valueOf
 *  would read as an existing property. */
const has = (obj, name) => Object.hasOwn(obj, name);

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
    const showIf = prop?.['x-show-if'];
    if (showIf !== undefined && (showIf === null || typeof showIf !== 'object' || Array.isArray(showIf))) {
      report(`${at(name)}: x-show-if is ${JSON.stringify(showIf)}, which is not an object of {property: [values]}`);
    }
    for (const [dep, raw] of Object.entries(showIf && typeof showIf === 'object' && !Array.isArray(showIf) ? showIf : {})) {
      // The UI bails on a non-array (show-if.ts: `if (!Array.isArray(allowed))
      // return false`), so a bare string hides the field permanently. Check
      // this before normalising, or the lint hides the bug it exists to find.
      if (!Array.isArray(raw)) {
        report(`${at(name)}: x-show-if value for "${dep}" is ${JSON.stringify(raw)}, not an array — the UI treats a non-array as "never show"`);
        continue;
      }
      if (!has(props, dep)) {
        report(`${at(name)}: x-show-if depends on "${dep}", which is not a property of this schema`);
        continue;
      }
      const options = optionsOf(props[dep]);
      if (options === null) continue; // free-text dependency: nothing to check against
      if (!Array.isArray(options)) {
        report(`${at(name)}: x-show-if depends on "${dep}", whose enum is not an array`);
        continue;
      }
      for (const value of raw) {
        if (!options.includes(value)) {
          report(`${at(name)}: x-show-if triggers on ${dep} === ${JSON.stringify(value)}, which is not one of its options`);
        }
      }
    }

    // signals-search throws on this at registry load, taking ingestion down.
    if (prop?.vectorize === true && prop?.private === true) {
      report(`${at(name)}: is both private and vectorize — signals-search throws on this at registry load`);
    }

    // enum and enumNames are paired by position, on the property itself for
    // scalars and under items for multi-selects (languageSpoken carries 24
    // of each, benefitsOffered 6).
    for (const [holder, label] of [[prop, ''], [prop?.items, '.items']]) {
      const values = holder?.enum;
      const names = holder?.enumNames;
      if (Array.isArray(values) && Array.isArray(names) && values.length !== names.length) {
        report(`${at(name)}${label}: enum has ${values.length} values but enumNames has ${names.length} labels`);
      }
    }
  }

  const layout = schema['x-form-layout'];
  if (!layout || typeof layout !== 'object') return;

  // schema-form.tsx does `layout.twoColumn.includes(...)` with no guard, so a
  // layout without it throws and blanks the whole form.
  if (!Array.isArray(layout.twoColumn)) {
    report(`${where}: x-form-layout has no twoColumn array — the form renderer calls .includes() on it and will throw`);
  } else {
    for (const field of layout.twoColumn) {
      if (!has(props, field)) {
        report(`${where}: x-form-layout.twoColumn lists "${field}", which is not a property`);
      }
    }
  }

  // schema-form.tsx does `layout.sections.map(...)` with no guard either.
  const sections = layout.sections;
  if (!Array.isArray(sections)) {
    report(`${where}: x-form-layout has no sections array — the form renderer calls .map() on it and will throw`);
    return;
  }

  const placed = new Map(); // field -> [section titles]
  for (const [i, section] of sections.entries()) {
    const title = section?.title ?? `sections[${i}]`;
    const fields = section?.fields;
    if (fields !== undefined && !Array.isArray(fields)) {
      report(`${where}: x-form-layout section "${title}" has a non-array fields value — the renderer calls .map() on it and will throw`);
      continue;
    }
    for (const field of fields ?? []) {
      placed.set(field, [...(placed.get(field) ?? []), title]);
    }
  }
  for (const [field, titles] of placed) {
    if (!has(props, field)) {
      report(`${where}: x-form-layout section "${titles[0]}" lists field "${field}", which is not a property — the renderer drops it silently`);
    }
    if (titles.length > 1) {
      report(`${where}: field "${field}" is laid out in ${titles.length} sections (${titles.join(', ')})`);
    }
  }
  for (const name of Object.keys(props)) {
    if (!placed.has(name)) {
      report(`${where}: property "${name}" is in no x-form-layout section — it renders ungrouped at the end of the form instead of where it belongs`);
    }
  }
}

const files = await fileList();

// A broken pathspec is a tooling failure, not a schema finding: --warn must
// not turn it into a permanently green no-op.
if (files.length === 0) {
  console.log('::error::no network files were passed to the lint — the file list is broken');
  process.exit(1);
}

let failed = 0;
let scanned = 0;

for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // The parse gate should have caught this. Say so rather than skipping in
    // silence — a file that vanishes from the lint with no annotation is how
    // a broken file reaches main looking checked.
    console.log(`::${level} file=${esc(file)}::${esc(`could not be linted, it does not parse: ${err.message}`)}`);
    failed += 1;
    scanned += 1;
    continue;
  }
  scanned += 1;
  if (!Array.isArray(doc?.domains)) {
    console.log(`${file}: skipped (no domains array)`);
    continue;
  }

  const findings = [];
  try {
    for (const [where, schema] of itemSchemas(doc)) {
      lintSchema(where, schema, (msg) => findings.push(msg));
    }
  } catch (err) {
    // A shape the lint didn't anticipate must not abort the run and leave
    // every later file silently unchecked.
    findings.push(`could not be fully linted: ${err.message}`);
  }

  if (findings.length === 0) {
    console.log(`${file}: ok`);
  } else {
    failed += 1;
    for (const finding of findings) console.log(`::${level} file=${esc(file)}::${esc(finding)}`);
    console.log(`${file}: ${findings.length} problem(s)`);
  }
}

console.log(`\nlinted ${scanned} network file(s), ${failed} with problems`);
if (failed > 0 && warnOnly) {
  console.log('advisory run: not failing the job — fix these in a schema PR');
}
process.exit(failed === 0 || warnOnly ? 0 : 1);
