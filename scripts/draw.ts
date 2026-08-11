import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl.json"), "utf-8"));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "config.json"), "utf-8"));
  const program = new Program(idl as any, provider) as Program<any>;
  const lotteryPda = new PublicKey(config.lottery);

  const lottery = await (program.account as any).lottery.fetch(lotteryPda);
  console.log("Status:", lottery.status);
  console.log("Tickets sold:", lottery.ticketsSold);

  if (true) { // always attempt a fresh request; contract allows re-requesting when expired
    console.log("Requesting randomness...");
    const sig1 = await (program.methods as any)
      .requestRandomness()
      .accounts({ caller: provider.wallet.publicKey, lottery: lotteryPda })
      .rpc();
    console.log("request_randomness tx:", sig1);
    console.log("Waiting a few seconds for slots to pass...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log("Drawing winner...");
  const sig2 = await (program.methods as any)
    .drawWinner()
    .accounts({ lottery: lotteryPda, slotHashes: SLOT_HASHES_SYSVAR })
    .rpc();
  console.log("draw_winner tx:", sig2);

  const updated = await (program.account as any).lottery.fetch(lotteryPda);
  console.log("Winning ticket index:", updated.winningTicketIndex);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
