"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import { BaseError, ContractFunctionRevertedError, formatEther, type Address, type Hex } from "viem";
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
import { AUCTION_ADDRESS, AUCTION_DEPLOY_BLOCK, UNIVERSAL_ROUTER, auctionAbi } from "@/lib/auction";
import { bidCall, commitmentOf, randomSecret, universalRouterAbi } from "@/lib/bid";

// Same demo scale as the curve drop: the reserve (定価) reads as ¥3,000.
const YEN_FOR_RESERVE = 3000;

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID as `app_${string}`;
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION as string;
const ENVIRONMENT = process.env.NEXT_PUBLIC_WORLD_ENVIRONMENT as "production" | "staging";
const TEST_BUYS = process.env.NEXT_PUBLIC_TEST_BUYS === "true";

const auction = { address: AUCTION_ADDRESS, abi: auctionAbi } as const;
const PHASES = ["Bidding", "Reveal", "Settled"] as const;
const OUTCOME = { none: 0, fan: 1, auction: 2 } as const;

type Signed = {
  voucher: { dropId: Hex; buyer: Hex; nullifierHash: string; deadline: string };
  signature: Hex;
};
type Notice = { tone: "good" | "bad" | "info"; text: string } | null;
type Row = { bidder: Address; deposit: bigint; amount: bigint; revealed: boolean; claimed: boolean; outcome: number };

const REJECTIONS: Record<string, string> = {
  already_purchased: "Already bid — one bid per person. This World ID has already bid in this auction.",
  max_verifications_reached: "Already bid — one bid per person. This World ID has already been used here.",
  nullifier_replayed: "That verification was already used. Please verify again.",
  signal_mismatch: "That verification was made for a different wallet. Verify again with this wallet connected.",
  wrong_credential: "This drop needs an Orb-verified World ID.",
  rp_signature_expired: "The verification request expired. Please try again.",
  environment_not_allowed: "World ID test verification is closed for this app right now. The site owner needs to reopen it.",
};

