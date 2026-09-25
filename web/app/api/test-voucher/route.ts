import { getAddress, isAddress } from "viem";
import { parseTarget, signVoucher } from "@/lib/voucher";

/**
 * Test-only: a voucher WITHOUT World ID, under a random nullifier, so one wallet can buy many units
 * and exercise the curve, the phase switch and sell-back. The staging simulator can only ever be
 * one v4 person, so without this the rest of the drop can't be tested.
 *
 * Off unless ALLOW_UNVERIFIED_TEST_BUYS=true, and never in production: it removes the
 * one-per-person rule, which is the product.
 */
function testBuysAllowed() {
  return process.env.ALLOW_UNVERIFIED_TEST_BUYS === "true" && process.env.WORLD_ENVIRONMENT !== "production";
}

export async function POST(request: Request) {
  if (!testBuysAllowed()) return new Response(null, { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (typeof body.buyer !== "string" || !isAddress(body.buyer)) {
    return Response.json({ code: "bad_buyer", message: "buyer must be a wallet address" }, { status: 400 });
  }
  const nullifier = BigInt(
    "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
  const { voucher, signature } = await signVoucher(getAddress(body.buyer), nullifier, parseTarget(body.drop));
  return Response.json({
    voucher: { ...voucher, nullifierHash: voucher.nullifierHash.toString(), deadline: voucher.deadline.toString() },
    signature,
  });
}
