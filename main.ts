// Paper Sprint bot: a launch sniper with a heavy-early-flow filter.
//
// It watches every new pump.fun curve from its CreateEvent and buys once,
// within three slots of creation, when the opening tape shows real crowd
// interest: several distinct non-creator buyers, a few trades, and strong
// net buy flow over the last five slots, with the creator still holding
// (no creator sell, creator buys under the cap) and real SOL reserves in
// a sane band. It exits on take-profit, stop-loss, a hold cap, or a
// creator sell while holding. Pure function of the batches: no clock,
// no randomness, no I/O, insertion-ordered iteration only.

import { runBot } from './vendor/agentfun-bot.ts';
import type { Batch, Bot, BotState, OrderInput } from './vendor/agentfun-bot.ts';

// --- strategy parameters (lamports; 1 SOL = 1_000_000_000) ---
const MIN_FLOW_LAMPORTS = 8_000_000_000n; // 8 SOL net flow over the last 5 slots
const MIN_BUYERS = 4; // distinct non-creator buyers in the window
const MIN_TRADES = 3; // trades in the window
const MAX_AGE_SLOTS = 3; // buy only within 3 slots of the CreateEvent
const FLOW_WINDOW_SLOTS = 5;
const STAKE_LAMPORTS = 300_000_000n; // 0.3 SOL per buy
const TP_BPS = 1500; // +15% take-profit
const SL_BPS = 2000; // -20% stop-loss
const BUY_SLIPPAGE_BPS = 10000;
const SELL_SLIPPAGE_BPS = 10000;
const MAX_HOLD_SLOTS = 10;
const MIN_REAL_SOL = 300_000_000n; // 0.3 SOL of real reserves
const MAX_REAL_SOL = 30_000_000_000n; // 30 SOL of real reserves
const MAX_DEV_BUY_LAMPORTS = 2_500_000_000n; // 2.5 SOL of creator buys
const MAX_ORDERS_PER_BATCH = 16;

interface TapeSlot {
  buySol: bigint;
  sellSol: bigint;
  trades: number;
  buyers: Set<string>;
}

interface Tape {
  creator: string;
  createdSlot: number; // -1 when no CreateEvent was seen for the mint
  slots: Map<number, TapeSlot>;
  creatorBuySol: bigint;
  creatorSold: boolean;
}

const tapes = new Map<string, Tape>();
const bought = new Set<string>(); // mints with a filled buy; buy once per coin
const buySlot = new Map<string, number>(); // mint -> slot its position first appeared

function tapeFor(mint: string, creator: string, createdSlot: number): Tape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = {
      creator,
      createdSlot,
      slots: new Map(),
      creatorBuySol: 0n,
      creatorSold: false,
    };
    tapes.set(mint, tape);
  }
  return tape;
}

function windowStats(tape: Tape, nowSlot: number): { buyers: number; trades: number; net: bigint } {
  const buyers = new Set<string>();
  let trades = 0;
  let net = 0n;
  for (let s = nowSlot - FLOW_WINDOW_SLOTS + 1; s <= nowSlot; s++) {
    const bucket = tape.slots.get(s);
    if (bucket === undefined) continue;
    trades += bucket.trades;
    net += bucket.buySol - bucket.sellSol;
    for (const user of bucket.buyers) buyers.add(user);
  }
  return { buyers: buyers.size, trades, net };
}

// Mark-to-market value of a holding at the curve's latest virtual reserves.
function markValue(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

const bot: Bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = state.slot;

    // 1. Fold this batch's events into the per-mint tapes.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        tapeFor(event.mint, event.creator, event.slot);
      } else if (event.event === 'TradeEvent') {
        const tape = tapeFor(event.mint, event.creator, -1);
        let bucket = tape.slots.get(event.slot);
        if (bucket === undefined) {
          bucket = { buySol: 0n, sellSol: 0n, trades: 0, buyers: new Set() };
          tape.slots.set(event.slot, bucket);
        }
        const sol = BigInt(event.sol_amount);
        if (event.is_buy) {
          bucket.buySol += sol;
          if (event.user !== tape.creator) bucket.buyers.add(event.user);
        } else {
          bucket.sellSol += sol;
        }
        bucket.trades += 1;
        if (event.user === tape.creator) {
          if (event.is_buy) tape.creatorBuySol += sol;
          else tape.creatorSold = true;
        }
      }
      // CompleteEvent: the curve is done; state.curves already marks it.
    }

    // 2. Record filled buys, track when each position first appeared, and
    // drop records for positions that are gone (sold or closed by the harness).
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') bought.add(fill.mint);
    }
    for (const mint of state.positions.keys()) {
      if (!buySlot.has(mint)) buySlot.set(mint, now);
    }
    for (const mint of [...buySlot.keys()]) {
      if (!state.positions.has(mint)) buySlot.delete(mint);
    }
    // Prune tape slots that fell out of the flow window.
    const oldest = now - FLOW_WINDOW_SLOTS + 1;
    for (const tape of tapes.values()) {
      for (const slot of [...tape.slots.keys()]) {
        if (slot < oldest) tape.slots.delete(slot);
      }
    }

    const orders: OrderInput[] = [];

    // 3. Exits: sell the whole position on the first of take-profit,
    // stop-loss, the hold cap, or a creator sell while holding.
    const pendingSell = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') pendingSell.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const tape = tapes.get(mint);
      const value = markValue(state, mint, holding.token_amount);
      const cost = holding.cost_lamports;
      const takeProfit = (cost * BigInt(10000 + TP_BPS)) / 10000n;
      const stopLoss = (cost * BigInt(10000 - SL_BPS)) / 10000n;
      const held = now - (buySlot.get(mint) ?? now);
      const devSold = tape !== undefined && tape.creatorSold;
      if (value >= takeProfit || value <= stopLoss || held >= MAX_HOLD_SLOTS || devSold) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // 4. Entries: one buy per coin, within three slots of its creation.
    let free = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    const maxPositions = state.hello.caps.max_open_positions;
    const pendingBuy = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy') pendingBuy.add(pending.order.mint);
    }
    let buysSent = 0;
    for (const [mint, curve] of state.curves) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (state.committedPositionCount() + buysSent >= maxPositions) break;
      if (curve.complete) continue;
      if (bought.has(mint) || pendingBuy.has(mint) || state.positions.has(mint)) continue;
      const tape = tapes.get(mint);
      if (tape === undefined || tape.createdSlot < 0) continue;
      const age = now - tape.createdSlot;
      if (age < 0 || age > MAX_AGE_SLOTS) continue;
      const stats = windowStats(tape, now);
      if (stats.buyers < MIN_BUYERS || stats.trades < MIN_TRADES) continue;
      if (stats.net < MIN_FLOW_LAMPORTS) continue;
      if (tape.creatorSold) continue;
      if (tape.creatorBuySol > MAX_DEV_BUY_LAMPORTS) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      let size = STAKE_LAMPORTS;
      const cap = state.maxBuyLamports(mint);
      if (size > cap) size = cap;
      const afford = free - txFee;
      if (size > afford) size = afford;
      if (size <= 0n) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= size + txFee;
      buysSent += 1;
    }

    return orders;
  },
};

await runBot(bot);
