import "./env";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/test-voucher/route";

const saved = { ...process.env };
afterEach(() => {
  process.env.ALLOW_UNVERIFIED_TEST_BUYS = saved.ALLOW_UNVERIFIED_TEST_BUYS;
  process.env.WORLD_ENVIRONMENT = saved.WORLD_ENVIRONMENT;
});
const call = () =>
  POST(new Request("http://x", { method: "POST", body: JSON.stringify({ buyer: "0xF0E135c4c36Ba36429E00a3680E64fA440Ec65fD" }) }));

test("test vouchers don't exist unless explicitly enabled", async () => {
  process.env.ALLOW_UNVERIFIED_TEST_BUYS = "";
  process.env.WORLD_ENVIRONMENT = "staging";
  assert.equal((await call()).status, 404);
});

test("test vouchers never exist in production, even when enabled", async () => {
  process.env.ALLOW_UNVERIFIED_TEST_BUYS = "true";
  process.env.WORLD_ENVIRONMENT = "production";
  assert.equal((await call()).status, 404);
});

test("when enabled on staging, each call gets a fresh nullifier", async () => {
  process.env.ALLOW_UNVERIFIED_TEST_BUYS = "true";
  process.env.WORLD_ENVIRONMENT = "staging";
  const [a, b] = await Promise.all([call().then((r) => r.json()), call().then((r) => r.json())]);
  assert.ok(a.signature && b.signature);
  assert.notEqual(a.voucher.nullifierHash, b.voucher.nullifierHash);
});
