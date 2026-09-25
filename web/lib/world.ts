import "server-only";
import { signRequest } from "@worldcoin/idkit/signing";
import { hashSignal } from "@worldcoin/idkit/hashing";
import type { Address } from "viem";

// World ID 4.0 (SPEC §6.2). The RP id goes in the path and always comes from server config —
// never from the client, or a caller could have their proof checked against someone else's app.
const VERIFY_URL = "https://developer.world.org/api/v4/verify";
const RP_SIGNATURE_TTL_SECONDS = 300;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A refusal the route turns into an HTTP response; `code` is what the frontend branches on. */
export class Rejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The context the IDKit widget needs to open a proof request.
 *
 * The widget wants snake_case and `signature`; signRequest() returns camelCase and `sig`. Passing
 * signRequest's shape straight through fails inside the SDK with an opaque BigInt error.
 */
export function rpContext() {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: env("RP_SIGNING_KEY"),
    action: env("WORLD_ACTION"),
    ttl: RP_SIGNATURE_TTL_SECONDS,
  });
  return {
    rp_id: env("WORLD_RP_ID"),
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
    signature: sig,
  };
}

/**
 * Nullifiers are compared as numbers, never strings: "0x04e5" and "0x4e5" are the same human.
 * A string comparison would let one person buy twice — the hex-parsing pitfall World's docs warn
 * about — and the contract keys `nullifierUsed` by uint256 anyway.
 */
export function parseNullifier(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Rejection(502, "bad_nullifier", "World returned a malformed nullifier");
  }
  return BigInt(value);
}

type ProofResponse = { identifier?: string; signal_hash?: string };
export type IDKitResult = {
  protocol_version?: string;
  nonce?: string;
  action?: string;
  environment?: string;
  responses?: ProofResponse[];
};
type VerifyResult = { identifier?: string; success?: boolean; nullifier?: string };

/**
 * Verifies a World ID proof server-side and returns the buyer's nullifier. Throws a Rejection.
 *
 * Checks beyond "World said yes", each closing a specific hole:
 *  - the proof's signal is the buyer's wallet, so a proof can't be replayed for another wallet;
 *  - the environment matches ours, because anyone can mint unlimited staging identities in the
 *    simulator, and those must never pass in production;
 *  - the credential is the one we require, so a weaker one can't stand in for it.
 */
export async function verifyProof(result: IDKitResult, buyer: Address): Promise<bigint> {
  const action = env("WORLD_ACTION");
  const environment = env("WORLD_ENVIRONMENT");
  const credential = process.env.WORLD_CREDENTIAL || "proof_of_human";

  if (result?.protocol_version !== "4.0") {
    throw new Rejection(400, "unsupported_proof", "Expected a World ID 4.0 proof");
  }
  if (result.action !== action) {
    throw new Rejection(400, "wrong_action", "Proof is for a different action");
  }
  if (result.environment !== environment) {
    throw new Rejection(400, "wrong_environment", `Proof is from ${result.environment}, expected ${environment}`);
  }
  const responses = result.responses ?? [];
  if (responses.length === 0) {
    throw new Rejection(400, "missing_proof", "Proof has no responses");
  }

  // Checked before calling World: cheap, and a mismatch is never worth a network round trip.
  const expectedSignal = BigInt(hashSignal(buyer));
  for (const r of responses) {
    if (!r.signal_hash || BigInt(r.signal_hash) !== expectedSignal) {
      throw new Rejection(400, "signal_mismatch", "Proof was made for a different wallet");
    }
  }

  // Forward only the fields World defines, not whatever else the client sent.
  const res = await fetch(`${VERIFY_URL}/${env("WORLD_RP_ID")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      protocol_version: result.protocol_version,
      nonce: result.nonce,
      action: result.action,
      environment: result.environment,
      responses,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.success) {
    // World's codes pass through (e.g. max_verifications_reached, nullifier_replayed,
    // rp_signature_expired) so the frontend can say something specific.
    throw new Rejection(400, data?.code ?? "verification_failed", data?.detail ?? "World ID verification failed");
  }

  // From here on, trust World's answer rather than the client's copy of it.
  if (data.environment !== environment) {
    throw new Rejection(400, "wrong_environment", `World verified a ${data.environment} proof, expected ${environment}`);
  }
  const results: VerifyResult[] = data.results ?? [];
  const match = results.find((r) => r.identifier === credential && r.success);
  if (!match) {
    throw new Rejection(400, "wrong_credential", `Requires the ${credential} credential`);
  }
  // World puts the nullifier at the top level; some responses only carry it per result.
  return parseNullifier(data.nullifier ?? match.nullifier);
}
