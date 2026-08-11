use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::sysvar::slot_hashes::{self, SlotHashes};
use anchor_lang::prelude::*;

// Replace with your deployed program ID (see README step 3: `anchor keys list`)
declare_id!("FkGLxdYpJpmSn2tXVGRyeoQCSb1Nrh2NpzDfWyRwDwXt");

/// Platform fee taken from every prize pot, expressed in basis points (200 = 2%).
const PLATFORM_FEE_BPS: u64 = 200;
const BPS_DENOMINATOR: u64 = 10_000;

/// How many slots after `request_randomness` the draw must wait before
/// `draw_winner` can read the committed slot's hash. Nobody — including the
/// caller of `request_randomness` — knows that slot's hash in advance,
/// which is what makes this a commit-reveal rather than a "grind the
/// current clock" scheme.
const COMMIT_DELAY_SLOTS: u64 = 2;

/// The SlotHashes sysvar only retains roughly the last 512 slots. If nobody
/// calls `draw_winner` before the committed slot ages out of that window,
/// `request_randomness` can be called again to commit to a fresh slot. This
/// margin keeps well clear of the actual 512-slot retention limit.
const SLOT_HASH_EXPIRY_SLOTS: u64 = 400;

#[program]
pub mod solana_lottery {
    use super::*;

    /// Creates a new lottery round. Only the calling wallet can cancel it later.
    pub fn initialize_lottery(
        ctx: Context<InitializeLottery>,
        lottery_id: u64,
        ticket_price: u64,
        max_tickets: u32,
        duration_seconds: i64,
    ) -> Result<()> {
        require!(ticket_price > 0, LotteryError::InvalidTicketPrice);
        require!(max_tickets > 1, LotteryError::InvalidMaxTickets);
        require!(duration_seconds > 0, LotteryError::InvalidDuration);

        let lottery = &mut ctx.accounts.lottery;
        let now = Clock::get()?.unix_timestamp;

        lottery.authority = ctx.accounts.authority.key();
        lottery.lottery_id = lottery_id;
        lottery.ticket_price = ticket_price;
        lottery.max_tickets = max_tickets;
        lottery.tickets_sold = 0;
        lottery.status = LotteryStatus::Open;
        lottery.randomness_target_slot = 0;
        lottery.winner = None;
        lottery.winning_ticket_index = None;
        lottery.created_at = now;
        lottery.end_time = now
            .checked_add(duration_seconds)
            .ok_or(LotteryError::MathOverflow)?;
        lottery.bump = ctx.bumps.lottery;
        lottery.escrow_bump = ctx.bumps.escrow;
        lottery.ticket_buyers = Vec::new();

        emit!(LotteryInitialized {
            lottery: lottery.key(),
            authority: lottery.authority,
            ticket_price,
            max_tickets,
            end_time: lottery.end_time,
        });

        Ok(())
    }

    /// Buys exactly one ticket. Each wallet may hold at most one ticket per
    /// lottery round — enforced by the PDA seeds on the `Ticket` account,
    /// which makes a second purchase from the same wallet fail to
    /// initialize (account already exists).
    pub fn buy_ticket(ctx: Context<BuyTicket>) -> Result<()> {
        let lottery = &mut ctx.accounts.lottery;

        require!(lottery.status == LotteryStatus::Open, LotteryError::LotteryNotOpen);
        require!(
            Clock::get()?.unix_timestamp < lottery.end_time,
            LotteryError::LotteryEnded
        );
        require!(lottery.tickets_sold < lottery.max_tickets, LotteryError::LotterySoldOut);

        // Move SOL from the buyer into the escrow PDA.
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.buyer.key(),
            &ctx.accounts.escrow.key(),
            lottery.ticket_price,
        );
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let ticket = &mut ctx.accounts.ticket;
        ticket.lottery = lottery.key();
        ticket.buyer = ctx.accounts.buyer.key();
        ticket.ticket_index = lottery.tickets_sold;
        ticket.bump = ctx.bumps.ticket;

        lottery.tickets_sold = lottery
            .tickets_sold
            .checked_add(1)
            .ok_or(LotteryError::MathOverflow)?;
        lottery.ticket_buyers.push(ticket.buyer);