const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toPrecision(3)} ETH`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The secret that opens a sealed bid lives only in this browser (SPEC §8.2: lose it, lose the bid).
const savedKey = (who: string) => `fair-drop:bid:${AUCTION_ADDRESS}:${who.toLowerCase()}`;
function loadSaved(who: string): { amount: string; secret: Hex } | null {
  try {
    return JSON.parse(localStorage.getItem(savedKey(who)) ?? "null");
  } catch {
    return null;
  }
}

function txMessage(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      switch (revert.data?.errorName) {
        case "BadReveal":
          return "That bid doesn't match your sealed commitment.";
        case "RevealTooShort":
          return "The reveal window is still open. Wait for the countdown.";
        case "WrongPhase":
          return "The auction has moved to a different phase. Refreshing.";
        default:
          return `Transaction failed: ${revert.data?.errorName ?? revert.shortMessage}`;
      }
    }
    if (/reject|denied|cancel/i.test(e.shortMessage)) return "Cancelled in your wallet.";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export default function AuctionPage() {
  const { address: selected, addresses, chainId, isConnected, connector } = useConnection();
  // Demo convenience: with several accounts connected, pick which one acts. Every write passes it
  // as `account`, so the wallet signs as that account without switching in the extension.
  const [picked, setPicked] = useState<Address | null>(null);
  const address = picked && addresses?.some((a) => a.toLowerCase() === picked.toLowerCase()) ? picked : selected;
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const write = useWriteContract();
  const client = usePublicClient({ chainId: sepolia.id });

  const { data, refetch } = useReadContracts({
    contracts: [
      { ...auction, functionName: "maker" },
      { ...auction, functionName: "phase" },
      { ...auction, functionName: "supply" },
      { ...auction, functionName: "fanUnits" },
      { ...auction, functionName: "reservePrice" },
      { ...auction, functionName: "minRevealTime" },
      { ...auction, functionName: "revealStart" },
      { ...auction, functionName: "clearingPrice" },
      { ...auction, functionName: "fanWinners" },
      { ...auction, functionName: "auctionWinners" },
      { ...auction, functionName: "biddersCount" },
      { ...auction, functionName: "makerFunds" },
    ],
    allowFailure: false,
    query: { refetchInterval: 4000 },
  });
  const count = data?.[10];
  const phaseN = data?.[1];

  // Every bid, re-read whenever the bid count or phase moves (and on the 4s poll).
  const { data: rows = [], refetch: refetchRows } = useQuery({
    queryKey: ["bids", count?.toString(), phaseN],
    enabled: !!client && count !== undefined,
    refetchInterval: 4000,
    queryFn: async (): Promise<Row[]> => {
      const bidders = await client!.multicall({
        contracts: Array.from({ length: Number(count) }, (_, i) => ({ ...auction, functionName: "bidders", args: [BigInt(i)] }) as const),
        allowFailure: false,
      });
      const bids = await client!.multicall({
        contracts: bidders.map((b) => ({ ...auction, functionName: "bids", args: [b] }) as const),
        allowFailure: false,
      });
      return bids.map(([, deposit, amount, revealed, claimed, outcome], i) => ({
        bidder: bidders[i],
        deposit,
        amount,
        revealed,
        claimed,
        outcome,
      }));
    },
  });

  // Units this wallet holds (the ERC721 isn't enumerable): everything ever sent here, still owned.
  const { data: owned = [], refetch: refetchOwned } = useQuery({
    queryKey: ["auction-owned", address, rows.filter((r) => r.claimed).length],
    enabled: !!client && !!address && phaseN === 2,
    queryFn: async () => {
      const logs = await client!.getContractEvents({ ...auction, eventName: "Transfer", args: { to: address }, fromBlock: AUCTION_DEPLOY_BLOCK });
      const ids = [...new Set(logs.map((l) => l.args.tokenId!))];
      const units = await Promise.all(
        ids.map(async (id) => {
          const owner = await client!.readContract({ ...auction, functionName: "ownerOf", args: [id] }).catch(() => null);
          if (owner?.toLowerCase() !== address!.toLowerCase()) return null;
          return { id, paid: await client!.readContract({ ...auction, functionName: "paidFor", args: [id] }) };
        }),
      );
      return units.filter((u) => u !== null);
    },
  });

  const { data: saved, refetch: refetchSaved } = useQuery({
    queryKey: ["saved-bid", address],
    enabled: !!address,
    queryFn: () => loadSaved(address!),
  });

  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const signedRef = useRef<Signed | null>(null);
  const [pending, setPending] = useState<Signed | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [worldIdOn, setWorldIdOn] = useState(true);
  const [bidYen, setBidYen] = useState("");
  const [depositYen, setDepositYen] = useState("");
  const testMode = TEST_BUYS && !worldIdOn;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!data) {
    return <main className="mx-auto max-w-5xl p-8 text-sm" style={{ color: "var(--muted)" }}>Loading the auction…</main>;
  }

  const [maker, , supply, fanUnits, reserve, minReveal, revealStart, clearing, fanWinners, auctionWinners, , makerFunds] = data;
  const phase = PHASES[phaseN!];
  const toYen = (wei: bigint) => (Number(wei) * YEN_FOR_RESERVE) / Number(reserve);
  const fromYen = (y: number) => (BigInt(Math.round(y)) * reserve) / BigInt(YEN_FOR_RESERVE);
  const isMaker = !!address && address.toLowerCase() === maker.toLowerCase();
  const wrongChain = isConnected && chainId !== sepolia.id;
  const mine = rows.find((r) => address && r.bidder.toLowerCase() === address.toLowerCase());
  const settleAt = Number(revealStart + minReveal) * 1000;
  const settleIn = Math.max(0, Math.ceil((settleAt - now) / 1000));

  // Deposit defaults to the next ¥10,000 step strictly above the bid, so it never equals the bid.
  const bidNum = Number(bidYen);
  const autoDeposit = bidNum > 0 ? (Math.floor(bidNum / 10_000) + 1) * 10_000 : 0;
  const depositNum = depositYen === "" ? autoDeposit : Number(depositYen);
  const bidValid = bidNum >= YEN_FOR_RESERVE && depositNum >= bidNum;

  async function send(label: string, run: () => Promise<Hex>): Promise<boolean> {
    setBusy(label);
    try {
      const hash = await run();
      setBusy("Waiting for the block…");
      const receipt = await client!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted.");
      await Promise.all([refetch(), refetchRows(), refetchOwned()]);
      return true;
    } catch (e) {
      setNotice({ tone: "bad", text: txMessage(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function testBid() {
    setNotice(null);
    setBusy("Getting a test voucher…");
    try {
      const res = await fetch("/api/test-voucher", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyer: address, drop: "auction" }),
      });
      if (!res.ok) throw new Error("Test mode is not enabled on the server.");
      signedRef.current = await res.json();
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof Error ? e.message : String(e) });
      setBusy(null);
      return;
    }
    await placeBid();
  }

  async function startVerify() {
    setNotice(null);
    setBusy("Preparing verification…");
    try {
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

  async function handleVerify(result: IDKitResult) {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyer: address, result, drop: "auction" }),
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

  async function placeBid() {
    const signed = signedRef.current;
    if (!signed || !address) return;
    const amount = fromYen(bidNum);
    const deposit = fromYen(depositNum);
    // Saved before sending: if the bid lands, the secret to open it must already be here.
    const secret = randomSecret();
    try {
      localStorage.setItem(savedKey(address), JSON.stringify({ amount: amount.toString(), secret }));
    } catch {
      setNotice({ tone: "bad", text: "This browser won't store your bid's secret, so it could never be revealed. Try another browser." });
      return;
    }
    const v = signed.voucher;
    const call = bidCall(
      { dropId: v.dropId, buyer: v.buyer, nullifierHash: BigInt(v.nullifierHash), deadline: BigInt(v.deadline) },
      signed.signature,
      commitmentOf(amount, secret, address),
      deposit,
    );
    const ok = await send("Confirm the sealed bid in your wallet…", () =>
      write.mutateAsync({ address: UNIVERSAL_ROUTER, abi: universalRouterAbi, functionName: "execute", chainId: sepolia.id, account: address, ...call }),
    );
    await refetchSaved();
    if (ok) {
      signedRef.current = null;
      setPending(null);
      setNotice({ tone: "good", text: `Sealed bid placed with a ${yen(depositNum)} deposit. Nobody can see your ${yen(bidNum)} until you reveal it.` });
    }
  }

  async function reveal() {
    const s = loadSaved(address!);
    if (!s) return;
    if (await send("Confirm the reveal in your wallet…", () =>
      write.mutateAsync({ ...auction, functionName: "reveal", chainId: sepolia.id, account: address, args: [BigInt(s.amount), s.secret] }))) {
      setNotice({ tone: "good", text: `Revealed your bid of ${yen(toYen(BigInt(s.amount)))}.` });
    }
  }

  async function claim() {
    if (await send("Confirm in your wallet…", () => write.mutateAsync({ ...auction, functionName: "claim", chainId: sepolia.id, account: address }))) {
      setNotice({ tone: "good", text: mine?.outcome ? "Claimed: your unit is below, and the rest of your deposit is back in your wallet." : "Your deposit is back in your wallet." });
    }
  }

  // Asks the wallet to connect more of its accounts to the site; they then appear in the picker.
  async function addWallet() {
    const provider = (await connector?.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> } | undefined;
    await provider?.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
  }

  function pickWallet(a: Address) {
    // A voucher and a half-filled bid belong to the previous wallet.
    signedRef.current = null;
    setPending(null);
    setNotice(null);
    setBidYen("");
    setDepositYen("");
    setPicked(a);
  }

  const makerCall = (functionName: "closeBidding" | "settle" | "withdraw", label: string) =>
    void send(label, () => write.mutateAsync({ ...auction, functionName, chainId: sepolia.id, account: address }));

  const card = "rounded-2xl p-6";
  const cardStyle = { background: "var(--surface-1)", border: "1px solid var(--border)" };
  const primaryBtn =
    "w-full rounded-xl px-5 py-3 text-base font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50";
  const secondaryBtn = "rounded-xl px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
  const muted = { color: "var(--text-secondary)" };

  let action: React.ReactNode;
  if (!isConnected)
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
  else if (phase === "Bidding" && mine)
    action = <p style={muted}>Your sealed bid is in, with a {yen(toYen(mine.deposit))} deposit. Come back to reveal it when bidding closes.</p>;
  else if (phase === "Bidding")
    action = (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm" style={muted}>
            Your bid (¥)
            <input type="number" inputMode="numeric" min={YEN_FOR_RESERVE} step={500} value={bidYen} placeholder={`≥ ${YEN_FOR_RESERVE}`}
              onChange={(e) => setBidYen(e.target.value)}
              className="mt-1 w-full rounded-lg px-3 py-2 text-base" style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "var(--page)" }} />
          </label>
          <label className="text-sm" style={muted}>
            Deposit (¥)
            <input type="number" inputMode="numeric" min={bidNum || 0} step={1000} value={depositYen} placeholder={autoDeposit ? String(autoDeposit) : ""}
              onChange={(e) => setDepositYen(e.target.value)}
              className="mt-1 w-full rounded-lg px-3 py-2 text-base" style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "var(--page)" }} />
          </label>
        </div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          The deposit is public and at least your bid, so it hides the bid. If you win you pay the clearing price, not your bid, and get the rest back.
        </p>
        {pending ? (
          <button className={primaryBtn} style={{ background: "var(--series-1)" }} disabled={!!busy || !bidValid} onClick={() => void placeBid()}>
            {busy ?? `Verified — place sealed bid (${yen(depositNum)} deposit)`}
          </button>
        ) : (
          <button className={primaryBtn} style={{ background: testMode ? "var(--bad)" : "var(--series-1)" }} disabled={!!busy || !bidValid}
            onClick={() => void (testMode ? testBid() : startVerify())}>
            {busy ?? (testMode ? "Test bid (no World ID)" : "Verify with World ID & place sealed bid")}
          </button>
        )}
      </div>
    );
  else if (phase === "Reveal" && mine && !mine.revealed)
    action = saved ? (
      <button className={primaryBtn} style={{ background: "var(--series-1)" }} disabled={!!busy} onClick={() => void reveal()}>
        {busy ?? `Reveal my bid of ${yen(toYen(BigInt(saved.amount)))}`}
      </button>
    ) : (
      <p style={{ color: "var(--bad)" }}>This browser doesn&apos;t have the secret for your bid, so it can&apos;t be revealed. Open the page in the browser you bid from.</p>
    );
  else if (phase === "Reveal")
    action = <p style={muted}>{mine ? "Revealed. " : ""}Results after the reveal window{settleIn > 0 ? ` — at least ${settleIn}s more` : ""}, when the maker settles.</p>;
  else if (mine && mine.revealed && !mine.claimed) {
    const price = mine.outcome === OUTCOME.fan ? reserve : mine.outcome === OUTCOME.auction ? clearing : 0n;
    action = (
      <button className={primaryBtn} style={{ background: "var(--series-1)" }} disabled={!!busy} onClick={() => void claim()}>
        {busy ?? (mine.outcome ? `You won! Claim your unit + ${yen(toYen(mine.deposit - price))} back` : `Not this time — claim your ${yen(toYen(mine.deposit))} back`)}
      </button>
    );
  } else if (mine && !mine.revealed) action = <p style={{ color: "var(--bad)" }}>Your bid wasn&apos;t revealed in time, so its deposit was forfeited.</p>;
  else action = <p style={muted}>The auction has settled.</p>;

  const badge =
    phase === "Bidding" ? `Sealed bidding open — ${rows.length} bid${rows.length === 1 ? "" : "s"}` :
    phase === "Reveal" ? `Revealing — ${rows.filter((r) => r.revealed).length} of ${rows.length} open` :
    `Settled — ${yen(toYen(auctionWinners > 0n ? clearing : reserve))} per unit`;

  // Bids, highest first once revealed. Sealed bids show only their deposit.
  const sorted = [...rows].sort((a, b) => (a.revealed === b.revealed ? Number(b.amount - a.amount) : a.revealed ? -1 : 1));
  const top = Math.max(...rows.map((r) => toYen(r.revealed ? r.amount : 0n)), toYen(clearing), YEN_FOR_RESERVE) * 1.1;
  const pct = (y: number) => `${(y / top) * 100}%`;
  const gap = auctionWinners * (clearing - reserve);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="text-lg font-semibold tracking-tight">Fair Drop</div>
          <nav className="flex gap-1 text-sm">
            <span className="rounded-full px-3 py-1 font-medium" style={{ background: "color-mix(in srgb, var(--series-1) 12%, transparent)", color: "var(--series-1)" }}>Auction</span>
            <Link href="/" className="rounded-full px-3 py-1" style={muted}>Curve drop</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {TEST_BUYS && (
            <label className="flex cursor-pointer items-center gap-2 text-sm" style={muted}>
              World ID
              <button role="switch" aria-checked={worldIdOn} onClick={() => setWorldIdOn((v) => !v)}
                className="relative h-6 w-11 rounded-full transition"
                style={{ background: worldIdOn ? "var(--good)" : "var(--bad)" }}>
                <span className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all" style={{ left: worldIdOn ? "1.375rem" : "0.125rem" }} />
              </button>
              <span className="w-6 font-medium">{worldIdOn ? "On" : "Off"}</span>
            </label>
          )}
          {isConnected && address && (
            <div className="flex items-center gap-2 text-sm">
              <select aria-label="Acting wallet" value={address} onChange={(e) => pickWallet(e.target.value as Address)}
                className="rounded-full px-3 py-1.5" style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "var(--surface-1)" }}>
                {(addresses ?? [address]).map((a) => (
                  <option key={a} value={a}>{short(a)}{a.toLowerCase() === maker.toLowerCase() ? " · maker" : ""}</option>
                ))}
              </select>
              <button className="rounded-full px-3 py-1.5" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                onClick={() => void addWallet()} title="Connect more accounts from your wallet">
                + Wallet
              </button>
              <button className="rounded-full px-3 py-1.5" style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                onClick={() => disconnect.mutate({})}>
                Disconnect
              </button>
            </div>
          )}
        </div>
      </header>

      {testMode && (
        <div role="alert" className="mb-6 rounded-xl px-4 py-3 text-sm font-medium"
          style={{ color: "var(--bad)", background: "color-mix(in srgb, var(--bad) 12%, transparent)" }}>
          Test mode: World ID verification is OFF. Each bid uses a random made-up identity. Use a different wallet per bid.
          Not the real flow — switch World ID back on for demos.
        </div>
      )}

      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className={card} style={cardStyle}>
          <div className="mb-5 flex aspect-[4/3] items-center justify-center rounded-xl text-6xl"
            style={{ background: "linear-gradient(135deg, #fde2e4 0%, #e2ecfd 100%)" }} aria-hidden>
            🎏
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Fair Drop — sealed-bid edition</h1>
          <p className="mt-1 text-sm" style={muted}>
            {supply.toString()} units · {fanUnits.toString()} raffled to fans at 定価 {yen(YEN_FOR_RESERVE)} · the rest to the highest bids, all at one price · one bid per person, verified with World ID
          </p>
          <div className="mt-4 inline-flex rounded-full px-3 py-1 text-sm font-medium"
            style={{ background: "color-mix(in srgb, var(--series-1) 12%, transparent)", color: "var(--series-1)" }}>
            {badge}
          </div>

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
          <h2 className="text-base font-semibold">Bids</h2>
          <p className="mb-4 text-sm" style={muted}>
            {phase === "Bidding"
              ? "Sealed: only deposits are visible until bidding closes. Bidding your true value is the best strategy — winners pay the highest losing bid, not their own."
              : phase === "Reveal"
                ? "Bids open as bidders reveal them."
                : "Fan units were raffled at 定価 first. Every other winner pays the same price: the highest losing bid."}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>No bids yet.</p>
          ) : (
            <div className="relative" style={{ fontVariantNumeric: "tabular-nums" }}>
              <ul className="space-y-2">
                {sorted.map((r) => {
                  const you = address && r.bidder.toLowerCase() === address.toLowerCase();
                  const tag =
                    phase !== "Settled" ? (r.revealed ? "" : "sealed") :
                    !r.revealed ? "forfeited" :
                    r.outcome === OUTCOME.fan ? "fan raffle · 定価" :
                    r.outcome === OUTCOME.auction ? "won" :
                    r.amount < reserve ? "below 定価" : "lost";
                  const color =
                    r.outcome === OUTCOME.fan ? "var(--good)" : r.outcome === OUTCOME.auction ? "var(--series-1)" : "var(--muted)";
                  return (
                    <li key={r.bidder} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 text-sm">
                      <span className="truncate" style={{ fontWeight: you ? 600 : 400 }}>{you ? "You" : short(r.bidder)}</span>
                      <div className="relative h-7">
                        {r.revealed ? (
                          <div className="absolute inset-y-0 left-0 z-0 rounded" style={{ width: pct(toYen(r.amount)), background: color, opacity: phase === "Settled" && !r.outcome ? 0.35 : 0.9 }} />
                        ) : (
                          <div className="absolute inset-y-0 left-0 z-0 rounded" style={{ width: "100%", background: "repeating-linear-gradient(45deg, var(--grid) 0 6px, transparent 6px 12px)" }} />
                        )}
                        <span className="absolute inset-y-0 left-2 z-[2] flex items-center text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                          {r.revealed ? yen(toYen(r.amount)) : `🔒 deposit ${yen(toYen(r.deposit))}`}
                          {tag && <span className="ml-2" style={{ color: "var(--text-secondary)" }}>{tag}</span>}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {phase !== "Bidding" && (
                <div className="pointer-events-none absolute inset-y-0 right-0 z-[1]" style={{ left: "calc(6.5rem + 0.75rem)" }}>
                  <div className="absolute inset-y-0 border-l border-dashed" style={{ left: pct(YEN_FOR_RESERVE), borderColor: "var(--good)" }} />
                  {phase === "Settled" && auctionWinners > 0n && (
                    <div className="absolute inset-y-0 border-l-2" style={{ left: pct(toYen(clearing)), borderColor: "var(--series-1)" }} />
                  )}
                </div>
              )}
            </div>
          )}
          {phase !== "Bidding" && (
            <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
              Dashed line: 定価 {yen(YEN_FOR_RESERVE)}.{phase === "Settled" && auctionWinners > 0n ? ` Solid line: clearing price ${yen(toYen(clearing))}.` : ""}
            </p>
          )}
          {phase === "Settled" && (
            <dl className="mt-5 grid grid-cols-3 gap-4 border-t pt-4" style={{ borderColor: "var(--border)", fontVariantNumeric: "tabular-nums" }}>
              <div>
                <dt className="text-xs" style={{ color: "var(--muted)" }}>Fan units at 定価</dt>
                <dd className="text-xl font-semibold">{fanWinners.toString()} × {yen(YEN_FOR_RESERVE)}</dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: "var(--muted)" }}>Auction units</dt>
                <dd className="text-xl font-semibold">{auctionWinners.toString()} × {yen(toYen(auctionWinners > 0n ? clearing : reserve))}</dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: "var(--muted)" }}>Above 定価, to the maker</dt>
                <dd className="text-xl font-semibold" style={{ color: "var(--good)" }}>{yen(toYen(gap))}</dd>
                <dd className="text-xs" style={{ color: "var(--muted)" }}>the gap scalpers used to take</dd>
              </div>
            </dl>
          )}
          <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>Yen at demo scale: {eth(reserve)} is shown as {yen(YEN_FOR_RESERVE)}.</p>
        </section>
      </div>

      {isConnected && owned.length > 0 && (
        <section className={`${card} mt-6`} style={cardStyle}>
          <h2 className="text-base font-semibold">My units</h2>
          <ul className="mt-3 divide-y" style={{ borderColor: "var(--border)" }}>
            {owned.map(({ id, paid }) => (
              <li key={id.toString()} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium">Unit #{id.toString()}</div>
                  <div className="text-sm" style={{ ...muted, fontVariantNumeric: "tabular-nums" }}>
                    Paid {yen(toYen(paid))}. Redeem it with the maker for the physical item.
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isMaker && (
        <section className={`${card} mt-6`} style={{ ...cardStyle, borderStyle: "dashed" }}>
          <h2 className="text-base font-semibold">Maker console</h2>
          <p className="mt-1 text-sm" style={muted}>
            You control the pace. Closing early gives you no edge: bids are sealed.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {phase === "Bidding" && (
              <button className={secondaryBtn} style={{ border: "1px solid var(--border)" }} disabled={!!busy || rows.length === 0}
                onClick={() => makerCall("closeBidding", "Closing bidding…")}>
                Close bidding ({rows.length} bid{rows.length === 1 ? "" : "s"})
              </button>
            )}
            {phase === "Reveal" && (
              <button className={secondaryBtn} style={{ border: "1px solid var(--border)" }} disabled={!!busy || settleIn > 0}
                onClick={() => makerCall("settle", "Settling…")}>
                {settleIn > 0 ? `Settle — reveal window open for ${settleIn}s` : "Settle: raffle fan units, clear the auction"}
              </button>
            )}
            {phase === "Settled" && (
              <button className={secondaryBtn} style={{ border: "1px solid var(--border)" }} disabled={!!busy || makerFunds === 0n}
                onClick={() => makerCall("withdraw", "Withdrawing…")}>
                Withdraw {yen(toYen(makerFunds))}
              </button>
            )}
          </div>
        </section>
      )}

      {rpContext && address && (
        <IDKitRequestWidget
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
          onSuccess={() => void placeBid()}
          onError={(code) =>
            setNotice((n) => n ?? { tone: "bad", text: `Verification was cancelled or failed (World ID code: ${String(code)}).` })
          }
        />
      )}
    </main>
  );
}
