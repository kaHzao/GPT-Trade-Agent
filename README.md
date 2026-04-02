# Jupiter Perps Agent — GPT Strategy

Trading agent menggunakan TA dari GPT:
- **Macro filter**: 4h Market Structure (HH/HL vs LH/LL)
- **Entry**: 30m breakout + strong candle body
- **Volatility filter**: ATR 0.3%-2% (avoid chop & spike)
- **SL/TP**: ATR-based, RR 1:2.2
- **Risk**: Consecutive loss filter (block 24h setelah 2x SL)

## Perbandingan vs Agent Claude

| | Agent Claude | Agent GPT |
|---|---|---|
| Macro | EMA 20/50 | Market Structure HH/HL |
| Entry | EMA align + RSI | Breakout + candle body |
| Volatility | ADX | ATR range filter |
| R:R | 2.0 | 2.2 |

## Setup

1. Fork repo ini
2. Set GitHub Secrets: `JUP_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
3. Set GitHub Variables: `COLLATERAL_USDC=10`, `LEVERAGE=2`, `DRY_RUN=false`
4. Enable GitHub Actions
