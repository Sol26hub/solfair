import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import fs from "fs";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("/root/solana-lottery/app/src/idl.json", "utf-8"));
  const config = JSON.parse(fs.readFileSync("/root/solana-lottery/app/src/config.json", "utf-8"));
  const program = new Program(idl as any, provider) as Program<any>;
  const lotteryPda = new PublicKey(config.lottery);
  const buyer = new PublicKey("91EJixJgtxzT9a9YpQ565ZE57uggVnSVuPR9ByEroHL");
  const [ticketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), lotteryPda.toBuffer(), buyer.toBuffer()],
    program.programId
  );
  console.log("Ticket PDA:", ticketPda.toBase58());
  const ticket = await (program.account as any).ticket.fetch(ticketPda);
  console.log("Ticket:", ticket);
  const lottery = await (program.account as any).lottery.fetch(lotteryPda);
  console.log("Lottery status:", lottery.status);
  console.log("Winning ticket index:", lottery.winningTicketIndex);
}
main().catch((e) => console.error("ERROR:", e.message));