        emit!(TicketPurchased {
            lottery: lottery.key(),
            buyer: ticket.buyer,
            ticket_index: ticket.ticket_index,
        });

        Ok(())
    }

    /// Anyone can trigger this once the lottery is full or its end time has
    /// passed. It commits to a *future* slot: `draw_winner` will use the
    /// hash of that exact slot as its randomness source. Because the slot
    /// hasn't happened yet, nobody — not the caller, not the lottery
    /// authority — knows that hash at commit time, which is what prevents
    /// grinding for a favorable outcome.
    ///
    /// Also callable again if a previous commit's target slot aged out of
    /// the SlotHashes sysvar's retention window without anyone calling
    /// `draw_winner`, so a lottery can never get permanently stuck waiting
    /// on a hash that has scrolled out of history.
    pub fn request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
        let lottery = &mut ctx.accounts.lottery;
        let current_slot = Clock::get()?.slot;

        let can_request = lottery.status == LotteryStatus::Open
            || (lottery.status == LotteryStatus::RandomnessRequested
                && current_slot > lottery.randomness_target_slot + SLOT_HASH_EXPIRY_SLOTS);
        require!(can_request, LotteryError::LotteryNotOpen);

        if lottery.status == LotteryStatus::Open {
            let now = Clock::get()?.unix_timestamp;
            let ready = lottery.tickets_sold == lottery.max_tickets || now >= lottery.end_time;
            require!(ready, LotteryError::LotteryNotReadyForDraw);
            require!(lottery.tickets_sold > 0, LotteryError::NoTicketsSold);
        }

        lottery.status = LotteryStatus::RandomnessRequested;
        lottery.randomness_target_slot = current_slot + COMMIT_DELAY_SLOTS;

        emit!(RandomnessRequested {
            lottery: lottery.key(),
            target_slot: lottery.randomness_target_slot,
        });

        Ok(())
    }

    /// Draws the winner once the committed slot has passed, using that
    /// slot's hash (read from the SlotHashes sysvar) as the randomness
    /// source. Callable by anyone — the outcome is fixed by the slot hash,
    /// not by who submits the transaction.
    pub fn draw_winner(ctx: Context<DrawWinner>) -> Result<()> {
        let lottery = &mut ctx.accounts.lottery;

        require!(
            lottery.status == LotteryStatus::RandomnessRequested,
            LotteryError::RandomnessNotRequested
        );
        let current_slot = Clock::get()?.slot;
        require!(current_slot > lottery.randomness_target_slot, LotteryError::DrawWindowNotOpenYet);

        // Manually parse the SlotHashes sysvar's raw bytes instead of relying
        // on `SlotHashes::from_account_info`, whose bincode-based deserialize
        // path isn't reliably compatible across all toolchain/runtime
        // combinations. Layout: 8-byte little-endian entry count, followed by
        // that many (8-byte slot, 32-byte hash) pairs, newest slot first.
        let slot_hashes_account_info = ctx.accounts.slot_hashes.to_account_info();
        let data = slot_hashes_account_info.try_borrow_data()?;
        require!(data.len() >= 8, LotteryError::SlotHashesUnreadable);
        let num_entries = u64::from_le_bytes(
            data[0..8].try_into().map_err(|_| error!(LotteryError::SlotHashesUnreadable))?,
        ) as usize;

        let mut committed_hash_bytes: Option<[u8; 32]> = None;
        let mut offset = 8usize;
        for _ in 0..num_entries {
            require!(data.len() >= offset + 40, LotteryError::SlotHashesUnreadable);
            let slot = u64::from_le_bytes(
                data[offset..offset + 8].try_into().map_err(|_| error!(LotteryError::SlotHashesUnreadable))?,
            );
            if slot == lottery.randomness_target_slot {
                let mut hash_bytes = [0u8; 32];
                hash_bytes.copy_from_slice(&data[offset + 8..offset + 40]);
                committed_hash_bytes = Some(hash_bytes);
                break;
            }
            offset += 40;
        }
        drop(data);
        let committed_hash_bytes = committed_hash_bytes.ok_or(LotteryError::SlotHashExpired)?;
        let committed_hash = &committed_hash_bytes;

        // Mix the committed slot hash with lottery-specific data for domain
        // separation, then fold the digest down to a u64 and reduce modulo
        // the ticket count. The modulus is tiny relative to 2^64, so the
        // reduction bias is negligible for any realistic ticket count.
        let digest = hashv(&[
            committed_hash.as_ref(),
            lottery.key().as_ref(),
            &lottery.tickets_sold.to_le_bytes(),
        ]);
        let mut seed_bytes = [0u8; 8];
        seed_bytes.copy_from_slice(&digest.to_bytes()[0..8]);
        let random_u64 = u64::from_le_bytes(seed_bytes);
        let winning_index = (random_u64 % lottery.tickets_sold as u64) as u32;

        let expected_winner = *lottery
            .ticket_buyers
            .get(winning_index as usize)
            .ok_or(LotteryError::NoWinnerSelected)?;
        require_keys_eq!(ctx.accounts.winner.key(), expected_winner, LotteryError::NotTicketOwner);

        let pot = (lottery.ticket_price as u128)
            .checked_mul(lottery.tickets_sold as u128)
            .ok_or(LotteryError::MathOverflow)? as u64;
        let fee = pot
            .checked_mul(PLATFORM_FEE_BPS)
            .ok_or(LotteryError::MathOverflow)?
            / BPS_DENOMINATOR;
        let winner_amount = pot.checked_sub(fee).ok_or(LotteryError::MathOverflow)?;

        lottery.winning_ticket_index = Some(winning_index);
        lottery.winner = Some(expected_winner);
        lottery.status = LotteryStatus::Completed;

        let lottery_key = lottery.key();
        let escrow_seeds: &[&[u8]] = &[b"escrow", lottery_key.as_ref(), &[lottery.escrow_bump]];
        let escrow_info = ctx.accounts.escrow.to_account_info();
        let system_program_info = ctx.accounts.system_program.to_account_info();

        transfer_from_escrow(
            &escrow_info,
            &ctx.accounts.winner.to_account_info(),
            &system_program_info,
            winner_amount,
            escrow_seeds,
        )?;
        transfer_from_escrow(
            &escrow_info,
            &ctx.accounts.treasury.to_account_info(),
            &system_program_info,
            fee,
            escrow_seeds,
        )?;

        emit!(WinnerSelected {
            lottery: lottery_key,
            winning_ticket_index: winning_index,
        });

        Ok(())
    }


    /// Only the lottery's creator can cancel. Allowed while still `Open`, or
    /// if a draw was requested but never completed and its committed slot
    /// has aged out of the SlotHashes window — so funds can never be
    /// permanently stuck waiting on an unreachable draw.
    pub fn cancel_lottery(ctx: Context<CancelLottery>) -> Result<()> {
        let lottery = &mut ctx.accounts.lottery;
        let current_slot = Clock::get()?.slot;

        let can_cancel = lottery.status == LotteryStatus::Open
            || (lottery.status == LotteryStatus::RandomnessRequested
                && current_slot > lottery.randomness_target_slot + SLOT_HASH_EXPIRY_SLOTS);
        require!(can_cancel, LotteryError::CannotCancelAfterDrawStarted);

        lottery.status = LotteryStatus::Cancelled;

        emit!(LotteryCancelled { lottery: lottery.key() });
        Ok(())
    }

    /// Ticket holders pull a full refund once a lottery has been cancelled.
    /// The ticket account is closed on success, refunding its rent to the
    /// buyer.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        let lottery = &ctx.accounts.lottery;

        require!(lottery.status == LotteryStatus::Cancelled, LotteryError::LotteryNotCancelled);
        require_keys_eq!(ctx.accounts.ticket.buyer, ctx.accounts.buyer.key(), LotteryError::NotTicketOwner);

        let lottery_key = lottery.key();
        let escrow_seeds: &[&[u8]] = &[b"escrow", lottery_key.as_ref(), &[lottery.escrow_bump]];

        transfer_from_escrow(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            lottery.ticket_price,
            escrow_seeds,
        )?;

        emit!(RefundClaimed {
            lottery: lottery_key,
            buyer: ctx.accounts.buyer.key(),
            amount: lottery.ticket_price,
        });

        Ok(())
    }
}

