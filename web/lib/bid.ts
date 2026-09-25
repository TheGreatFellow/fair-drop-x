import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { AUCTION_ADDRESS, POOL_FEE, TICK_SPACING } from "./auction";

// A bid is a Uniswap v4 swap: ETH into the auction pool through the Universal Router, with the
// sealed commitment and the World ID voucher riding along as hookData (SPEC §8.4). Same encoding
// as test/AuctionDrop.fork.t.sol, which runs it against Sepolia's real router.
const V4_SWAP = "0x10";
const SWAP_EXACT_IN_SINGLE_THEN_SETTLE_ALL = "0x060c";

export type Voucher = { dropId: Hex; buyer: Address; nullifierHash: bigint; deadline: bigint };

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** Must equal AuctionDrop.commitmentOf: keccak256(abi.encode(amount, secret, bidder)). */
export function commitmentOf(amount: bigint, secret: Hex, bidder: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }, { type: "address" }], [amount, secret, bidder]),
  );
}

export function randomSecret(): Hex {
  return `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Arguments for UniversalRouter.execute: swap `deposit` wei into the pool as a sealed bid. */
export function bidCall(voucher: Voucher, signature: Hex, commitment: Hex, deposit: bigint) {
  const hookData = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "dropId", type: "bytes32" },
          { name: "buyer", type: "address" },
          { name: "nullifierHash", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { type: "bytes" },
      { type: "bytes32" },
    ],
    [voucher, signature, commitment],
  );
  const swap = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    [
      {
        // ETH against the auction contract itself: the pool's other side is the drop's units.
        poolKey: {
          currency0: zeroAddress,
          currency1: AUCTION_ADDRESS,
          fee: POOL_FEE,
          tickSpacing: TICK_SPACING,
          hooks: AUCTION_ADDRESS,
        },
        zeroForOne: true,
        amountIn: deposit,
        amountOutMinimum: 0n, // the hook keeps the whole input; nothing comes out until settlement
        hookData,
      },
    ],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [zeroAddress, deposit]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [SWAP_EXACT_IN_SINGLE_THEN_SETTLE_ALL, [swap, settle]]);
  return {
    args: [V4_SWAP, [input], BigInt(Math.floor(Date.now() / 1000) + 600)] as const,
    value: deposit,
  };
}
