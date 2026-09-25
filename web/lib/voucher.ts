import "server-only";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { DROP_ADDRESS, DROP_ID, DROP_VERIFIER, dropAbi } from "./drop";
import { AUCTION_ADDRESS, AUCTION_ID } from "./auction";

// Long enough to confirm a wallet popup and wait out a slow block; short enough that a leaked
// voucher is useless soon. It can only ever buy for its own buyer and nullifier anyway.
const VOUCHER_TTL_SECONDS = 15 * 60;

/** Which contract a voucher is for: the Phase 1 curve drop or the auction drop (SPEC §8). */
export type Target = "drop" | "auction";
const TARGETS = {
  drop: { address: DROP_ADDRESS, dropId: DROP_ID },
  auction: { address: AUCTION_ADDRESS, dropId: AUCTION_ID },
} as const;

export function parseTarget(value: unknown): Target {
  return value === "auction" ? "auction" : "drop";
}

// Must match Drop.sol and AuctionDrop.sol exactly: EIP712("Drop", "1") and VOUCHER_TYPEHASH.
export function domainFor(target: Target) {
  return { name: "Drop", version: "1", chainId: sepolia.id, verifyingContract: TARGETS[target].address } as const;
}
export const voucherDomain = domainFor("drop");

export const voucherTypes = {
  Voucher: [
    { name: "dropId", type: "bytes32" },
    { name: "buyer", type: "address" },
    { name: "nullifierHash", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });

/** The contract is the source of truth for "already purchased" — it survives backend restarts. */
export function isNullifierUsed(nullifier: bigint, target: Target = "drop"): Promise<boolean> {
  return client.readContract({
    address: TARGETS[target].address,
    abi: dropAbi, // both contracts expose the same nullifierUsed(uint256)
    functionName: "nullifierUsed",
    args: [nullifier],
  });
}

export async function signVoucher(buyer: Address, nullifierHash: bigint, target: Target = "drop") {
  const account = privateKeyToAccount(process.env.VERIFIER_PRIVATE_KEY as Hex);
  // A key that isn't the deployed verifier would sign vouchers the contract rejects as
  // BadSignature — fail loudly here instead, where the cause is obvious.
  if (account.address.toLowerCase() !== DROP_VERIFIER.toLowerCase()) {
    throw new Error(`VERIFIER_PRIVATE_KEY is for ${account.address}, but the drops expect ${DROP_VERIFIER}`);
  }

  const voucher = {
    dropId: TARGETS[target].dropId,
    buyer,
    nullifierHash,
    deadline: BigInt(Math.floor(Date.now() / 1000) + VOUCHER_TTL_SECONDS),
  };
  const signature = await account.signTypedData({
    domain: domainFor(target),
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
  });
  return { voucher, signature };
}
