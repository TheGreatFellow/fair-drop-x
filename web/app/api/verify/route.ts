import { getAddress, isAddress } from "viem";
import { Rejection, verifyProof, type IDKitResult } from "@/lib/world";
import { isNullifierUsed, parseTarget, signVoucher } from "@/lib/voucher";

/**
 * POST { buyer, result, drop? } -> { voucher, signature }
 *
 * `result` is the IDKit widget's output, forwarded untouched. On a valid proof for this buyer,
 * returns an EIP-712 voucher the buyer passes to Drop.buy(), or — with drop: "auction" — puts in
 * their bid's hookData for AuctionDrop.
 *
 *   200  voucher issued
 *   400  proof rejected — `code` is ours or World's (e.g. max_verifications_reached)
 *   409  already_purchased: this human's nullifier is already used onchain
 */
export async function POST(request: Request) {
  let body: { buyer?: unknown; result?: IDKitResult; drop?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }
  if (typeof body.buyer !== "string" || !isAddress(body.buyer)) {
    return Response.json({ code: "bad_buyer", message: "buyer must be a wallet address" }, { status: 400 });
  }
  const buyer = getAddress(body.buyer);
  const target = parseTarget(body.drop);

  try {
    const nullifier = await verifyProof(body.result ?? {}, buyer);
    // Public anyway (it lands onchain in Bought). Logged so a repeat verification by the same
    // person can be compared: World ID 4.0 docs never state the nullifier is deterministic.
    console.log(`verify: ${buyer} nullifier 0x${nullifier.toString(16).padStart(64, "0")}`);
    if (await isNullifierUsed(nullifier, target)) {
      const message =
        target === "auction" ? "This person has already bid in this auction" : "This person has already bought from this drop";
      return Response.json(
        { code: "already_purchased", message },
        { status: 409 },
      );
    }
    const { voucher, signature } = await signVoucher(buyer, nullifier, target);
    // uint256s travel as decimal strings; JSON has no bigint.
    return Response.json({
      voucher: { ...voucher, nullifierHash: voucher.nullifierHash.toString(), deadline: voucher.deadline.toString() },
      signature,
    });
  } catch (err) {
    if (err instanceof Rejection) {
      return Response.json({ code: err.code, message: err.message }, { status: err.status });
    }
    console.error("verify:", err);
    return Response.json({ code: "server_error", message: "Verification failed unexpectedly" }, { status: 500 });
  }
}
