// mend: one command-line tool that applies the edits AI models write, in four
// formats, to a tree of text files. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`; SPEC.md is the whole contract.
// This file implements every section of SPEC.md: the command line (1), output
// and exit codes (2), files, lines and paths (3), format detection (4),
// three-tier line matching (5), unified diffs (6), SEARCH/REPLACE blocks (7),
// V4A patches (8), JSON edits (9) and order with all-or-nothing writes (10).
// When MAKEFUN_ENV_URL is set the last lines hand a trial over to runner.ts;
// keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: a code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC section 3: a safe path. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ------------------------------------------------------------------ lines

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into its lines, its line break and whether it ends with one. */
function splitLines(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Join lines back with their break; a file of no lines is written empty. */
function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// -------------------------------------------------------- matching (sec 5)

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where O occurs in the file's lines at one tier (overlaps count). */
function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  const on = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or 0 only with --strict) at which O occurs, with its positions. */
function findTier(file: string[], o: string[], strict: boolean): [number, number[]] | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(file, o, t);
    if (pos.length > 0) return [t, pos];
  }
  return null;
}

/** First line at or after `from` equal to a single line, at the first tier where one is. */
function findSingle(file: string[], want: string, from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const w = norm(want, t);
    for (let i = from; i < file.length; i++) {
      if (norm(file[i]!, t) === w) return i;
    }
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one (eof: only ending at the last line). */
function findFrom(file: string[], o: string[], from: number, strict: boolean, eof: boolean): [number, number] | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrencesAt(file, o, t).filter((p) => p >= from && (!eof || p + o.length === file.length));
    if (pos.length > 0) return [t, pos[0]!];
  }
  return null;
}

/** A line of N: fresh text, or a context line taken from the file's matched line O[ctx]. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Replace the k matched lines at `at` with N. Context lines are written as the
 * file's own matched lines; at tier 2 every other non-blank line of N that
 * starts with O's first line's indent has that indent replaced by the file's.
 */
