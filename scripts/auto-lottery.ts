import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram, Connection } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import * as crypto from "crypto";

const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const IDL_PATH = path.join(__dirname, "..", "app", "src", "idl.json");
const CONFIG_PATH = path.join(__dirname, "..", "app", "src", "config.json");
const MAINTENANCE_FLAG_PATH = path.join(__dirname, "..", "MAINTENANCE_MODE");
const APP_DIR = path.join(__dirname, "..", "app");
const TREASURY = new PublicKey("3ghWMV6hFm1mPrWXnxPriaVunRvqvjG6xVtw4PquLqWL");

const TICKET_PRICE_SOL = process.env.TICKET_PRICE_SOL ? parseFloat(process.env.TICKET_PRICE_SOL) : 0.1;
const MAX_TICKETS = process.env.MAX_TICKETS ? parseInt(process.env.MAX_TICKETS, 10) : 10;
const DURATION_SECONDS = process.env.DURATION_SECONDS ? parseInt(process.env.DURATION_SECONDS, 10) : 60 * 10;

function loadProgram(provider: anchor.AnchorProvider) {
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  return new Program(idl as any, provider) as Program<any>;
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

async function findCommittedHash(connection: Connection, targetSlot: bigint): Promise<Buffer | null> {
  const info = await connection.getAccountInfo(SLOT_HASHES_SYSVAR);
  if (!info) return null;
  const data = info.data;
  const numEntries = data.readBigUInt64LE(0);
  let offset = 8;
  for (let i = 0n; i < numEntries; i++) {
    const slot = data.readBigUInt64LE(offset);
    if (slot === targetSlot) {
      return data.subarray(offset + 8, offset + 40);
    }
    offset += 40;
  }
  return null;
}

function computeWinningIndex(committedHash: Buffer, lotteryPda: PublicKey, ticketsSold: number): number {
  const ticketsSoldBuf = Buffer.alloc(4);
  ticketsSoldBuf.writeUInt32LE(ticketsSold, 0);
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.concat([committedHash, lotteryPda.toBuffer(), ticketsSoldBuf]))
    .digest();
  const randomU64 = digest.readBigUInt64LE(0);
  return Number(randomU64 % BigInt(ticketsSold));
}

async function startNewRound(provider: anchor.AnchorProvider, program: Program<any>) {
  const authority = provider.wallet.publicKey;
  const lotteryId = new anchor.BN(Date.now());
  const ticketPriceLamports = new anchor.BN(TICKET_PRICE_SOL * LAMPORTS_PER_SOL);
  const durationSeconds = new anchor.BN(DURATION_SECONDS);

  const [lotteryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lottery"), authority.toBuffer(), lotteryId.toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), lotteryPda.toBuffer()],
    program.programId
  );

  console.log("[" + new Date().toISOString() + "] Starting new round: " + lotteryPda.toBase58());

  await (program.methods as any)
    .initializeLottery(lotteryId, ticketPriceLamports, MAX_TICKETS, durationSeconds)
    .accounts({
      authority,
      lottery: lotteryPda,
      escrow: escrowPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        programId: program.programId.toBase58(),
        lotteryId: lotteryId.toString(),
        lottery: lotteryPda.toBase58(),
        escrow: escrowPda.toBase58(),
        maintenance: false,
      },
      null,
      2
    )
  );

  console.log("Rebuilding and restarting frontend...");
  execSync("npm run build", { cwd: APP_DIR, stdio: "inherit" });
  try {
    execSync("tmux kill-session -t frontend");
  } catch (e) {}
  execSync('tmux new-session -d -s frontend "cd ' + APP_DIR + ' && serve -s dist -l 5173"');
  console.log("New round is live.");
}

