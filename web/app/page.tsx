"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import { BaseError, ContractFunctionRevertedError, formatEther, type Hex } from "viem";
import {
  useConnect,
  useConnection,
  useConnectors,
  useDisconnect,
  usePublicClient,
  useReadContracts,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { sepolia } from "wagmi/chains";
import { DROP_ADDRESS, DROP_DEPLOY_BLOCK, dropAbi } from "@/lib/drop";
import { PriceChart } from "./price-chart";

// Sepolia prices are tiny, so yen is shown at a fixed demo scale where the base price reads as
// ¥3,000 — the worked example in SPEC §6.4. Labelled as such on the page.
const YEN_FOR_BASE_PRICE = 3000;

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION as string;
const ENVIRONMENT = process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT as "production" | "staging";
// The server decides whether test mode exists at all (never in production); see api/test-voucher.
const TEST_BUYS = process.env.NEXT_PUBLIC_TEST_BUYS === "true";

const drop = { address: DROP_ADDRESS, abi: dropAbi } as const;

type Signed = {
  voucher: { dropId: Hex; buyer: Hex; nullifierHash: string; deadline: string };
  signature: Hex;
};
type Notice = { tone: "good" | "bad" | "info"; text: string } | null;

// Backend and World error codes → what a buyer should read. SPEC §6.3's rejection states.
const REJECTIONS: Record<string, string> = {
  already_purchased: "Already purchased — one per person. This World ID has already bought from this drop.",
  max_verifications_reached: "Already purchased — one per person. This World ID has already been used for this drop.",
  nullifier_replayed: "That verification was already used. Please verify again.",
  signal_mismatch: "That verification was made for a different wallet. Verify again with this wallet connected.",
  wrong_credential: "This drop needs an Orb-verified World ID.",
  rp_signature_expired: "The verification request expired. Please try again.",
};

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toPrecision(3)} ETH`;

function txMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      switch (revert.data?.errorName) {
        case "AlreadyPurchased":
          return REJECTIONS.already_purchased;
        case "Underpaid":
          return "The price moved while you were confirming. Please try again.";
        case "VoucherExpired":
          return "Your verification expired. Please verify again.";
        case "SoldOut":
          return "Sold out.";
        case "SaleClosed":
          return "The sale has closed.";
        default:
          return `Transaction failed: ${revert.data?.errorName ?? revert.shortMessage}`;
      }
    }
    if (/reject|denied|cancel/i.test(e.shortMessage)) return "Cancelled in your wallet.";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export default function DropPage() {
  const { address, chainId, isConnected } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const write = useWriteContract();
  const client = usePublicClient({ chainId: sepolia.id });

  const { data, refetch } = useReadContracts({
    contracts: [
      { ...drop, functionName: "name" },
      { ...drop, functionName: "sold" },
      { ...drop, functionName: "supply" },
      { ...drop, functionName: "flatUnits" },
      { ...drop, functionName: "basePrice" },
      { ...drop, functionName: "currentPrice" },
      { ...drop, functionName: "currentSellBackPrice" },
      { ...drop, functionName: "saleEnd" },
      { ...drop, functionName: "curve" },
    ],
    allowFailure: false,
    query: { refetchInterval: 4000 },
  });

  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  // A verified-but-unbought voucher is kept, so a cancelled wallet popup can be retried without
  // verifying again — with max_verifications at 1, re-verifying may not be possible.
  const signedRef = useRef<Signed | null>(null);
  const [pending, setPending] = useState<Signed | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [worldIdOn, setWorldIdOn] = useState(true);
  const testMode = TEST_BUYS && !worldIdOn;
  // Ticks so "sale open" flips to "redeem" on its own when saleEnd passes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const sold = data?.[1];
  // ERC721 here isn't enumerable: find what was ever sent to this wallet, keep what it still owns.
  // Keyed on `sold`, so it refreshes whenever anyone buys or sells back.
  const { data: owned = [], refetch: refetchOwned } = useQuery({
    queryKey: ["owned", address, sold?.toString()],
    enabled: !!client && !!address,
    queryFn: async () => {
      const logs = await client!.getContractEvents({
        ...drop,
        eventName: "Transfer",
        args: { to: address },
        fromBlock: DROP_DEPLOY_BLOCK,
      });
      const ids = [...new Set(logs.map((l) => l.args.tokenId!))];
      const owners = await Promise.all(
        ids.map((id) => client!.readContract({ ...drop, functionName: "ownerOf", args: [id] }).catch(() => null)),
      );
      return ids.filter((_, i) => owners[i]?.toLowerCase() === address!.toLowerCase()).sort((a, b) => Number(a - b));
    },
  });

  if (!data) {
    return <main className="mx-auto max-w-5xl p-8 text-sm" style={{ color: "var(--muted)" }}>Loading the drop…</main>;
  }

  const [name, , supply, flatUnits, basePrice, currentPrice, sellBackPrice, saleEnd, curve] = data;
  const toYen = (wei: bigint) => (Number(wei) * YEN_FOR_BASE_PRICE) / Number(basePrice);
  const soldN = Number(sold);
  const flatLeft = Number(flatUnits) - soldN;
  const saleOpen = now / 1000 < Number(saleEnd);
  const soldOut = soldN >= Number(supply);
  const wrongChain = isConnected && chainId !== sepolia.id;

  async function send(label: string, run: () => Promise<Hex>): Promise<boolean> {
    setBusy(label);
    try {
      const hash = await run();
      setBusy("Waiting for the block…");
      const receipt = await client!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted.");
      await Promise.all([refetch(), refetchOwned()]);
      return true;
    } catch (e) {
      setNotice({ tone: "bad", text: txMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Test mode: skip World ID, get a voucher under a random nullifier, buy straight away.
  async function testBuy() {
    setNotice(null);
    setBusy("Getting a test voucher…");
    try {
      const res = await fetch("/api/test-voucher", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyer: address }),
      });
      if (!res.ok) throw new Error("Test mode is not enabled on the server.");
      signedRef.current = await res.json();
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
      setBusy(null);
      return;
    }
    await buy();
  }

  async function startVerify() {
    setNotice(null);
    setBusy("Preparing verification…");
    try {
      // A fresh signed request per attempt: each nonce is single-use.
      const res = await fetch("/api/rp-context", { method: "POST" });
      if (!res.ok) throw new Error("Could not start World ID verification.");
      setRpContext(await res.json());
      setWidgetOpen(true);
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  // Runs inside the widget. On a refusal, close the widget ourselves: left open, it replaces our
  // specific message ("Already purchased — one per person") with a generic "contact the website
  // owner", and that refusal is the demo's key moment.
  async function handleVerify(result: IDKitResult) {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyer: address, result }),
    });
    const body = await res.json();
    if (!res.ok) {
      setNotice({ tone: "bad", text: REJECTIONS[body.code] ?? `Verification failed: ${body.message}` });
      setWidgetOpen(false);
      throw new Error(body.code);
    }
    signedRef.current = body;
    setPending(body);
  }

  async function buy() {
    const signed = signedRef.current;
    if (!signed || !client) return;
    const price = await client.readContract({ ...drop, functionName: "currentPrice" });
    const ok = await send("Confirm the purchase in your wallet…", () =>
      write.mutateAsync({
        ...drop,
        functionName: "buy",
        chainId: sepolia.id,
        value: price,
        args: [
          {
            dropId: signed.voucher.dropId,
            buyer: signed.voucher.buyer,
            nullifierHash: BigInt(signed.voucher.nullifierHash),
            deadline: BigInt(signed.voucher.deadline),
          },
          signed.signature,
        ],
      }),
    );
    if (ok) {
      signedRef.current = null;
      setPending(null);
      setNotice({ tone: "good", text: `Bought for ${yen(toYen(price))}. It's in My units below.` });
    }
  }

  async function sellBack(id: bigint) {
    const payout = sellBackPrice;
    if (await send("Confirm the sell-back in your wallet…", () =>
      write.mutateAsync({ ...drop, functionName: "sellBack", chainId: sepolia.id, args: [id] }))) {
      setNotice({ tone: "good", text: `Sold back unit #${id} for ${yen(toYen(payout))}. The price just dropped for the next buyer.` });
    }
  }

  async function redeem(id: bigint) {
    if (await send("Confirm the redemption in your wallet…", () =>
      write.mutateAsync({ ...drop, functionName: "redeem", chainId: sepolia.id, args: [id] }))) {
      setNotice({ tone: "good", text: `Unit #${id} redeemed. The maker will ship your item.` });
    }
  }

  const card = "rounded-2xl p-6";
  const cardStyle = { background: "var(--surface-1)", border: "1px solid var(--border)" };
  const primaryBtn =
    "w-full rounded-xl px-5 py-3 text-base font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50";

  let action: React.ReactNode;
  if (!saleOpen) action = <p style={{ color: "var(--text-secondary)" }}>The sale has closed. Holders can redeem below.</p>;
  else if (soldOut) action = <p style={{ color: "var(--text-secondary)" }}>Sold out.</p>;
  else if (!isConnected)
    action = (
      <button className={primaryBtn} style={{ background: "var(--series-1)" }} disabled={!connectors[0] || connect.isPending}
        onClick={() => connect.mutate({ connector: connectors[0] })}>
        Connect wallet
      </button>
    );
  else if (wrongChain)
    action = (
      <button className={primaryBtn} style={{ background: "var(--series-1)" }} onClick={() => switchChain.mutate({ chainId: sepolia.id })}>
        Switch to Sepolia
      </button>
    );
  else if (pending)
    action = (
      <button className={primaryBtn} style={{ background: "var(--series-1)" }} disabled={!!busy} onClick={() => void buy()}>
        {busy ?? `Verified — complete purchase for ${yen(toYen(currentPrice))}`}
      </button>
    );
  else
    action = (
      <button className={primaryBtn} style={{ background: testMode ? "var(--bad)" : "var(--series-1)" }} disabled={!!busy}
        onClick={() => void (testMode ? testBuy() : startVerify())}>
        {busy ?? (testMode ? `Test buy (no World ID) for ${yen(toYen(currentPrice))}` : `Verify with World ID & buy for ${yen(toYen(currentPrice))}`)}
      </button>
    );

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div className="text-lg font-semibold tracking-tight">Fair Drop</div>
        <div className="flex items-center gap-3">
        {TEST_BUYS && (
          <label className="flex cursor-pointer items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            World ID
            <button role="switch" aria-checked={worldIdOn} onClick={() => setWorldIdOn((v) => !v)}
              className="relative h-6 w-11 rounded-full transition"
              style={{ background: worldIdOn ? "var(--good)" : "var(--bad)" }}>
              <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                style={{ left: worldIdOn ? "1.375rem" : "0.125rem" }} />
            </button>
            <span className="w-6 font-medium">{worldIdOn ? "On" : "Off"}</span>
          </label>
        )}
        {isConnected && address && (
          <button className="rounded-full px-3 py-1.5 text-sm" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            onClick={() => disconnect.mutate({})}>
            {address.slice(0, 6)}…{address.slice(-4)} · Disconnect
          </button>
        )}
        </div>
      </header>

      {testMode && (
        <div role="alert" className="mb-6 rounded-xl px-4 py-3 text-sm font-medium"
          style={{ color: "var(--bad)", background: "color-mix(in srgb, var(--bad) 12%, transparent)" }}>
          Test mode: World ID verification is OFF. Each buy uses a random made-up identity, so one wallet can buy
          many units. Not the real flow — switch World ID back on for demos.
        </div>
      )}

      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className={card} style={cardStyle}>
          <div className="mb-5 flex aspect-[4/3] items-center justify-center rounded-xl text-6xl"
            style={{ background: "linear-gradient(135deg, #fde2e4 0%, #e2ecfd 100%)" }} aria-hidden>
            🎏
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Limited edition of {supply.toString()} · one per person, verified with World ID
          </p>

          <div className="mt-4 inline-flex rounded-full px-3 py-1 text-sm font-medium"
            style={flatLeft > 0
              ? { background: "color-mix(in srgb, var(--good) 12%, transparent)", color: "var(--good)" }
              : { background: "color-mix(in srgb, var(--series-1) 12%, transparent)", color: "var(--series-1)" }}>
            {flatLeft > 0 ? `Fan price — ${flatLeft} of ${flatUnits} left at ${yen(YEN_FOR_BASE_PRICE)}` : "Demand pricing"}
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-4" style={{ fontVariantNumeric: "tabular-nums" }}>
            <div>
              <dt className="text-sm" style={{ color: "var(--muted)" }}>Price now</dt>
              <dd className="text-3xl font-semibold">{soldOut ? "—" : yen(toYen(currentPrice))}</dd>
              <dd className="text-xs" style={{ color: "var(--muted)" }}>{soldOut ? "" : eth(currentPrice)}</dd>
            </div>
            <div>
              <dt className="text-sm" style={{ color: "var(--muted)" }}>Units left</dt>
              <dd className="text-3xl font-semibold">{(supply - sold!).toString()}</dd>
              <dd className="text-xs" style={{ color: "var(--muted)" }}>of {supply.toString()}</dd>
            </div>
          </dl>

          <div className="mt-6">{action}</div>
          {notice && (
            <p role="status" className="mt-4 rounded-xl px-4 py-3 text-sm font-medium"
              style={{
                color: notice.tone === "bad" ? "var(--bad)" : notice.tone === "good" ? "var(--good)" : "var(--text-secondary)",
                background: `color-mix(in srgb, ${notice.tone === "bad" ? "var(--bad)" : notice.tone === "good" ? "var(--good)" : "var(--muted)"} 12%, transparent)`,
              }}>
              {notice.tone === "bad" ? "✕ " : notice.tone === "good" ? "✓ " : ""}{notice.text}
            </p>
          )}
        </section>

        <section className={card} style={cardStyle}>
          <h2 className="text-base font-semibold">Price per unit</h2>
          <p className="mb-3 text-sm" style={{ color: "var(--text-secondary)" }}>
            Early fans pay the normal price. After that, demand sets it — and the markup goes to the maker, not to scalpers.
          </p>
          <PriceChart prices={curve.map(toYen)} sold={soldN} flatUnits={Number(flatUnits)} />
          <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
            Yen at demo scale: {eth(basePrice)} is shown as {yen(YEN_FOR_BASE_PRICE)}.
          </p>
        </section>
      </div>

      {isConnected && (
        <section className={`${card} mt-6`} style={cardStyle}>
          <h2 className="text-base font-semibold">My units</h2>
          {owned.length === 0 ? (
            <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>You don&apos;t hold any units from this drop.</p>
          ) : (
            <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }}>
              {owned.map((id) => (
                <li key={id.toString()} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <div className="font-medium">Unit #{id.toString()}</div>
                    {saleOpen && (
                      <div className="text-sm" style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                        Sell back now for {yen(toYen(sellBackPrice))} — 95% of the current price, paid instantly.
                      </div>
                    )}
                  </div>
                  {saleOpen ? (
                    <button className="rounded-xl px-4 py-2 text-sm font-semibold" disabled={!!busy || wrongChain}
                      style={{ border: "1px solid var(--border)" }} onClick={() => void sellBack(id)}>
                      Sell back for {yen(toYen(sellBackPrice))}
                    </button>
                  ) : (
                    <button className="rounded-xl px-4 py-2 text-sm font-semibold" disabled={!!busy || wrongChain}
                      style={{ border: "1px solid var(--border)" }} onClick={() => void redeem(id)}>
                      Redeem for the physical item
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {rpContext && address && (
        <IDKitRequestWidget
          // A new widget per attempt: each signed request's nonce is single-use, and a reused
          // widget can replay the previous request (World: duplicate_nonce → "Verification unavailable").
          key={rpContext.nonce}
          open={widgetOpen}
          onOpenChange={setWidgetOpen}
          app_id={APP_ID}
          action={ACTION}
          rp_context={rpContext}
          allow_legacy_proofs={false}
          preset={proofOfHuman({ signal: address })}
          environment={ENVIRONMENT}
          handleVerify={handleVerify}
          onSuccess={() => void buy()}
          onError={(code) =>
            setNotice((n) => n ?? { tone: "bad", text: `Verification was cancelled or failed (World ID code: ${String(code)}).` })
          }
        />
      )}
    </main>
  );
}