/// Moves lamports out of the escrow PDA via a signed CPI into the System
/// Program. The escrow is owned by the System Program (it's a PDA that only
/// ever holds lamports, no account data), so its balance can only be
/// debited through a `system_instruction::transfer` where the escrow signs
/// via `invoke_signed` with its own PDA seeds — direct lamport-field
/// manipulation only works for accounts owned by *this* program, which the
/// escrow is not.
fn transfer_from_escrow<'info>(
    escrow: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    amount: u64,
    escrow_seeds: &[&[u8]],
) -> Result<()> {
    require!(escrow.lamports() >= amount, LotteryError::InsufficientEscrowBalance);

    let ix = anchor_lang::solana_program::system_instruction::transfer(escrow.key, to.key, amount);
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[escrow.clone(), to.clone(), system_program.clone()],
        &[escrow_seeds],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(lottery_id: u64, ticket_price: u64, max_tickets: u32)]
pub struct InitializeLottery<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Lottery::space_for(max_tickets),
        seeds = [b"lottery", authority.key().as_ref(), lottery_id.to_le_bytes().as_ref()],
        bump
    )]
    pub lottery: Account<'info, Lottery>,

    /// The escrow PDA holds SOL only; it has no account data of its own.
    #[account(
        seeds = [b"escrow", lottery.key().as_ref()],
        bump
    )]
    pub escrow: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyTicket<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lottery", lottery.authority.as_ref(), lottery.lottery_id.to_le_bytes().as_ref()],
        bump = lottery.bump
    )]
    pub lottery: Account<'info, Lottery>,

    #[account(
        mut,
        seeds = [b"escrow", lottery.key().as_ref()],
        bump = lottery.escrow_bump
    )]
    pub escrow: SystemAccount<'info>,

    // One ticket per wallet: this account can only ever be initialized once
    // per (lottery, buyer) pair, so a second `buy_ticket` call from the same
    // wallet fails with an "account already in use" error.
    #[account(
        init,
        payer = buyer,
        space = Ticket::SPACE,
        seeds = [b"ticket", lottery.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub ticket: Account<'info, Ticket>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    /// Anyone may call this — it only advances state once conditions are met.
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lottery", lottery.authority.as_ref(), lottery.lottery_id.to_le_bytes().as_ref()],
        bump = lottery.bump
    )]
    pub lottery: Account<'info, Lottery>,
}