async function tick(provider: anchor.AnchorProvider) {
  const maintenanceRequested = fs.existsSync(MAINTENANCE_FLAG_PATH);
  const config = loadConfig();

  if (config.maintenance) {
    if (!maintenanceRequested) {
      console.log("Maintenance flag removed — resuming with a new round.");
      const program = loadProgram(provider);
      await startNewRound(provider, program);
    } else {
      console.log("[" + new Date().toISOString() + "] Paused for maintenance.");
    }
    return;
  }

  const program = loadProgram(provider);
  const lotteryPda = new PublicKey(config.lottery);
  const escrowPda = new PublicKey(config.escrow);

  let lottery;
  try {
    lottery = await (program.account as any).lottery.fetch(lotteryPda);
  } catch (e) {
    console.log("No existing lottery found — bootstrapping the first round.");
    await startNewRound(provider, program);
    return;
  }

  const statusKey = Object.keys(lottery.status)[0];
  const now = Math.floor(Date.now() / 1000);
  const endTime = Number(lottery.endTime);
  const ticketsSold = lottery.ticketsSold;
  const maxTickets = lottery.maxTickets;

  console.log(
    "[" + new Date().toISOString() + "] status=" + statusKey + " tickets=" + ticketsSold + "/" + maxTickets
  );

  if (statusKey === "open") {
    const ready = ticketsSold === maxTickets || now >= endTime;
    if (ready && ticketsSold >= 2) {
      console.log("Requesting randomness...");
      try {
        await (program.methods as any)
          .requestRandomness()
          .accounts({ caller: provider.wallet.publicKey, lottery: lotteryPda })
          .rpc();
      } catch (e) {
        console.error("request_randomness failed:", (e as Error).message);
      }
    } else if (ready && ticketsSold <= 1) {
      const reason = ticketsSold === 1 ? "only one ticket sold" : "no tickets sold";
      console.log("Round ended with " + reason + " — cancelling and starting a new round.");
      try {
        await (program.methods as any)
          .cancelLottery()
          .accounts({ authority: provider.wallet.publicKey, lottery: lotteryPda })
          .rpc();
      } catch (e) {
        console.error("cancel_lottery failed:", (e as Error).message);
      }
      await startNewRound(provider, program);
    }
  } else if (statusKey === "randomnessRequested") {
    const targetSlot = BigInt(lottery.randomnessTargetSlot.toString());
    const currentSlot = BigInt(await provider.connection.getSlot());
    if (currentSlot <= targetSlot) {
      console.log("Committed slot not reached yet, waiting...");
      return;
    }
    const committedHash = await findCommittedHash(provider.connection, targetSlot);
    if (!committedHash) {
      console.log("Committed slot hash expired — will re-request randomness next tick.");
      return;
    }
    const winningIndex = computeWinningIndex(committedHash, lotteryPda, ticketsSold);
    const winnerPubkey = new PublicKey(lottery.ticketBuyers[winningIndex]);
    console.log("Predicted winning ticket:", winningIndex, "winner:", winnerPubkey.toBase58());
    try {
      await (program.methods as any)
        .drawWinner()
        .accounts({
          lottery: lotteryPda,
          escrow: escrowPda,
          winner: winnerPubkey,
          treasury: TREASURY,
          slotHashes: SLOT_HASHES_SYSVAR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log("Winner drawn and paid automatically!");
    } catch (e) {
      console.log("draw_winner failed:", (e as Error).message);
    }
  } else if (statusKey === "completed" || statusKey === "cancelled") {
    if (maintenanceRequested) {
      console.log("Round " + statusKey + " — entering maintenance mode as requested.");
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ ...config, maintenance: true }, null, 2)
      );
      execSync("npm run build", { cwd: APP_DIR, stdio: "inherit" });
      try {
        execSync("tmux kill-session -t frontend");
      } catch (e) {}
      execSync('tmux new-session -d -s frontend "cd ' + APP_DIR + ' && serve -s dist -l 5173"');
      console.log("Maintenance banner is now live.");
      return;
    }
    console.log("Round " + statusKey + ". Starting next round...");
    await startNewRound(provider, program);
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  console.log("Auto-lottery watcher started. Authority:", provider.wallet.publicKey.toBase58());

  while (true) {
    try {
      await tick(provider);
    } catch (e) {
      console.error("Tick error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

main();
