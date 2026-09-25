# Phase 1 — World ID backend

**Tool:** Claude Code (Opus 5 / 5.5), 2026-09-26.

**Prompts:** "go ahead with the world backend"; then, mid-build, "if you want actual implementation
go to ethglobal showcase ... find the winners for world track" and "then why dont you check that in
winners of other 2026 hackathons".

## Research, and what each reference was worth

- **hackpass** (ETHOnline 2026 World Selfie Check winner): mostly mocked, still on the v2 verify
  endpoint. Worth one thing: the `rp_context` snake_case gotcha.
- **Turing Swap** (ETHOnline 2026 AgentKit winner): `idkit-core@2.1.0` and AgentKit — not the v4
  proof path.
- **World's own `worldcoin/idkit` Next.js example:** the right code shape, but its verify route
  trusts the client's `rp_id` and portal URL and skips signal and environment checks.
- **Phora** (ETHGlobal New York 2026, World ID 4.0 for one-human-one-record): the most useful. It
  surfaced the open question about whether 4.0 nullifiers are deterministic per person, which the
  whole one-per-human rule depends on, and `no-store` on RP signatures.
- The user's push to look at other 2026 events is what found Phora, and with it the determinism
  risk that neither World's docs nor its example states plainly.

## Decisions

- Route handlers in Next.js instead of a separate server: one app, no CORS, one deploy.
- `proof_of_human` required and enforced server-side (reasoning in `docs/world-debrief.md`).
- Stricter than every reference: signal bound to the buyer, environment pinned in request and
  response, credential enforced, RP ID from config, only World's fields forwarded, nullifiers
  compared numerically.
- The contract, not a database, answers "already purchased": nothing to lose on restart.
- `lib/drop.ts` is generated from the Foundry build and deployment record so it cannot drift.

## Verified

16 tests. The two that matter most run against the real deployed contract: the voucher digest
equals the live `hashVoucher()`, and on an anvil fork a backend-signed voucher buys and a second
voucher for the same nullifier reverts `AlreadyPurchased`. Live checks against World: our `rp_id`
reaches proof verification (a bogus one gets `app_not_migrated`), and a correctly bound fake proof
is rejected as `all_verifications_failed`.

One harness finding: anvil's default key is public, and on Sepolia it carries an EIP-7702
delegation, so on a fork `_safeMint` calls a delegate that reverts. Tests use a fresh key.

## Tested with the staging simulator (2026-09-26)

- First real proof end to end: verify → voucher → onchain buy, working.
- Same identity verified five more times: identical nullifier each time, and every repeat purchase
  refused as `already_purchased`. World did not enforce `max_verifications: 1` on staging.
- Two UI bugs found and fixed: a reused widget replayed a consumed request ("Verification
  unavailable" for everyone after the first purchase), and the widget's generic "contact the website
  owner" screen hid our "Already purchased" message.
