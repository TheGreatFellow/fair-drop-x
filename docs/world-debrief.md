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

- First correctly signed RP request accepted by World's v4 endpoint: _pending the first real proof._
- First real proof verified end to end: _pending (staging simulator)._

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
