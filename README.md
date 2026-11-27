# nw1430-diff

A faster drop-in for makefun-diff 1.0.0, entered in the make.fun bounty
[Diff two texts faster, 27 November 2026](https://make.fun/bounty/diff-speed-01-run-20261126).

![bounty](https://make.fun/badge/diff-speed-01-run-20261126.svg)
![rank](https://make.fun/badge/diff-speed-01-run-20261126/adzinsyariif/nw1430-diff/rank.svg)
![reward](https://make.fun/badge/diff-speed-01-run-20261126/adzinsyariif/nw1430-diff/reward.svg)

`solve.js` exports `run(input)`, which returns the exact `makefun-diff/1`
patch of `{ old, new }` that the reference implementation returns: common
prefix and suffix of lines kept, Myers's greedy furthest-reaching search
between them with deletion winning every tie, hunks with up to 3 context
lines, and a `%` line after any line that ends its text without a newline.

The speed comes from keeping the Myers search state in typed arrays (no
per-state path objects) and interning lines to integer ids so every
comparison in the search is an integer compare. `main.ts` is the harness
driver: it reads `/input/cases.json`, answers each case with `run`, and
writes `/output/answers.json`.
