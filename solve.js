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
  let lastLine = null;
  let lastId = -1;
  for (let i = 0; i < aLines.length; i++) {
    const line = aLines[i];
    if (line === lastLine) {
      aIds[i] = lastId;
      continue;
    }
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    lastLine = line;
    lastId = id;
    aIds[i] = id;
  }
  for (let i = 0; i < bLines.length; i++) {
    const line = bLines[i];
    if (line === lastLine) {
      bIds[i] = lastId;
      continue;
    }
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    lastLine = line;
    lastId = id;
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
 * snake) as far as they go. Every d's furthest-x row is kept in one growing
 * Int32Array (stored as x + 1, so 0 marks a dead diagonal) so the winning
 * path can be walked back with the same tie-break. Both id arrays carry a
 * distinct sentinel id in their last slot, so a snake stops at either end
 * without bounds checks: a and b have length n + 1 and m + 1.
 */
function editRuns(a, b) {
  const n = a.length - 1;
  const m = b.length - 1;
  const targetK = n - m;
  // Furthest-x values fit in 16 bits while both texts stay under 65535
  // lines (x + 1 <= 65535); wider texts fall back to a 32-bit buffer.
  const BufArray = n <= 65534 && m <= 65534 ? Uint16Array : Int32Array;
  let buf = new BufArray(1 << 18);
  const rowStarts = [0];
  // d = 0: the snake from the start on diagonal 0.
  let x = 0;
  while (a[x] === b[x]) x++;
  buf[0] = x + 1;
  let foundD = -1;
  if (x >= n && x >= m) {
    foundD = 0;
  } else {
    const maxD = n + m;
    let prevStart = 0;
    outer: for (let d = 1; d <= maxD; d++) {
      const curStart = prevStart + d;
      rowStarts.push(curStart);
      const need = curStart + d + 1;
      if (need > buf.length) {
        let cap = buf.length * 2;
        while (cap < need) cap *= 2;
        const next = new BufArray(cap);
        next.set(buf);
        buf = next;
      }
      // Diagonal k = 2*idx - d; its deletion predecessor is prev[idx - 1],
      // its insertion predecessor prev[idx]. The two edge diagonals have a
      // single candidate each and are peeled out of the loop.
      {
        // idx = 0, k = -d: insertion from prev[0] only.
        const s = buf[prevStart];
        if (s > 0 && s - 1 + d - 1 < m) {
          let cx = s - 1;
          let cy = cx + d;
          while (a[cx] === b[cy]) {
            cx++;
            cy++;
          }
          buf[curStart] = cx + 1;
          if (-d === targetK && cx >= n) {
            foundD = d;
            break outer;
          }
        }
      }
      let k = -d + 2;
      for (let idx = 1; idx < d; idx++, k += 2) {
        const sd = buf[prevStart + idx - 1];
        const si = buf[prevStart + idx];
        let delX = -1;
        let insX = -1;
        if (sd > 0 && sd <= n) delX = sd;
        if (si > 0 && si - k - 2 < m) insX = si - 1;
        if (delX < 0 && insX < 0) continue;
        let cx = delX >= insX ? delX : insX;
        let cy = cx - k;
        while (a[cx] === b[cy]) {
          cx++;
          cy++;
        }
        buf[curStart + idx] = cx + 1;
        if (k === targetK && cx >= n) {
          foundD = d;
          break outer;
        }
      }
      {
        // idx = d, k = d: deletion from prev[d - 1] only.
        const s = buf[prevStart + d - 1];
        if (s > 0 && s <= n) {
          let cx = s;
          let cy = cx - d;
          while (a[cx] === b[cy]) {
            cx++;
            cy++;
          }
          buf[curStart + d] = cx + 1;
          if (d === targetK && cx >= n) {
            foundD = d;
            break outer;
          }
        }
      }
      prevStart = curStart;
    }
  }
  if (foundD < 0) throw new Error('diff: the search ended without reaching both ends');

  // Walk the winning path back, re-deriving each step's winner from the
  // stored furthest-x rows with the same tie-break (deletion on a tie).
  const revKinds = [];
  const revCounts = [];
  let bx = n;
  let bk = targetK;
  for (let d = foundD; d >= 1; d--) {
    const prevStart = rowStarts[d - 1];
    const idx = (bk + d) >> 1;
    let delX = -1;
    let insX = -1;
    let delPrev = -1;
    let insPrev = -1;
    if (idx > 0) {
      const s = buf[prevStart + idx - 1];
      delPrev = s - 1;
      if (s > 0 && delPrev < n) delX = s;
    }
    if (idx < d) {
      const s = buf[prevStart + idx];
      insPrev = s - 1;
      if (s > 0 && insPrev - (bk + 1) < m) insX = insPrev;
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
  return line.charCodeAt(line.length - 1) === 10 ? op + line : op + line + '\n%\n';
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
  // The middle id arrays, each closed by a distinct sentinel id (-1 / -2)
  // so the search's snakes stop at either end on a mismatch.
  const midA = new Int32Array(n - suffix - prefix + 1);
  midA.set(aIds.subarray(prefix, n - suffix));
  midA[midA.length - 1] = -1;
  const midB = new Int32Array(m - suffix - prefix + 1);
  midB.set(bIds.subarray(prefix, m - suffix));
  midB[midB.length - 1] = -2;
  const mid = editRuns(midA, midB);
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
