[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Rieee-delrey/paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Rieee-delrey/paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Paper Sprint Bot

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It trades 10 SOL of paper money on a replay of real pump.fun bonding-curve events. No real funds, no network, fully deterministic: the same input always produces the same action log.

## Strategy: launch sniper with a heavy-early-flow filter

The bot watches every new curve from its `CreateEvent` and buys once, within three slots of creation, when the opening tape shows real crowd interest:

- at least 4 distinct non-creator buyers and 3 trades in the last 5 slots,
- net buy flow of at least 8 SOL over those 5 slots,
- the creator has not sold and has bought at most 2.5 SOL,
- real SOL reserves between 0.3 and 30 SOL.

Each buy is 0.3 SOL, capped at 1% of the curve's real SOL reserve. It sells the whole position on the first of: +15% take-profit, -20% stop-loss, 10 slots held, or a creator sell while holding. At most 5 open positions.

## Dev result (house kit, local grade)

- Net PnL **+0.2316 SOL** over 114 coins (114 round trips, 44.7% win rate)
- Max drawdown 0.0286 — guardrails met (at least 20 coins, drawdown under 50%)
- Two executions reproduce byte for byte

Honest limits: the edge is fee-sensitive (at 2x fees the same run nets -0.166 SOL), and the final grade runs on 6 hours of fresh, unseen data, so the dev number is a signal, not a promise.

## Run it

Requires Node 22.18 or later (the grader runs Node 22.23.4). The bot speaks `agent-fun/replay/v2` on stdin/stdout through the vendored SDK in `vendor/`:

```sh
node main.ts
```

Grade it locally with the house kit (needs the kit unpacked next to it):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver docker
```

## License

MIT. See [LICENSE](LICENSE).
