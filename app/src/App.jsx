import React, { useEffect, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useLottery, LotteryStatus } from "./useLottery.js";
import lotteryConfig from "./config.json";

const TREASURY_PLACEHOLDER = "3ghWMV6hFm1mPrWXnxPriaVunRvqvjG6xVtw4PquLqWL";

function lamportsToSol(lamports) {
  if (lamports === undefined || lamports === null) return "0";
  const n = typeof lamports === "object" && lamports.toNumber ? lamports.toNumber() : Number(lamports);
  return (n / 1_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function useCountdown(endTimeSeconds) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!endTimeSeconds) return null;
  const end = Number(endTimeSeconds) * 1000;
  const diff = Math.max(0, end - now);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return { diff, label: `${h}h ${m}m ${s}s` };
}

function StatusBadge({ status }) {
  const labels = {
    [LotteryStatus.Open]: "Open",
    [LotteryStatus.RandomnessRequested]: "Drawing…",
    [LotteryStatus.Completed]: "Complete",
    [LotteryStatus.Cancelled]: "Cancelled",
  };
  return <span className={`badge badge--${status}`}>{labels[status] ?? status}</span>;
}

function TicketReel({ maxTickets, ticketsSold }) {
  const stubs = Array.from({ length: maxTickets }, (_, i) => i);
  return (
    <div className="reel" aria-label={`${ticketsSold} of ${maxTickets} tickets sold`}>
      {stubs.map((i) => (
        <div key={i} className={`reel__stub ${i < ticketsSold ? "reel__stub--sold" : ""}`}>
          {String(i + 1).padStart(2, "0")}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  if (lotteryConfig.maintenance) {
    return (
      <div className="page">
        <main className="stage">
          <section className="hero">
            <p className="eyebrow">Back soon</p>
            <h1>We're doing a quick update.</h1>
            <p className="hero__sub">
              The lottery is paused for a short maintenance break — usually about 10 minutes.
              Thanks for your patience, we'll be right back.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const {
    lottery,
    myTicket,
    status,
    isAuthority,
    isWinner,
    loading,
    pending,
    error,
    connected,
    walletBalance,
    lotteryAddress,
    buyTicket,
    claimRefund,
    requestRandomness,
    cancelLottery,
  } = useLottery();

  const countdown = useCountdown(lottery?.endTime);
  const [actionMsg, setActionMsg] = useState(null);

  const maxTickets = lottery?.maxTickets ?? 0;
  const ticketsSold = lottery?.ticketsSold ?? 0;
  const potLamports = lottery ? Number(lottery.ticketPrice) * ticketsSold : 0;
  const drawReady =
    status === LotteryStatus.Open &&
    ((countdown && countdown.diff === 0) || ticketsSold === maxTickets) &&
    ticketsSold > 0;

  async function handle(action, successMsg) {
    setActionMsg(null);
    try {
      await action();
      setActionMsg(successMsg);
    } catch (err) {
      setActionMsg(err?.message ?? "Something went wrong");
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">◎</span>
          <span className="brand__name">Draw</span>
        </div>
        <WalletMultiButton />
      </header>

      <main className="stage">
        <section className="hero">
          <p className="eyebrow">Lottery #{lottery?.lotteryId?.toString?.() ?? "—"}</p>
          <h1>
            One winner.
            <br />
            Verified on-chain.
          </h1>
          <p className="hero__sub">
            Every draw is settled by a Switchboard VRF proof — nobody, including us, can
            influence which ticket wins.
          </p>
        </section>

        {loading && <p className="hint">Loading lottery state…</p>}
        {error && <p className="error">{error}</p>}

        {lottery && (
          <>
            <section className="panel panel--stats">
              <div className="stat">
                <span className="stat__label">Status</span>
                <StatusBadge status={status} />
              </div>
              <div className="stat">
                <span className="stat__label">Ticket price</span>
                <span className="stat__value">{lamportsToSol(lottery.ticketPrice)} SOL</span>
              </div>
              <div className="stat">
                <span className="stat__label">Pot</span>
                <span className="stat__value stat__value--accent">
                  {lamportsToSol(potLamports)} SOL
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">Tickets</span>
                <span className="stat__value">
                  {ticketsSold} / {maxTickets}
                </span>
              </div>
              <div className="stat">
                <span className="stat__label">Closes in</span>
                <span className="stat__value stat__value--mono">
                  {countdown ? (countdown.diff > 0 ? countdown.label : "ended") : "—"}
                </span>
              </div>
            </section>

            <section className="panel">
              <TicketReel maxTickets={maxTickets} ticketsSold={ticketsSold} />
            </section>

            <section className="panel panel--action">
              {status === LotteryStatus.Open && (
                <>
                  {myTicket ? (
                    <p className="hint">
                      You hold ticket <strong>#{String(myTicket.ticketIndex + 1).padStart(2, "0")}</strong>.
                      Good luck!
                    </p>
                  ) : (
                    <>
                      {connected && walletBalance !== null && (
                        <p className="hint">
                          Your balance: {(walletBalance / 1_000_000_000).toFixed(4)} SOL
                        </p>
                      )}
                      {connected && walletBalance !== null && lottery && walletBalance < Number(lottery.ticketPrice) && (
                        <p className="error">
                          Not enough SOL in your wallet to buy a ticket ({(Number(lottery.ticketPrice) / 1_000_000_000).toFixed(4)} SOL needed). Please add funds and try again.
                        </p>
                      )}
                      <button
                        className="btn btn--primary"
                        disabled={
                          !connected ||
                          pending ||
                          ticketsSold >= maxTickets ||
                          (walletBalance !== null && lottery && walletBalance < Number(lottery.ticketPrice))
                        }
                        onClick={() => handle(buyTicket, "Ticket purchased — good luck!")}
                      >
                        {connected ? "Buy a ticket" : "Connect a wallet to enter"}
                      </button>
                    </>
                  )}
                  {drawReady && (
                    <button
                      className="btn btn--ghost"
                      disabled={!connected || pending}
                      onClick={() => handle(requestRandomness, "Draw requested — waiting on the oracle.")}
                    >
                      Request the draw
                    </button>
                  )}
                </>
              )}

              {status === LotteryStatus.RandomnessRequested && (
                <p className="hint hint--pulse">
                  Waiting on the Switchboard oracle to deliver a verifiable random result…
                </p>
              )}

              {status === LotteryStatus.Completed && (
                <>
                  <p className="hint">
                    Winning ticket:{" "}
                    <strong>#{String(lottery.winningTicketIndex + 1).padStart(2, "0")}</strong>
                  </p>
                  {isWinner && (
                    <p className="hint">
                      🎉 You won! The prize was sent to your wallet automatically — no action needed.
                    </p>
                  )}
                  {myTicket && !isWinner && <p className="hint">Not this time — thanks for playing.</p>}
                </>
              )}

              {status === LotteryStatus.Cancelled && myTicket && !myTicket.claimed && (
                <button
                  className="btn btn--primary"
                  disabled={pending}
                  onClick={() => handle(claimRefund, "Refund sent to your wallet.")}
                >
                  Claim your refund
                </button>
              )}

              {actionMsg && <p className="hint">{actionMsg}</p>}
            </section>

            {isAuthority && status === LotteryStatus.Open && (
              <section className="panel panel--admin">
                <p className="eyebrow">Authority controls</p>
                <button
                  className="btn btn--danger"
                  disabled={pending}
                  onClick={() => handle(cancelLottery, "Lottery cancelled — ticket holders can refund.")}
                >
                  Cancel lottery
                </button>
              </section>
            )}

            <footer className="footer">
              <span>Lottery account</span>
              <code>{lotteryAddress.toBase58()}</code>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
