# World ID integration debrief

Required for World's "Best Use of IDKit" prize (SPEC §6.5). Written during the build, not after,
so the friction is recorded as it happened.

**Stack:** IDKit 4.3 (`@worldcoin/idkit`), World ID 4.0 `proof_of_human`, server-side verification
through `POST /api/v4/verify/{rp_id}` in Next.js route handlers, with the nullifier enforced a
second time onchain by `Drop.sol`.

## The trust moment, and why this credential

A buyer proves they are a unique human, bound to the wallet they are buying with. The backend
verifies the proof with World, then signs an EIP-712 voucher carrying the nullifier; the contract
refuses any nullifier it has seen before. Selling back does not free the nullifier, so nobody can
cycle a unit.

`proof_of_human` (Orb-backed) is the minimum *sufficient* assurance here, because the attacker is a
scalper running many accounts, and only Orb-backed uniqueness stops one person from being many
buyers. A weaker, device-based credential would let the same scalper buy once per phone. The
backend enforces the credential rather than trusting the widget's request, so a weaker one cannot
be substituted.

## Time to first success

Measured from git history and the chain, not recalled:

| Milestone | When (JST) | Elapsed |
|---|---|---|
| First World ID code: IDKit v4 config added | Fri 23:00 | 0:00 |
| Signing key validated, staging chosen | Fri 23:45 | 0:45 |
| RP signing + server-side verification, 13 tests | Sat 00:26 | 1:26 |
| Drop page with the IDKit widget | Sat 00:39 | 1:39 |
| **First real proof verified end to end** — simulator → World v4 verify → EIP-712 voucher → onchain `buy()` ([Sepolia block 11780192](https://sepolia.etherscan.io/block/11780192)) | **Sat 00:43** | **1:43** |

About **1h45m from the first line of World ID code to a verified onchain purchase**, and four
minutes from the page existing to the first success. Roughly half of that time went to the friction
below — mostly items 1–5, which are documentation gaps rather than code. (Item 12 came later: an overnight Portal change that broke staging after this first success.)

## Friction, in the order we hit it

1. **Signing key vs. signer address.** The Portal shows both; we pasted the 20-byte address first.
   The SDK's error was excellent (`expected 32 bytes (64 hex chars), got 20 bytes`) and caught it
   instantly.
2. **The `rp_context` shape contradicts itself across pages.** The integration guide's example
   returns `{ sig, nonce, created_at, expires_at }`; the React reference requires
   `{ rp_id, nonce, created_at, expires_at, signature }`. `signRequest()` itself returns camelCase.
   A reference project from a previous hackathon recorded passing the wrong shape as the root cause
   of every opaque `generic_error` / BigInt failure they hit.
3. **Sandbox vs. staging is unclear.** Sandbox needs TestFlight or Play-store tester approval plus a
   separate app build; staging needs nothing and pairs with the web simulator. Staging is also no
   longer a per-app property, which contradicts older material. We initially chose sandbox and
   would have been blocked on an approval queue during a 36-hour event.
4. **Nullifier determinism in 4.0 is not stated.** The migration guide calls nullifiers
   "one-time-use" and says `session_id` is the stable identifier; the verify docs say the backend
   must check the nullifier "otherwise, the same person could verify multiple times", which only
   makes sense if the same person produces the same nullifier. For any one-per-human app this is
   the most important fact about the protocol, and it has to be inferred.
5. **Signal hashing is undocumented in the integration path.** The docs say the backend "must
   enforce matching values" but not how. We read the SDK source to find `hashSignal`
   (`keccak256(bytes) >> 8`, with `0x` strings hashed as raw bytes).
6. **The official Next.js example is unsafe to copy as-is.** Its verify route takes `rp_id` and the
   Developer Portal base URL from the client, and checks neither the signal nor the environment.
   Examples get copied, especially at hackathons.
7. **Nothing warns that staging proofs must be refused in production.** The simulator mints
   unlimited identities, so an app that forwards `environment` from the client without checking
   World's answer can be sybil-attacked through staging.
8. **`max_verifications` interacts badly with a purchase flow.** At 1, a person who verifies and
   then fails the purchase transaction is locked out of the action for good.
9. **A bad `rp_id` returns `app_not_migrated`.** Misleading — it reads like a Portal setting to
   change rather than a typo — and the endpoint validates the body before the RP, so the ID can't
   be sanity-checked without a well-formed proof.

10. **The widget replaces the host's rejection with a generic one.** When `handleVerify` throws —
    here, because the person already bought — IDKit shows "Verification declined: Failed to verify
    your credential proof. Please contact the website owner." That tells an honest user their
    proof is broken, when the truth is "you already bought one". There is no way to pass a message
    through; we close the widget ourselves and show our own.

11. **The simulator can only be one v4 person.** For World ID 4.0 requests, the hosted simulator's
    sidecar auto-selects a pre-configured identity from the requested credential
    (`identity_index` is "deprecated and ignored"), so every `proof_of_human` proof carries the same
    nullifier — across identity switches, fresh browsers, everything. The in-browser identity
    switcher only affects v3 proofs. So a one-per-human app cannot test "a second human can buy" on
    staging with v4 at all. We confirmed it with a diagnostic (the proof's own nullifier, World's
    top-level field and its per-result field were identical from two browsers) and then in the
    simulator's source. Missing capability: a way to pick among several v4 test identities.
    The tempting workaround — enabling legacy v3 proofs to get switchable identities — would open a
    real hole: one person could then buy once with a v3 proof and once with a v4 one.

12. **Staging broke mid-hackathon, with no notice.** Our staging integration worked end to end on
    Sat 00:43. By Sat ~08:00 the same code got `403 environment_not_allowed`: "Staging verification
    is not open for this app. Open a staging window with the set_world_id_staging_verification
    tool…". A Developer Portal change merged on Sep 25 now requires two things for any staging
    proof:
    - the app's team opens a 24-hour staging window through the Portal **MCP** tool
      `set_world_id_staging_verification`, authenticated with a team API key;
    - every verify call sends the token that window issued as an `x-staging-verification-token`
      header.

    There is no Portal UI for it yet, and we found no changelog or docs page announcing it. We
    learned the header name and the token lifetime by reading the Portal's source. The window closes
    itself after 24 hours, and reopening it replaces the token, so a demo that spans more than a day
    has to reopen the window and redeploy the new token beforehand.

    To be fair to World: the change is right. It closes exactly the hole in item 7 on World's side:
    before it, a production RP accepted freely mintable simulator identities from anyone who sent
    `environment: "staging"`. The error message is also good, because it names the tool to use. The
    friction is that a breaking change landed silently during an event full of staging integrations,
    and the fix is reachable only through MCP. Took about 30 minutes: find the source, add the
    header, script the window (`web/scripts/open-staging-window.mjs`).

## Confirmed by testing

- **Nullifiers are deterministic per person and action.** One simulator identity verified five
  times and produced the same nullifier every time. This settles friction item 4 in practice —
  but it is still worth stating in the docs.
- **`max_verifications: 1` was not enforced on staging.** The same person verified five times with
  World returning success each time. Our contract's `nullifierUsed` check refused every repeat
  purchase, which is why uniqueness is enforced onchain rather than delegated to the Portal setting.

## The single most impactful improvement

A server helper in `@worldcoin/idkit` that does the uniqueness checks every one-per-human app
needs and currently reimplements (or, following the official example, skips):

```ts
const { nullifier } = await verifyUniqueHuman(result, {
  rpId, action, environment: "production", signal: buyerWallet, credential: "proof_of_human",
});
```

Binding the signal, pinning the environment in both request and response, requiring the
credential, taking the RP ID from server config and returning the nullifier as a canonical
integer — all in one call. Items 5, 6 and 7 above disappear.
