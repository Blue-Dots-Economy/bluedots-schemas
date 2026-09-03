#!/usr/bin/env node
// Blocking gate: every tracked JSON file must be exactly one valid document.
//
// Uses JSON.parse rather than `jq`, because JSON.parse is what actually
// consumes these files downstream (the Signals API schema loader, and the
// sibling scripts here). `jq empty` is more permissive in three ways that
// matter, and every one of them passes review unnoticed:
//
//   file            jq empty   JSON.parse
//   (empty)         accepts    rejects
//   whitespace      accepts    rejects
//   {"a":1}{"b":2}  accepts    rejects   <- jq reads a *stream* of documents
//
// On top of parsing this rejects a byte-order mark, rejects malformed UTF-8
// (which decodes to U+FFFD rather than throwing, silently corrupting text),
// and reports duplicate object keys — the classic conflict artifact, where
// JSON.parse quietly keeps the last one and half a schema disappears.
//
// Reads a NUL-delimited file list on stdin, or takes paths as arguments.

import { readFileSync } from 'node:fs';
import { fileList } from './lib/files.mjs';

/** Workflow commands are line-based; an unescaped newline truncates the
 *  annotation and dumps the rest into the log as if it were runner output. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

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
  console.log(`::error file=${esc(file)}${loc}::${esc(message)}`);
}

/**
 * Find object keys that appear more than once. Only called on text that has
 * already parsed, so the scan can assume well-formed input: it tracks a stack
 * of containers and, inside an object, treats a string immediately followed
 * by ':' as a key.
 */
function duplicateKeys(text) {
  const found = [];
  const stack = [];
  let expectKey = false;

  for (let i = 0; i < text.length; ) {
    const ch = text[i];

    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') break;
        j += 1;
      }
      const raw = text.slice(i, j + 1);
      const start = i;
      i = j + 1;

      const frame = stack[stack.length - 1];
      if (expectKey && frame?.type === 'obj') {
        let k = i;
        while (k < text.length && /\s/.test(text[k])) k += 1;
        if (text[k] === ':') {
          const key = JSON.parse(raw);
          // Ancestors only: the current frame's lastKey is this very key.
          const path = stack.slice(0, -1).map((f) => (f.type === 'arr' ? '[]' : f.lastKey)).filter(Boolean).join('.');
          if (frame.keys.has(key)) found.push({ key, path, offset: start });
          else frame.keys.add(key);
          frame.lastKey = key;
          expectKey = false;
        }
      }
      continue;
    }

    if (ch === '{') { stack.push({ type: 'obj', keys: new Set(), lastKey: null }); expectKey = true; i += 1; continue; }
    if (ch === '[') { stack.push({ type: 'arr' }); expectKey = false; i += 1; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; i += 1; continue; }
    if (ch === ',') { expectKey = stack[stack.length - 1]?.type === 'obj'; i += 1; continue; }
    i += 1;
  }
  return found;
}

/** Returns a short reason string, or null when the file is one valid document. */
function check(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (err) {
    annotate(file, `could not be read: ${err.message}`);
    return 'unreadable';
  }

  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    annotate(file, 'starts with a UTF-8 byte-order mark, which JSON.parse rejects — save it as UTF-8 without BOM');
    return 'bom';
  }

  // Buffer#toString substitutes U+FFFD for bad sequences instead of throwing,
  // so a mis-encoded edit would parse fine with its text quietly mangled.
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    annotate(file, 'is not valid UTF-8 — re-save it as UTF-8');
    return 'encoding';
  }

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

  const dupes = duplicateKeys(text);
  if (dupes.length > 0) {
    for (const { key, path, offset } of dupes) {
      const where = path ? `${path}.${key}` : key;
      annotate(file, `duplicate key "${where}" — JSON.parse silently keeps the last one, so the earlier block is discarded`, lineCol(text, offset));
    }
    return 'duplicate-key';
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
