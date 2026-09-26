import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { AUCTION_ADDRESS, UNIVERSAL_ROUTER, auctionAbi } from "../lib/auction";
import { bidCall, commitmentOf, randomSecret, universalRouterAbi } from "../lib/bid";
import { signVoucher } from "../lib/voucher";

const live = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
const ANVIL = [`${process.env.HOME}/.foundry/bin/anvil`, "anvil"].find((p) => p === "anvil" || existsSync(p))!;

test("browser commitment matches AuctionDrop.commitmentOf", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const secret = randomSecret();
  const onchain = await live.readContract({
    address: AUCTION_ADDRESS,
    abi: auctionAbi,
    functionName: "commitmentOf",
    args: [123456789n, secret, account.address],
  });
  assert.equal(commitmentOf(123456789n, secret, account.address), onchain);
});

// The web app's exact bid transaction, sent to Sepolia's Universal Router on a local fork.
test("a bid from the web app lands in the auction on a Sepolia fork", async (t) => {
  // Forks the live auction, so it only means something while that auction is taking bids.
  const phase = await live.readContract({ address: AUCTION_ADDRESS, abi: auctionAbi, functionName: "phase" });
  if (phase !== 0) return t.skip("the live auction has closed bidding; redeploy a fresh one to run this");
  const port = 8547;
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

  const account = privateKeyToAccount(generatePrivateKey()); // fresh: see voucher.test.ts
  await fork.request({ method: "anvil_setBalance" as never, params: [account.address, "0xde0b6b3a7640000"] as never });
  const wallet = createWalletClient({ account, chain, transport: http() });

  const amount = 400_000_000_000_000n;
  const deposit = 500_000_000_000_000n;
  const secret = randomSecret();
  const { voucher, signature } = await signVoucher(account.address, BigInt(secret), "auction");
  const call = bidCall(voucher, signature, commitmentOf(amount, secret, account.address), deposit);
  const hash = await wallet.writeContract({
    address: UNIVERSAL_ROUTER,
    abi: universalRouterAbi,
    functionName: "execute",
    ...call,
  });
  assert.equal((await fork.waitForTransactionReceipt({ hash })).status, "success");

  const [commitment, held] = await fork.readContract({
    address: AUCTION_ADDRESS,
    abi: auctionAbi,
    functionName: "bids",
    args: [account.address],
  });
  assert.equal(commitment, commitmentOf(amount, secret, account.address));
  assert.equal(held, deposit, "the whole swap input is the deposit");
});
