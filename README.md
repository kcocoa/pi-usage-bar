# Pi Usage Bar (`pi-usage-bar`)

Universal usage and rate-limit quota status bar for [Pi](https://github.com/earendil-works/pi).

Displays remaining quota percentages, local reset countdowns (or absolute clock times), plan type, and credits across multiple providers directly in Pi's status bar / footer.

## Features

- **Multi-Provider Support**:
  - **Anthropic**: Unified 5h and 7d utilization, remaining percentages, reset countdowns, and rate-limit rejection state (from OAuth response headers).
  - **xAI**: SuperGrok / X Premium weekly credit usage and reset countdowns (via Grok CLI billing proxy, cached for 5 minutes).
  - **Codex / OpenAI Gateways**: 5h/7d windows, custom metered limits, plan tiers (`plus`, `pro5x`, `pro20x`, `business`), and credits balances.
- **Shared Reset Clock & Countdown**:
  - Low remaining quota (< 10%) or upcoming reset (< 1h) automatically switches to a 24-hour local clock (`HH:MM`).
  - Longer windows display relative countdowns (`3h44m`, `5d17h`).
  - Expired windows display `now` or `?`.
- **Zero Invasiveness**:
  - Observes HTTP response headers via Pi's native `after_provider_response` hook.
  - Does not modify provider requests, wrap transports, or alter message lifecycles.
- **Commands**:
  - `/quota` (or `/usage`): Shows detailed quota information for the active model provider, or specify one (e.g. `/quota anthropic`, `/quota xai`, `/quota codex`).
  - Backward-compatible aliases: `/anthropic:usage`, `/xai:usage`, `/codex:usage`.

## Status Bar Display Examples

- Codex Pro 5x: `pro5x 5h:82%↺3h44m 7d:54%↺5d17h`
- Anthropic: `5h:97%↺4h47m 7d:77%↺3d20h`
- xAI SuperGrok: `supergrok 7d:99%↺5d12h`
- Low 5h quota with clock reset: `pro5x 5h:8%↺14:30`
- Reset passed: `5h:?↺now`

## Installation

Add this extension directory to your Pi configuration (or clone into `~/.pi/agent/extensions/pi-usage-bar`).
