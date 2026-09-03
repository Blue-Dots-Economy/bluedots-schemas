#!/usr/bin/env node
// Blocking gate: every tracked JSON file must be exactly one valid document.
//
// This deliberately uses JSON.parse rather than `jq`, because JSON.parse is
// what actually consumes these files downstream (the Signals API schema
// loader, and the sibling scripts here). `jq empty` is more permissive in
// three ways that matter, and every one of them passes review unnoticed:
//
//   file            jq empty   JSON.parse
//   (empty)         accepts    rejects
//   whitespace      accepts    rejects
//   {"a":1}{"b":2}  accepts    rejects   <- jq reads a *stream* of documents
//
// The last is a realistic bad merge resolution: the root object duplicated.
// A gate that accepts it is not a gate.
//
// Reads a NUL-delimited file list on stdin, or takes paths as arguments.

import { readFileSync } from 'node:fs';
import { fileList } from './lib/files.mjs';

/** Turn a byte offset into 1-based line/column for the annotation. */
function lineCol(text, offset) {
  const upto = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lines = upto.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/** JSON.parse messages carry a position; shapes differ across Node versions. */
function locate(text, message) {
  const direct = message.match(/line (\d+) column (\d+)/);
  if (direct) return { line: Number(direct[1]), col: Number(direct[2]) };
  const pos = message.match(/position (\d+)/);
  if (pos) return lineCol(text, Number(pos[1]));
  return null;
}

function annotate(file, message, where) {
  const loc = where ? `,line=${where.line},col=${where.col}` : '';
  console.log(`::error file=${file}${loc}::${message}`);
}

/** Returns an error string, or null when the file is a single valid document. */
function check(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (err) {
    annotate(file, `could not be read: ${err.message}`);
    return 'unreadable';
  }

  // JSON.parse rejects a byte-order mark, and the message is unhelpful.
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    annotate(file, 'starts with a UTF-8 byte-order mark, which JSON.parse rejects — save it as UTF-8 without BOM');
    return 'bom';
  }

  const text = raw.toString('utf8');
  if (text.trim() === '') {
    annotate(file, text.length === 0 ? 'is empty' : 'contains only whitespace');
    return 'empty';
  }

  try {
    JSON.parse(text);
  } catch (err) {
    annotate(file, `invalid JSON: ${err.message}`, locate(text, err.message));
    return 'invalid';
  }
  return null;
}

const files = await fileList();

// An empty list means the file list broke, not that the repo is clean. A
// blocking gate that silently passes on zero input is worse than no gate.
if (files.length === 0) {
  console.log('::error::no JSON files were passed to the validator — the file list is broken');
  process.exit(1);
}

let bad = 0;
for (const file of files) if (check(file) !== null) bad += 1;

console.log(`checked ${files.length} JSON file(s), ${bad} invalid`);
process.exit(bad === 0 ? 0 : 1);
