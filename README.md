# SolFair - Provably Fair On-Chain Lottery on Solana

Live site: solfair.tech

SolFair is a fully on-chain lottery built on Solana. One winner per round, chosen
through a verifiable, tamper-proof process that nobody -- including the people
running it -- can influence.

## How it's fair

Instead of trusting an external random-number source, each draw uses a
commit-reveal scheme built on Solana's own SlotHashes sysvar:

1. Once a round is ready to draw, the program commits to a future slot.
2. Nobody -- not the caller, not the operator -- knows that slot's hash yet.
3. Once that slot has passed, anyone can trigger the draw. The winning ticket
   is derived by hashing the now-public slot hash together with the lottery's
   own account data.
4. The prize is transferred to the winner automatically, in the same
   transaction that determines the winner -- no separate "claim" step, no
   possibility of forgetting or being unable to collect a prize.

## What's automated

A background watcher script runs the entire lifecycle with no manual
intervention:
- Detects when a round is ready (sold out or time's up)
- Requests and reveals randomness
- Pays out the winner automatically
- Refunds the sole participant if only one ticket was sold
- Starts the next round immediately after

## Project structure

- programs/solana-lottery/  - Anchor (Rust) smart contract
- app/                      - React + Vite frontend
- scripts/deploy.ts         - One-off: initialize a single lottery round
- scripts/auto-lottery.ts   - Continuous watcher: runs the full lifecycle
- scripts/lottery.test.ts   - Integration tests
- GETTING_STARTED.md        - Full beginner-friendly setup walkthrough

## Tech stack

- Smart contract: Rust + Anchor 0.30
- Frontend: React, Vite, @solana/wallet-adapter (Phantom, Solflare)
- Randomness: Solana's native SlotHashes sysvar (no external oracle dependency)

## Status

This project is under active development. See IMPLEMENTATION_NOTES.md for a
candid list of what's implemented versus what still needs work before any
mainnet deployment handling third-party funds.

WARNING: The smart contract has not undergone a professional security audit.
Treat any mainnet deployment accordingly.

## Running it yourself

See GETTING_STARTED.md for a detailed, step-by-step setup guide.

## License

MIT
