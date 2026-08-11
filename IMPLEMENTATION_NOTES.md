# Implementation notes

What's built and what still needs your input before this goes anywhere near
mainnet with real funds.

## Fully implemented
- `initialize_lottery`, `buy_ticket`, `request_randomness`, `consume_randomness`,
  `claim_prize`, `cancel_lottery`, `claim_refund` — all account validation,
  PDA derivation, escrow lamport accounting, one-ticket-per-wallet enforcement,
  and the 98/2 payout split.
- React frontend (`app/`) wired to all of the above through `useLottery.js`,
  with wallet connect, live countdown, ticket reel, claim/refund/admin flows.
- `scripts/deploy.ts` initializes a lottery and writes `app/src/config.json`
  automatically.
- `scripts/lottery.test.ts` covers init, ticket purchase, escrow accounting,
  one-ticket-per-wallet, sold-out rejection, and the full cancel → refund path.

## Stubbed — needs your input
1. **Switchboard VRF wiring.** `request_randomness` flips lottery state but
   does not yet CPI into Switchboard to actually request an update, and
   `ConsumeRandomness` reads `VrfAccountData` assuming a `switchboard-v2`
   dependency version you'll pin yourself. The exact account list
   (permission PDA, oracle queue, escrow token account) varies by SDK
   version — follow https://docs.switchboard.xyz/solana/randomness and slot
   the CPI into `request_randomness`.
2. **`declare_id!`** is a placeholder (`LoTTery111...`). Run `anchor keys list`
   after your first build and replace it, per the README.
3. **Treasury wallet** — `App.jsx` uses `TREASURY_PLACEHOLDER`
   (`111111...1`, the System Program address, which will make `claim_prize`
   fail). Replace with your real treasury pubkey.
4. **`app/src/idl.json`** is a hand-written placeholder so the frontend code
   compiles and lines up with the program's instruction/account names. It is
   **not** a real Anchor IDL (no discriminators). Run `anchor build` and copy
   `program/target/idl/solana_lottery.json` over it before connecting to a
   real deployment.
5. **No independent audit.** The escrow uses direct lamport debits (a PDA
   with no account data can't be moved via `system_instruction::transfer`,
   since it never signs the outer transaction), which is a standard pattern
   but should be reviewed alongside everything else per the Mainnet
   Checklist in the README.

## Design decisions worth knowing about
- One ticket per wallet is enforced structurally: the `Ticket` PDA is seeded
  by `(lottery, buyer)`, so a second `buy_ticket` call from the same wallet
  fails at account creation rather than through a runtime check.
- Winner selection reduces the first 8 bytes of the VRF output modulo the
  ticket count. With realistic ticket counts (tens to low thousands) against
  a 64-bit space, modulo bias is negligible; call this out explicitly if an
  auditor asks.
- Anyone can call `request_randomness` — it's a no-op unless the lottery is
  actually full or past its end time, so this can't be used to force an
  early draw.
