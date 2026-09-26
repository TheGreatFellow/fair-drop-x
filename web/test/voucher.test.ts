import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  hashTypedData,
  http,
  recoverTypedDataAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { DROP_ADDRESS, DROP_VERIFIER, dropAbi } from "../lib/drop";
import { AUCTION_ADDRESS, auctionAbi } from "../lib/auction";
import { domainFor, isNullifierUsed, signVoucher, voucherDomain, voucherTypes } from "../lib/voucher";

const BUYER = "0xF0E135c4c36Ba36429E00a3680E64fA440Ec65fD";
const live = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const randomNullifier = () => BigInt("0x" + crypto.getRandomValues(new Uint8Array(31)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""));

test("voucher digest matches the deployed contract's hashVoucher, signed by its verifier", async () => {
  const { voucher, signature } = await signVoucher(BUYER, randomNullifier());
  const local = hashTypedData({ domain: voucherDomain, types: voucherTypes, primaryType: "Voucher", message: voucher });
  const onchain = await live.readContract({ address: DROP_ADDRESS, abi: dropAbi, functionName: "hashVoucher", args: [voucher] });

  assert.equal(local, onchain, "EIP-712 domain or types drifted from Drop.sol");
  const signer = await recoverTypedDataAddress({
    domain: voucherDomain,
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
    signature,
  });
  assert.equal(signer.toLowerCase(), DROP_VERIFIER.toLowerCase());
});

test("auction vouchers match the deployed AuctionDrop's hashVoucher and carry its dropId", async () => {
  const { voucher } = await signVoucher(BUYER, randomNullifier(), "auction");
  const local = hashTypedData({ domain: domainFor("auction"), types: voucherTypes, primaryType: "Voucher", message: voucher });
  const onchain = await live.readContract({ address: AUCTION_ADDRESS, abi: auctionAbi, functionName: "hashVoucher", args: [voucher] });
  assert.equal(local, onchain, "EIP-712 domain or types drifted from AuctionDrop.sol");
  const dropId = await live.readContract({ address: AUCTION_ADDRESS, abi: auctionAbi, functionName: "dropId" });
  assert.equal(voucher.dropId, dropId);
  assert.equal(await isNullifierUsed(randomNullifier(), "auction"), false);
});

test("an unused nullifier reads as unused on the live drop", async () => {
  assert.equal(await isNullifierUsed(randomNullifier()), false);
});

// A real buy() against the real deployed bytecode, on a local fork so the demo drop is untouched.
const ANVIL = [`${process.env.HOME}/.foundry/bin/anvil`, "anvil"].find((p) => p === "anvil" || existsSync(p))!;

test("voucher buys on a fork of the deployed drop — and the same human can't buy twice", async (t) => {
  const port = 8546;
  const anvil = spawn(ANVIL, ["--fork-url", process.env.SEPOLIA_RPC_URL!, "--port", String(port), "--silent"]);
  t.after(() => anvil.kill());

  const chain = { ...sepolia, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } };
  const fork = createPublicClient({ chain, transport: http() });
  for (let i = 0; ; i++) {
    try {
      await fork.getChainId();
      break;
    } catch {
      if (i > 150) throw new Error("anvil did not start"); // 30s: forks start slowly on a public RPC
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert.equal(await fork.getChainId(), sepolia.id, "fork must keep Sepolia's chain id or the EIP-712 domain breaks");

  // A fresh key, not anvil's default one: that key is public, so on Sepolia someone has put an
  // EIP-7702 delegation on it, and the fork inherits that code — _safeMint then calls
  // onERC721Received on the delegate, which reverts with no data.
  const account = privateKeyToAccount(generatePrivateKey());
  await fork.request({ method: "anvil_setBalance" as never, params: [account.address, "0xde0b6b3a7640000"] as never });
  const wallet = createWalletClient({ account, chain, transport: http() });
  const nullifier = randomNullifier();
  const { voucher, signature } = await signVoucher(account.address, nullifier);
  const read = <F extends "currentPrice" | "sold">(functionName: F) =>
    fork.readContract({ address: DROP_ADDRESS, abi: dropAbi, functionName });

  const [price, soldBefore] = await Promise.all([read("currentPrice"), read("sold")]);
  const hash = await wallet.writeContract({
    address: DROP_ADDRESS,
    abi: dropAbi,
    functionName: "buy",
    args: [voucher, signature],
    value: price,
  });
  assert.equal((await fork.waitForTransactionReceipt({ hash })).status, "success");
  assert.equal(await read("sold"), soldBefore + 1n);
  assert.equal(
    await fork.readContract({ address: DROP_ADDRESS, abi: dropAbi, functionName: "nullifierUsed", args: [nullifier] }),
    true,
  );

  // Same human, fresh voucher: the contract itself refuses (SPEC §9 demo step 4).
  const again = await signVoucher(account.address, nullifier);
  const err = await fork
    .simulateContract({
      account,
      address: DROP_ADDRESS,
      abi: dropAbi,
      functionName: "buy",
      args: [again.voucher, again.signature],
      value: await read("currentPrice"),
    })
    .then(() => null, (e: unknown) => e);
  const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  assert.ok(revert instanceof ContractFunctionRevertedError, `expected a revert, got ${String(err)}`);
  assert.equal(revert.data?.errorName, "AlreadyPurchased");
});