#[derive(Accounts)]
pub struct DrawWinner<'info> {
    #[account(
        mut,
        seeds = [b"lottery", lottery.authority.as_ref(), lottery.lottery_id.to_le_bytes().as_ref()],
        bump = lottery.bump
    )]
    pub lottery: Account<'info, Lottery>,

    #[account(
        mut,
        seeds = [b"escrow", lottery.key().as_ref()],
        bump = lottery.escrow_bump
    )]
    pub escrow: SystemAccount<'info>,

    /// CHECK: validated on-chain against the winning ticket's recorded
    /// buyer before any funds move; does not need to sign since the
    /// escrow PDA (owned by this program) authorizes the transfer.
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: platform treasury wallet, set once per deployment.
    #[account(mut)]
    pub treasury: AccountInfo<'info>,

    /// CHECK: address-constrained to the real SlotHashes sysvar and parsed
    /// manually in the handler.
    #[account(address = slot_hashes::ID)]
    pub slot_hashes: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
pub struct CancelLottery<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ LotteryError::Unauthorized,
        seeds = [b"lottery", lottery.authority.as_ref(), lottery.lottery_id.to_le_bytes().as_ref()],
        bump = lottery.bump
    )]
    pub lottery: Account<'info, Lottery>,
}

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        seeds = [b"lottery", lottery.authority.as_ref(), lottery.lottery_id.to_le_bytes().as_ref()],
        bump = lottery.bump
    )]
    pub lottery: Account<'info, Lottery>,

    #[account(
        mut,
        seeds = [b"escrow", lottery.key().as_ref()],
        bump = lottery.escrow_bump
    )]
    pub escrow: SystemAccount<'info>,

    #[account(
        mut,
        close = buyer,
        seeds = [b"ticket", lottery.key().as_ref(), buyer.key().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, Ticket>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Lottery {
    pub authority: Pubkey,
    pub lottery_id: u64,
    pub ticket_price: u64,
    pub max_tickets: u32,
    pub tickets_sold: u32,
    pub status: LotteryStatus,
    /// Slot committed to by `request_randomness`; `draw_winner` reads this
    /// exact slot's hash from the SlotHashes sysvar. Zero until requested.
    pub randomness_target_slot: u64,
    pub winner: Option<Pubkey>,
    pub winning_ticket_index: Option<u32>,
    pub created_at: i64,
    pub end_time: i64,
    pub bump: u8,
    pub escrow_bump: u8,
    /// Buyer address for each ticket, indexed by ticket_index. Lets
    /// `draw_winner` look up and pay the winner directly without requiring
    /// them to submit a claim transaction.
    pub ticket_buyers: Vec<Pubkey>,
}

impl Lottery {
    // discriminator(8) + pubkey(32) + u64(8) + u64(8) + u32(4) + u32(4)
    // + status(1) + u64(8) + option<pubkey>(33) + option<u32>(5)
    // + i64(8) + i64(8) + u8(1) + u8(1) + vec_len_prefix(4)
    pub const BASE_SPACE: usize = 8 + 32 + 8 + 8 + 4 + 4 + 1 + 8 + 33 + 5 + 8 + 8 + 1 + 1 + 4;

    pub fn space_for(max_tickets: u32) -> usize {
        Lottery::BASE_SPACE + (max_tickets as usize) * 32
    }
}

#[account]
pub struct Ticket {
    pub lottery: Pubkey,
    pub buyer: Pubkey,
    pub ticket_index: u32,
    pub bump: u8,
}

impl Ticket {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum LotteryStatus {
    Open,
    RandomnessRequested,
    Completed,
    Cancelled,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct LotteryInitialized {
    pub lottery: Pubkey,
    pub authority: Pubkey,
    pub ticket_price: u64,
    pub max_tickets: u32,
    pub end_time: i64,
}

#[event]
pub struct TicketPurchased {
    pub lottery: Pubkey,
    pub buyer: Pubkey,
    pub ticket_index: u32,
}

#[event]
pub struct RandomnessRequested {
    pub lottery: Pubkey,
    pub target_slot: u64,
}

#[event]
pub struct WinnerSelected {
    pub lottery: Pubkey,
    pub winning_ticket_index: u32,
}

#[event]
pub struct PrizeClaimed {
    pub lottery: Pubkey,
    pub winner: Pubkey,
    pub amount: u64,
    pub fee: u64,
}

#[event]
pub struct LotteryCancelled {
    pub lottery: Pubkey,
}

#[event]
pub struct RefundClaimed {
    pub lottery: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum LotteryError {
    #[msg("Ticket price must be greater than zero")]
    InvalidTicketPrice,
    #[msg("Max tickets must be greater than one")]
    InvalidMaxTickets,
    #[msg("Duration must be greater than zero")]
    InvalidDuration,
    #[msg("Lottery is not open for ticket purchases")]
    LotteryNotOpen,
    #[msg("Lottery has already ended")]
    LotteryEnded,
    #[msg("Lottery is sold out")]
    LotterySoldOut,
    #[msg("Lottery is not yet ready to draw a winner")]
    LotteryNotReadyForDraw,
    #[msg("No tickets were sold for this lottery")]
    NoTicketsSold,
    #[msg("Randomness has not been requested for this lottery")]
    RandomnessNotRequested,
    #[msg("The committed slot has not been reached yet")]
    DrawWindowNotOpenYet,
    #[msg("Could not read the SlotHashes sysvar")]
    SlotHashesUnreadable,
    #[msg("The committed slot's hash has expired from the SlotHashes sysvar; call request_randomness again")]
    SlotHashExpired,
    #[msg("Lottery has not completed its draw yet")]
    LotteryNotCompleted,
    #[msg("No winner has been selected yet")]
    NoWinnerSelected,
    #[msg("This ticket did not win")]
    NotWinningTicket,
    #[msg("Signer does not own this ticket")]
    NotTicketOwner,
    #[msg("Lottery has not been cancelled")]
    LotteryNotCancelled,
    #[msg("Lottery cannot be cancelled after the draw has started")]
    CannotCancelAfterDrawStarted,
    #[msg("Only the lottery authority may perform this action")]
    Unauthorized,
    #[msg("Escrow balance is insufficient for this transfer")]
    InsufficientEscrowBalance,
    #[msg("Math overflow")]
    MathOverflow,
}
