import "./env";
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hashSignal } from "@worldcoin/idkit/hashing";
import { parseNullifier, Rejection, rpContext, verifyProof, type IDKitResult } from "../lib/world";

const BUYER = "0xF0E135c4c36Ba36429E00a3680E64fA440Ec65fD";
const OTHER = "0xe8099d0E4e16be5901723025F711631526d2ff05";

function proofFor(wallet: string, overrides: Partial<IDKitResult> = {}): IDKitResult {
  return {
    protocol_version: "4.0",
    nonce: "0x01",
    action: process.env.WORLD_ACTION,
    environment: process.env.WORLD_ENVIRONMENT,
    responses: [{ identifier: "proof_of_human", signal_hash: hashSignal(wallet) }],
    ...overrides,
  };
}

function worldReplies(status: number, body: object) {
  return mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status }));
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof Rejection && e.code === code);
}

afterEach(() => mock.restoreAll());

test("rp context has the snake_case shape the widget needs, fresh each call", () => {
  const a = rpContext();
  const b = rpContext();
  assert.deepEqual(Object.keys(a).sort(), ["created_at", "expires_at", "nonce", "rp_id", "signature"]);
  assert.equal(a.rp_id, process.env.WORLD_RP_ID);
  assert.match(a.signature, /^0x[0-9a-f]{130}$/i);
  assert.equal(a.expires_at - a.created_at, 300);
  assert.notEqual(a.nonce, b.nonce, "a reused nonce is rejected by World as duplicate_nonce");
});

test("nullifiers compare as numbers, so leading zeros can't double-spend", () => {
  assert.equal(parseNullifier("0x04e5"), parseNullifier("0x4e5"));
  assert.equal(parseNullifier("0x" + "f".repeat(64)), 2n ** 256n - 1n);
  for (const bad of ["04e5", "0x", "0xzz", "0x" + "1".repeat(65), 42, undefined]) {
    assert.throws(() => parseNullifier(bad), Rejection, `should reject ${String(bad)}`);
  }
});

// These must all be refused before World is ever called.
for (const [name, result, code] of [
  ["not a 4.0 proof", proofFor(BUYER, { protocol_version: "3.0" }), "unsupported_proof"],
  ["another action", proofFor(BUYER, { action: "some-other-drop" }), "wrong_action"],
  ["another environment", proofFor(BUYER, { environment: "sandbox" }), "wrong_environment"],
  ["no responses", proofFor(BUYER, { responses: [] }), "missing_proof"],
  ["made for another wallet", proofFor(OTHER), "signal_mismatch"],
  ["no signal at all", proofFor(BUYER, { responses: [{ identifier: "proof_of_human" }] }), "signal_mismatch"],
] as const) {
  test(`rejects a proof ${name} without calling World`, async () => {
    const fetchMock = worldReplies(200, { success: true });
    await rejects(verifyProof(result, BUYER), code);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
}

test("signal check ignores address casing", async () => {
  worldReplies(200, {
    success: true,
    environment: process.env.WORLD_ENVIRONMENT,
    nullifier: "0x2a",
    results: [{ identifier: "proof_of_human", success: true }],
  });
  assert.equal(await verifyProof(proofFor(BUYER.toLowerCase()), BUYER), 42n);
});

test("valid proof: returns World's nullifier and calls our RP with only World's fields", async () => {
  const fetchMock = worldReplies(200, {
    success: true,
    environment: process.env.WORLD_ENVIRONMENT,
    nullifier: "0x00ab",
    results: [{ identifier: "proof_of_human", success: true }],
  });
  const nullifier = await verifyProof({ ...proofFor(BUYER), injected: "x" } as IDKitResult, BUYER);

  assert.equal(nullifier, 0xabn);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, `https://developer.world.org/api/v4/verify/${process.env.WORLD_RP_ID}`);
  assert.deepEqual(Object.keys(JSON.parse(init.body as string)).sort(), [
    "action",
    "environment",
    "nonce",
    "protocol_version",
    "responses",
  ]);
});

test("trusts World's environment over the client's claim", async () => {
  worldReplies(200, {
    success: true,
    environment: "sandbox",
    nullifier: "0x1",
    results: [{ identifier: "proof_of_human", success: true }],
  });
  await rejects(verifyProof(proofFor(BUYER), BUYER), "wrong_environment");
});

test("rejects a weaker credential even when World verified it", async () => {
  worldReplies(200, {
    success: true,
    environment: process.env.WORLD_ENVIRONMENT,
    nullifier: "0x1",
    results: [{ identifier: "selfie_check", success: true }],
  });
  await rejects(verifyProof(proofFor(BUYER), BUYER), "wrong_credential");
});

test("passes World's error code through for the frontend", async () => {
  worldReplies(400, { success: false, code: "max_verifications_reached", detail: "limit" });
  await rejects(verifyProof(proofFor(BUYER), BUYER), "max_verifications_reached");
});
