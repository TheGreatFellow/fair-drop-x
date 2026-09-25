# Phase 1 — contract + tests

**Tool:** Claude Code (Opus 5), 2026-09-25.

**Prompt:** "Read SPEC.md, propose a plan for step 1 (contract + tests), then build it. […]
working prototype is what we are aiming for"

## Decisions taken while building

- **One contract, `src/Drop.sol`.** ERC721 + EIP712 + ECDSA all come from OpenZeppelin v5.1,
  so the voucher signing, hashing and token are one dependency rather than three.
- **`curveSum` is maintained incrementally** (`+= price` on buy, `-= price` on sell-back)
  instead of summing the curve inside `withdraw`. `liability()` is then O(1), so a cascade
  can't run into a gas wall on the withdrawal path.
- **`liability()` floors the sum, `sellBack` floors each payout.** Since a sum of floors is
  never larger than the floor of the sum, the reserve is always at least the total that will
  actually be paid out — the rounding error lands in the contract's favour, as SPEC §6.1 asks.
- **`nextTokenId` is separate from `sold`.** `sold` is the curve position and moves back down on
  a sell-back; token ids never repeat, so a sold-back edition number is not reissued.
- **`redeem` deliberately does not decrement `sold`** — the unit was fulfilled, not returned.
- **Config passed as a struct**, not 11 positional constructor arguments. Same code, far less
  room for a mis-ordered price at deploy time.
- **Phase 2 hooks are in place**: empty `_afterMint` / `_beforeBurn` virtuals, so ENSv2 subname
  minting and revocation attach without editing `buy` or `sellBack`.

## Tests

34 tests in `test/Drop.t.sol`, using SPEC §6.4's exact configuration (N=100, base 3000, flat 20,
slope 150, steepStart 90, steepSlope 1500, spread 500) so the worked-example table is asserted
directly rather than paraphrased:

- `test_Cascade_MatchesSpecWorkedExample` reproduces the table — 80 sold, then 10/30/60/80
  sell-backs, checking units still sold and curve revenue at each row.
- `test_Cascade_EveryoneSellsBackAndAllGetPaid` — the full cascade; every seller is paid the
  quoted amount and the maker ends up with spread income only, never negative.
- `testFuzz_RandomChurnKeepsInvariants` — random interleaving of buys, sell-backs and maker
  withdrawals, asserting solvency and maker-never-loses after *every* step, then draining all
  remaining holders.
- Rejection paths: reused nullifier (the demo's required alternative path), sell-back not
  freeing the nullifier, forged signature, someone else's voucher, wrong drop id, expired
  voucher, underpayment, sale closed, sold out.

Maker cash is asserted as `>=` the table's yen figures rather than `==`: flooring each payout
individually leaves a few wei more in the contract than flooring the total would, which is the
safe direction.
