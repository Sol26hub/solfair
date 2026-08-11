import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import idl from "./idl.json";
import config from "./config.json";

const PROGRAM_ID = new PublicKey(config.programId);
const LOTTERY_PDA = new PublicKey(config.lottery);
const ESCROW_PDA = new PublicKey(config.escrow);

export const LotteryStatus = {
  Open: "open",
  RandomnessRequested: "randomnessRequested",
  Completed: "completed",
  Cancelled: "cancelled",
};

function statusToKey(statusEnum) {
  if (!statusEnum) return LotteryStatus.Open;
  return Object.keys(statusEnum)[0];
}

export function useLottery() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [lottery, setLottery] = useState(null);
  const [myTicket, setMyTicket] = useState(null);
  const [walletBalance, setWalletBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const provider = useMemo(() => {
    if (!wallet) return null;
    return new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  }, [connection, wallet]);

  const program = useMemo(() => {
    if (!provider) return null;
    return new anchor.Program(idl, provider);
  }, [provider]);

  const ticketPda = useCallback((buyerPubkey) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), LOTTERY_PDA.toBuffer(), buyerPubkey.toBuffer()],
      PROGRAM_ID
    )[0];
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Falls back to a read-only fetch even before a wallet connects, so
      // visitors can see the lottery state without connecting first.
      const readProvider =
        provider ??
        new anchor.AnchorProvider(connection, { publicKey: PublicKey.default }, {});
      const readProgram = program ?? new anchor.Program(idl, readProvider);

      const account = await readProgram.account.lottery.fetch(LOTTERY_PDA);
      setLottery(account);

      if (wallet?.publicKey) {
        try {
          const pda = ticketPda(wallet.publicKey);
          const ticket = await readProgram.account.ticket.fetch(pda);
          setMyTicket(ticket);
        } catch {
          setMyTicket(null); // no ticket purchased yet
        }
        try {
          const lamports = await connection.getBalance(wallet.publicKey);
          setWalletBalance(lamports);
        } catch {
          setWalletBalance(null);
        }
      } else {
        setMyTicket(null);
        setWalletBalance(null);
      }
    } catch (err) {
      console.error(err);
      setError("Could not load lottery state. Check your network settings and config.json.");
    } finally {
      setLoading(false);
    }
  }, [connection, program, provider, wallet, ticketPda]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 8000);
    return () => clearInterval(interval);
  }, [refresh]);

  const buyTicket = useCallback(async () => {
    if (!program || !wallet?.publicKey) throw new Error("Connect a wallet first");
    setPending(true);
    setError(null);
    try {
      const pda = ticketPda(wallet.publicKey);
      await program.methods
        .buyTicket()
        .accounts({
          buyer: wallet.publicKey,
          lottery: LOTTERY_PDA,
          escrow: ESCROW_PDA,
          ticket: pda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err?.message ?? "Ticket purchase failed");
      throw err;
    } finally {
      setPending(false);
    }
  }, [program, wallet, ticketPda, refresh]);

  const claimPrize = useCallback(
    async (treasuryPubkey) => {
      if (!program || !wallet?.publicKey) throw new Error("Connect a wallet first");
      setPending(true);
      setError(null);
      try {
        const pda = ticketPda(wallet.publicKey);
        await program.methods
          .claimPrize()
          .accounts({
            winner: wallet.publicKey,
            lottery: LOTTERY_PDA,
            escrow: ESCROW_PDA,
            ticket: pda,
            treasury: treasuryPubkey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        await refresh();
      } catch (err) {
        console.error(err);
        setError(err?.message ?? "Claim failed");
        throw err;
      } finally {
        setPending(false);
      }
    },
    [program, wallet, ticketPda, refresh]
  );

  const claimRefund = useCallback(async () => {
    if (!program || !wallet?.publicKey) throw new Error("Connect a wallet first");
    setPending(true);
    setError(null);
    try {
      const pda = ticketPda(wallet.publicKey);
      await program.methods
        .claimRefund()
        .accounts({
          buyer: wallet.publicKey,
          lottery: LOTTERY_PDA,
          escrow: ESCROW_PDA,
          ticket: pda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err?.message ?? "Refund failed");
      throw err;
    } finally {
      setPending(false);
    }
  }, [program, wallet, ticketPda, refresh]);

  const requestRandomness = useCallback(async () => {
    if (!program || !wallet?.publicKey) throw new Error("Connect a wallet first");
    setPending(true);
    setError(null);
    try {
      await program.methods
        .requestRandomness()
        .accounts({ caller: wallet.publicKey, lottery: LOTTERY_PDA })
        .rpc();
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err?.message ?? "Draw request failed");
      throw err;
    } finally {
      setPending(false);
    }
  }, [program, wallet, refresh]);

  const cancelLottery = useCallback(async () => {
    if (!program || !wallet?.publicKey) throw new Error("Connect a wallet first");
    setPending(true);
    setError(null);
    try {
      await program.methods
        .cancelLottery()
        .accounts({ authority: wallet.publicKey, lottery: LOTTERY_PDA })
        .rpc();
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err?.message ?? "Cancel failed");
      throw err;
    } finally {
      setPending(false);
    }
  }, [program, wallet, refresh]);

  const status = statusToKey(lottery?.status);
  const isAuthority = Boolean(
    wallet?.publicKey && lottery?.authority && wallet.publicKey.equals(lottery.authority)
  );
  const isWinner = Boolean(
    myTicket &&
      lottery?.winningTicketIndex !== null &&
      lottery?.winningTicketIndex !== undefined &&
      myTicket.ticketIndex === lottery.winningTicketIndex
  );

  return {
    lottery,
    myTicket,
    status,
    isAuthority,
    isWinner,
    loading,
    pending,
    error,
    connected: Boolean(wallet?.publicKey),
    walletBalance,
    lotteryAddress: LOTTERY_PDA,
    escrowAddress: ESCROW_PDA,
    refresh,
    buyTicket,
    claimPrize,
    claimRefund,
    requestRandomness,
    cancelLottery,
  };
}
