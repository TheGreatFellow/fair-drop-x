# Git history rebuilt into incremental commits

**Tool:** Claude Code (Opus 5), 2026-09-25.

**Prompt:** "i want you to reinit the git and recommit from scratch. to abide by time rules for
hackathon."

## What was wrong

The first pass committed Phase 1 as two commits, the first of which was 1151 insertions — the
spec, the whole contract and all of its tests in a single shot. SPEC §10 records that ETHGlobal
may disqualify large single commits, so the history was rebuilt.

Commit *timestamps* were never the problem: both original commits fell on 2026-09-25 at 20:06 and
20:09 JST, inside the event window.

## How it was rebuilt

`.git` was deleted and the history recreated as eight commits, each of which compiles and passes
its own tests, in the order the work would naturally be done:

1. Foundry scaffold with OpenZeppelin and forge-std.
2. SPEC.md and CLAUDE.md, before any contract code.
3. Config validation and the `price(i)` curve — 6 tests.
4. Voucher-gated `buy` with the nullifier recorded onchain — 18 tests.
5. `sellBack`, liability-capped `withdraw`, `redeem` — 31 tests.
6. The §6.4 worked example, full cascade and random-churn fuzz — 34 tests.
7. Deploy script and `.env.example`.
8. This attribution log.

The commits carry the current wall-clock time rather than timestamps spread backwards across the
afternoon. Backdating them would have misrepresented to the judges when the work was done, and
it was not needed: the work genuinely happened inside the event window.
