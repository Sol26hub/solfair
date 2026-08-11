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
  await (program.methods as any)
    .cancelLottery()
    .accounts({ authority: provider.wallet.publicKey, lottery: new PublicKey(config.lottery) })
    .rpc();
  console.log("Cancelled for testing.");
}
main().catch((e) => console.error(e.message));