function applyReplace(file: string[], at: number, oLen: number, n: NLine[], tier: number, o: string[]): string[] {
  const out = file.slice(0, at);
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = /^[ \t]*/.exec(o[0]!)![0];
    f = /^[ \t]*/.exec(file[at]!)![0];
  }
  for (const item of n) {
    if (item.ctx !== null) {
      out.push(file[at + item.ctx]!);
    } else {
      let t = item.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  out.push(...file.slice(at + oLen));
  return out;
}

// ------------------------------------------------------------------- tree

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** An edit: it either leaves the tree changed (recording a move) or throws Fail and leaves nothing. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

// -------------------------------------------------------------- detection

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ------------------------------------------------------------- JSON (sec 9)

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const { lines, br, final } = splitLines(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinLines(lines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------- unified (sec 6)

interface UBody {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

interface UHunk {
  a: number;
  body: UBody[];
}

interface USection {
  oldP: string | null;
  newP: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path a `--- ` or `+++ ` line names, or null for /dev/null. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a unified diff into its sections (each section is one edit). */
function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    let gitX: string | null = null;
    let gitY: string | null = null;
    let j: number;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/');
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      gitX = rest.slice(2, sep);
      gitY = rest.slice(sep + 3);
      if (gitX === '' || gitY === '') throw new Exit2(`error: parse ${i + 1}`);
      j = i + 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      j = i;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    let oldP: string | null = null;
    let newP: string | null = null;
    let oldSet = false;
    let newSet = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let newFile = false;
    let deletedFile = false;
    let havePair = false;
    const hunks: UHunk[] = [];
    let inHeader = true;
    while (j < n) {
      const m = lines[j]!;
      if (m.startsWith('@@')) {
        inHeader = false;
        const hm = HUNK_HEAD.exec(m);
        if (hm === null) throw new Exit2(`error: parse ${j + 1}`);
        const a = Number(hm[1]);
        j++;
        const body: UBody[] = [];
        while (j < n) {
          const b = lines[j]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
          if (b === '') body.push({ kind: ' ', text: '', empty: true });
          else if (b[0] === ' ') body.push({ kind: ' ', text: b.slice(1), empty: false });
          else if (b[0] === '-') body.push({ kind: '-', text: b.slice(1), empty: false });
          else if (b[0] === '+') body.push({ kind: '+', text: b.slice(1), empty: false });
          else if (b[0] === '\\') body.push({ kind: '\\', text: b, empty: false });
          else break;
          j++;
        }
        while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
        hunks.push({ a, body });
        continue;
      }
      if (m.startsWith('diff --git ')) break;
      if (m.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
        if (inHeader && !havePair) {
          oldP = diffPath(m);
          newP = diffPath(lines[j + 1]!);
          oldSet = true;
          newSet = true;
          havePair = true;
          j += 2;
          continue;
        }
        break;
      }
      if (inHeader) {
        if (m.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
        if (m.startsWith('+++ ')) {
          newP = diffPath(m);
          newSet = true;
          j++;
          continue;
        }
        if (m.startsWith('rename from ')) {
          renameFrom = m.slice('rename from '.length).trim();
          j++;
          continue;
        }
        if (m.startsWith('rename to ')) {
          renameTo = m.slice('rename to '.length).trim();
          j++;
          continue;
        }
        if (m.startsWith('new file mode')) {
          newFile = true;
          j++;
          continue;
        }
        if (m.startsWith('deleted file mode')) {
          deletedFile = true;
          j++;
          continue;
        }
        j++;
        continue;
      }
      j++;
    }
    const oldPath = oldSet ? oldP : (renameFrom ?? gitX);
    const newPath = newSet ? newP : (renameTo ?? gitY);
    sections.push({ oldP: oldPath, newP: newPath, newFile, deletedFile, hunks });
    i = j;
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLast(h: UHunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === ' ' || b.kind === '+') {
      return h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  if (sec.oldP === null && sec.newP === null) return () => {};
  const isCreate = sec.oldP === null || sec.newFile;
  const isDelete = !isCreate && (sec.newP === null || sec.deletedFile);
  const isMove = !isCreate && !isDelete && sec.oldP !== sec.newP;
  return (tree, moves) => {
    if (isCreate) {
      const p = sec.newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastPlus: { h: UHunk; k: number } | null = null;
      for (const h of sec.hunks) {
        h.body.forEach((b, k) => {
          if (b.kind === '+') {
            out.push(b.text);
            lastPlus = { h, k };
          }
        });
      }
      let final = true;
      if (lastPlus !== null) {
        const nx = lastPlus.h.body[lastPlus.k + 1];
        if (nx !== undefined && nx.kind === '\\') final = false;
      }
      tree.now.set(p, joinLines(out, '\n', final));
      return;
    }
    if (isDelete) {
      const p = sec.oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldP!;
    const newP = sec.newP!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (isMove && !safe(newP)) throw new Fail('unsafe', newP);
    const content = tree.get(oldP);
    if (content === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let { lines, br, final } = splitLines(content);
    let d = 0;
    for (const h of sec.hunks) {
      const o: string[] = [];
      const n: NLine[] = [];
      let oi = 0;
      for (const b of h.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: oi });
          oi++;
        } else if (b.kind === '-') {
          o.push(b.text);
          oi++;
        } else if (b.kind === '+') {
          n.push({ text: b.text, ctx: null });
        }
      }
      if (o.length > 0) {
        const found = findTier(lines, o, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const [tier, positions] = found;
        const target = h.a - 1 + d;
        let best = positions[0]!;
        for (const p of positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const runsToEnd = best + o.length === lines.length;
        lines = applyReplace(lines, best, o.length, n, tier, o);
        if (runsToEnd) final = !backslashAfterLast(h);
        d += n.length - o.length;
      } else {
        const at = Math.max(0, Math.min(h.a + d, lines.length));
        const ins = n.map((x) => x.text);
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        if (atEnd) final = !backslashAfterLast(h);
        d += n.length;
      }
    }
    const out = joinLines(lines, br, final);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

// ----------------------------------------------- SEARCH/REPLACE blocks (sec 7)

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinLines(newLines, '\n', true));
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const { lines, br, final } = splitLines(content);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    const [tier, positions] = found;
    if (positions.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const out = applyReplace(lines, positions[0]!, oldLines.length, n, tier, oldLines);
    tree.now.set(path, joinLines(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A (sec 8)

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VLine {
  text: string;
  num: number;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinLines(fileLines, '\n', true));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, sec: VLine[], updateLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let k = 0;
  if (k < sec.length && sec[k]!.text.startsWith('*** Move to: ')) {
    moveTo = sec[k]!.text.slice('*** Move to: '.length).trim();
    k++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  while (k < sec.length) {
    const { text: m, num } = sec[k]!;
    if (m.startsWith('@@')) {
      const anchor = m.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunks.push(cur);
      k++;
    } else if (m === '*** End of File') {
      if (cur !== null) {
        cur.eof = true;
        cur = null;
      }
      k++;
    } else if (m === '' || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      }
      cur.body.push(m);
      k++;
    } else {
      throw new Exit2(`error: parse ${num}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree, moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitLines(content);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NLine[] = [];
      let oi = 0;
      for (const raw of ch.body) {
        if (raw === '' || raw[0] === ' ') {
          const t = raw === '' ? '' : raw.slice(1);
          o.push(t);
          n.push({ text: t, ctx: oi });
          oi++;
        } else if (raw[0] === '-') {
          o.push(raw.slice(1));
          oi++;
        } else if (raw[0] === '+') {
          n.push({ text: raw.slice(1), ctx: null });
        }
      }
      if (o.length > 0) {
        const found = findFrom(lines, o, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const [tier, at] = found;
        lines = applyReplace(lines, at, o.length, n, tier, o);
        cursor = at + n.length;
      } else {
        const at = ch.eof ? lines.length : cursor;
        const ins = n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + n.length;
      }
    }
    const out = joinLines(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      const path = l.slice(prefix.length).trim();
      const headLine = i + 1;
      i++;
      const sec: VLine[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        sec.push({ text: lines[i]!, num: i + 1 });
        i++;
      }
      while (sec.length > 0 && blank(sec[sec.length - 1]!.text)) sec.pop();
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (const { text: m, num } of sec) {
          if (m.startsWith('+')) fileLines.push(m.slice(1));
          else if (m === '') fileLines.push('');
          else throw new Exit2(`error: parse ${num}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (kind === 'delete') {
        if (sec.length > 0) throw new Exit2(`error: parse ${sec[0]!.num}`);
        edits.push(v4aDeleteEdit(path));
      } else {
        edits.push(v4aUpdateEdit(path, sec, headLine, strict));
      }
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// ------------------------------------------------------------------ run

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedSections(lines).map((s) => unifiedEdit(s, strict))
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; line: string }> = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (paired.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
