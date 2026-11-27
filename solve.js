// A faster drop-in for makefun-diff 1.0.0: run(input) returns the exact
// makefun-diff/1 patch of { old, new } that the reference returns, computed
// with the same edit script (common prefix, then common suffix, then Myers's
// greedy furthest-reaching search between them, deletion winning every tie)
// but with the search state kept in typed arrays instead of linked path
// objects, and lines interned to integer ids so every comparison in the
// search is an integer compare. The patch rendering follows the format
// spec: header counts, hunks with up to 3 context lines, change runs merged
// when at most 6 kept lines apart, deletions listed before insertions, and
// a "%" line after any line that ends its text without a newline.

const KEEP = 0;
const DEL = 1;
const INS = 2;
const CONTEXT = 3;

/** Cut a text into lines after every "\n"; a trailing piece with no "\n" is a line too. */
function splitLines(text) {
  const lines = [];
  const len = text.length;
  let start = 0;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) {
      lines.push(text.slice(start));
      break;
    }
    lines.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  return lines;
}

/** Intern both line arrays into one id space so equality is an integer compare. */
function internLines(aLines, bLines) {
  const ids = new Map();
  const aIds = new Int32Array(aLines.length);
  const bIds = new Int32Array(bLines.length);
  for (let i = 0; i < aLines.length; i++) {
    const line = aLines[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    aIds[i] = id;
  }
  for (let i = 0; i < bLines.length; i++) {
    const line = bLines[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    bIds[i] = id;
  }
  return [aIds, bIds];
}

/**
 * The edit runs of a into b (arrays of line ids): [[kind, count], ...] in order.
 * Myers's greedy search: for d edits and each diagonal k = x - y, keep the
 * furthest x reachable; deletion from diagonal k-1 and insertion from k+1
 * compete, the larger x wins and deletion wins a tie; moves past either
 * end are not candidates; from the winning point follow equal lines (the
 * snake) as far as they go. Every d's furthest-x array is kept so the
 * winning path can be walked back with the same tie-break.
 */
function editRuns(a, b) {
  const n = a.length;
  const m = b.length;
  const history = [];
  // d = 0: the snake from the start on diagonal 0.
  let x = 0;
  while (x < n && x < m && a[x] === b[x]) x++;
  history.push(Int32Array.of(x));
  let foundD = -1;
  if (x >= n && x >= m) {
    foundD = 0;
  } else {
    const maxD = n + m;
    outer: for (let d = 1; d <= maxD; d++) {
      const prev = history[d - 1];
      const cur = new Int32Array(d + 1).fill(-1);
      for (let k = -d; k <= d; k += 2) {
        const idx = (k + d) >> 1;
        let delX = -1;
        let insX = -1;
        if (k > -d) {
          const xp = prev[(k + d - 2) >> 1];
          if (xp >= 0 && xp < n) delX = xp + 1;
        }
        if (k < d) {
          const xp = prev[(k + d) >> 1];
          if (xp >= 0 && xp - (k + 1) < m) insX = xp;
        }
        if (delX < 0 && insX < 0) continue;
        let cx = delX >= insX ? delX : insX;
        let cy = cx - k;
        while (cx < n && cy < m && a[cx] === b[cy]) {
          cx++;
          cy++;
        }
        cur[idx] = cx;
        if (cx >= n && cy >= m) {
          history.push(cur);
          foundD = d;
          break outer;
        }
      }
      history.push(cur);
    }
  }
  if (foundD < 0) throw new Error('diff: the search ended without reaching both ends');

  // Walk the winning path back, re-deriving each step's winner from the
  // stored furthest-x arrays with the same tie-break (deletion on a tie).
  const revKinds = [];
  const revCounts = [];
  let bx = n;
  let bk = n - m;
  for (let d = foundD; d >= 1; d--) {
    const prev = history[d - 1];
    let delX = -1;
    let insX = -1;
    let delPrev = -1;
    let insPrev = -1;
    if (bk > -d) {
      delPrev = prev[(bk + d - 2) >> 1];
      if (delPrev >= 0 && delPrev < n) delX = delPrev + 1;
    }
    if (bk < d) {
      insPrev = prev[(bk + d) >> 1];
      if (insPrev >= 0 && insPrev - (bk + 1) < m) insX = insPrev;
    }
    if (delX >= insX) {
      const snake = bx - delX;
      if (snake > 0) {
        revKinds.push(KEEP);
        revCounts.push(snake);
      }
      revKinds.push(DEL);
      revCounts.push(1);
      bx = delPrev;
      bk = bk - 1;
    } else {
      const snake = bx - insX;
      if (snake > 0) {
        revKinds.push(KEEP);
        revCounts.push(snake);
      }
      revKinds.push(INS);
      revCounts.push(1);
      bx = insPrev;
      bk = bk + 1;
    }
  }
  if (bx > 0) {
    revKinds.push(KEEP);
    revCounts.push(bx);
  }
  // Reverse into order, merging neighbouring runs of one kind.
  const runs = [];
  for (let i = revKinds.length - 1; i >= 0; i--) {
    const kind = revKinds[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += revCounts[i];
    else runs.push([kind, revCounts[i]]);
  }
  return runs;
}

/** One patch line: the op, the line itself, and "%" on its own line when the line had no newline. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** The makefun-diff/1 patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const aLines = splitLines(input.old);
  const bLines = splitLines(input.new);
  const n = aLines.length;
  const m = bLines.length;
  const [aIds, bIds] = internLines(aLines, bLines);

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  const minLen = n < m ? n : m;
  while (prefix < minLen && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  const mid = editRuns(aIds.subarray(prefix, n - suffix), bIds.subarray(prefix, m - suffix));
  for (const r of mid) runs.push(r);
  if (suffix > 0) runs.push([KEEP, suffix]);

  // Change runs: each stretch of deletions/insertions between kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of runs) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DEL) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // Hunks: change runs at most 2*CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h === undefined ? undefined : h[h.length - 1];
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aLines[at]));
  }
  return out.join('');
}
