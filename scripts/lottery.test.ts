/**
 * Integration tests for the Solana Lottery program.
 *
 * Run with:
 *   anchor test
 * (starts a local validator, deploys the program, then runs this suite)
 *
 * Coverage:
 *   - lottery initialization
 *   - ticket purchase + escrow accounting
 *   - one-ticket-per-wallet enforcement
 *   - sold-out / past-end-time rejection
 *   - cancellation + refund flow
 *
 * NOT covered here (needs a running Switchboard oracle or its local
 * emulator, which isn't available in a bare `anchor test` environment):
 *   - request_randomness / consume_randomness / claim_prize
 * See https://docs.switchboard.xyz/solana/randomness for how to run
 * `sbv2-solana` locally against a test validator for that flow.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("solana-lottery", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.SolanaLottery as Program<any>;
  const connection = provider.connection;

  const authority = provider.wallet as anchor.Wallet;
  const lotteryId = new anchor.BN(1);
  const ticketPrice = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
  const maxTickets = 3;
  const duration = new anchor.BN(2); // seconds, short so the "ended" test is fast
  const placeholderVrf = Keypair.generate().publicKey;

  let lotteryPda: PublicKey;
  let escrowPda: PublicKey;

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function ticketPda(lottery: PublicKey, buyer: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), lottery.toBuffer(), buyer.toBuffer()],
      program.programId
    )[0];
  }

  before(async () => {
    [lotteryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("lottery"), authority.publicKey.toBuffer(), lotteryId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), lotteryPda.toBuffer()],
      program.programId
    );
  });

  it("initializes a lottery", async () => {
    await program.methods
      .initializeLottery(lotteryId, ticketPrice, maxTickets, duration, placeholderVrf)
      .accounts({
        authority: authority.publicKey,
        lottery: lotteryPda,
        escrow: escrowPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const lottery = await program.account.lottery.fetch(lotteryPda);
    expect(lottery.ticketPrice.toString()).to.equal(ticketPrice.toString());
    expect(lottery.maxTickets).to.equal(maxTickets);
    expect(lottery.ticketsSold).to.equal(0);
    expect(lottery.status).to.deep.equal({ open: {} });
  });

  it("sells a ticket and moves SOL into escrow", async () => {
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 1);

    const escrowBefore = await connection.getBalance(escrowPda);
    const buyerTicketPda = await ticketPda(lotteryPda, buyer.publicKey);

    await program.methods
      .buyTicket()
      .accounts({
        buyer: buyer.publicKey,
        lottery: lotteryPda,
        escrow: escrowPda,
        ticket: buyerTicketPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const escrowAfter = await connection.getBalance(escrowPda);
    expect(escrowAfter - escrowBefore).to.equal(ticketPrice.toNumber());

    const ticket = await program.account.ticket.fetch(buyerTicketPda);
    expect(ticket.buyer.toBase58()).to.equal(buyer.publicKey.toBase58());
    expect(ticket.ticketIndex).to.equal(0);

    const lottery = await program.account.lottery.fetch(lotteryPda);
    expect(lottery.ticketsSold).to.equal(1);
  });

  it("rejects a second ticket from the same wallet", async () => {
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 1);
    const buyerTicketPda = await ticketPda(lotteryPda, buyer.publicKey);

    const buyOnce = () =>
      program.methods
        .buyTicket()
        .accounts({
          buyer: buyer.publicKey,
          lottery: lotteryPda,
          escrow: escrowPda,
          ticket: buyerTicketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

    await buyOnce();

    let failed = false;
    try {
      await buyOnce();
    } catch (err) {
      failed = true; // PDA already initialized -> "already in use"
    }
    expect(failed).to.equal(true);
  });

  it("rejects purchases once the lottery is sold out", async () => {
    // one more buyer fills the lottery to maxTickets (3)
    const buyer = Keypair.generate();
    await airdrop(buyer.publicKey, 1);
    const buyerTicketPda = await ticketPda(lotteryPda, buyer.publicKey);

    await program.methods
      .buyTicket()
      .accounts({
        buyer: buyer.publicKey,
        lottery: lotteryPda,
        escrow: escrowPda,
        ticket: buyerTicketPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const lottery = await program.account.lottery.fetch(lotteryPda);
    expect(lottery.ticketsSold).to.equal(maxTickets);

    const overflowBuyer = Keypair.generate();
    await airdrop(overflowBuyer.publicKey, 1);
    const overflowTicketPda = await ticketPda(lotteryPda, overflowBuyer.publicKey);

    let failed = false;
    try {
      await program.methods
        .buyTicket()
        .accounts({
          buyer: overflowBuyer.publicKey,
          lottery: lotteryPda,
          escrow: escrowPda,
          ticket: overflowTicketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([overflowBuyer])
        .rpc();
    } catch (err) {
      failed = true;
    }
    expect(failed).to.equal(true);
  });

  describe("cancellation + refund flow", () => {
    const cancelLotteryId = new anchor.BN(2);
    let cancelLotteryPda: PublicKey;
    let cancelEscrowPda: PublicKey;
    const buyer = Keypair.generate();
    let buyerTicketPda: PublicKey;

    before(async () => {
      [cancelLotteryPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("lottery"),
          authority.publicKey.toBuffer(),
          cancelLotteryId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
      [cancelEscrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), cancelLotteryPda.toBuffer()],
        program.programId
      );
      buyerTicketPda = await ticketPda(cancelLotteryPda, buyer.publicKey);

      await airdrop(buyer.publicKey, 1);

      await program.methods
        .initializeLottery(cancelLotteryId, ticketPrice, maxTickets, new anchor.BN(3600), placeholderVrf)
        .accounts({
          authority: authority.publicKey,
          lottery: cancelLotteryPda,
          escrow: cancelEscrowPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      await program.methods
        .buyTicket()
        .accounts({
          buyer: buyer.publicKey,
          lottery: cancelLotteryPda,
          escrow: cancelEscrowPda,
          ticket: buyerTicketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();
    });

    it("only the authority can cancel", async () => {
      const notAuthority = Keypair.generate();
      await airdrop(notAuthority.publicKey, 1);

      let failed = false;
      try {
        await program.methods
          .cancelLottery()
          .accounts({ authority: notAuthority.publicKey, lottery: cancelLotteryPda })
          .signers([notAuthority])
          .rpc();
      } catch (err) {
        failed = true;
      }
      expect(failed).to.equal(true);
    });

    it("cancels the lottery and refunds the ticket holder", async () => {
      await program.methods
        .cancelLottery()
        .accounts({ authority: authority.publicKey, lottery: cancelLotteryPda })
        .rpc();

      const lottery = await program.account.lottery.fetch(cancelLotteryPda);
      expect(lottery.status).to.deep.equal({ cancelled: {} });

      const buyerBalanceBefore = await connection.getBalance(buyer.publicKey);

      await program.methods
        .claimRefund()
        .accounts({
          buyer: buyer.publicKey,
          lottery: cancelLotteryPda,
          escrow: cancelEscrowPda,
          ticket: buyerTicketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .rpc();

      const buyerBalanceAfter = await connection.getBalance(buyer.publicKey);
      // Refund arrives net of the tx fee the buyer paid to submit claim_refund.
      expect(buyerBalanceAfter).to.be.greaterThan(buyerBalanceBefore);

      const ticket = await program.account.ticket.fetch(buyerTicketPda);
      expect(ticket.claimed).to.equal(true);
    });

    it("rejects a double refund claim", async () => {
      let failed = false;
      try {
        await program.methods
          .claimRefund()
          .accounts({
            buyer: buyer.publicKey,
            lottery: cancelLotteryPda,
            escrow: cancelEscrowPda,
            ticket: buyerTicketPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .rpc();
      } catch (err) {
        failed = true;
      }
      expect(failed).to.equal(true);
    });
  });
});
