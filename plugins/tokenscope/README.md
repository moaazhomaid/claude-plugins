# TokenScope

A live token and dollar observatory for Claude Code. It prices every model request of the session
(main thread, subagents, workflow agents, background forks) in all four token kinds, groups the
spend by agent, task, skill and model, times each model's prompt cache, and can hold a model
switch until the cache cools.

```
◆ Opus 5.5·xhigh ⏱3:42 🔒 │ Haiku 4.5 ⏱1:10 ×2 │ $4.82 │ ctx 41% │ in 12k c.wrt 210k c.read 3.4M out 48k │ hit 94% │ 5h ▰▰▱▱▱
```

## Install

```
/plugin marketplace add moaazhomaid/claude-plugins
/plugin install tokenscope@moaazhomaid
```

Restart Claude Code, then run `/tokenscope`.

## What you get

- **Band above the prompt**: model · effort, the cache countdown per model, session $, context fill,
  the four token counts, cache hit rate and the 5-hour rate-limit window.
- **Status line**: the same at a glance.
- **`/tokenscope` pane** with seven tabs (keys `1`–`7`):
  1. **Overview**: colored KPI tiles (input, cache write, cache read, output, total, cache saved),
     token and dollar mix bars, spend by model, $/request sparkline, priciest request, top spenders,
     and one cost tip read from the session.
  2. **Agents**: the main thread, every subagent (nested), workflow agents and engine forks, each
     with model · effort, the four token counts and $.
  3. **Tasks**: every prompt with its model · effort, duration, requests, agents and full cost,
     subagents included.
  4. **Skills**: calls, the skill prompt's own size, and the spend while each skill was active.
  5. **Models**: a card per model (spend, cache timer, spend by effort level, tokens, the agents
     that used it, its rate card) and a what-if repricing the session on every current model.
  6. **Plan**: session, today, month and all-time API-equivalent value, plan leverage for Pro,
     Max 5x, Max 20x or API, and the rate-limit windows with their resets.
  7. **Cache**: the main cache countdown, the model lock, the TTL, switches held, cold starts,
     and every agent's cache grouped by model.
- **Alerts**: spend milestones, one minute before the cache expires, when it expires, and context
  at 80% and 90%.
- **`/tokenscope receipt`**: a printable receipt of the session.

## Commands

| Command | Does |
| --- | --- |
| `/tokenscope` | Open the pane |
| `/tokenscope band` | Show or hide the band above the prompt |
| `/tokenscope receipt` | Print the session receipt |
| `/tokenscope plan pro\|max5\|max20\|api` | Set your plan for the leverage figure |
| `/tokenscope lock on\|warn\|off` | Hold, warn about, or allow model switches while the cache is warm |
| `/tokenscope unlock` | Let the next model switch through now |
| `/tokenscope ttl 5m\|1h` | Set the cache TTL (otherwise detected from cache reads) |
| `/tokenscope reset` | Zero the session counters (history kept) |

## The model lock

Prompt caches belong to one model: switching models while a cache is warm re-writes the whole
prefix on the new one. With the lock on (the default), `/model X` while the cache is warm is held
and queued, and runs by itself when the cache cools. A model picked in the `/model` menu is kept
on the cached model for that turn. Fallbacks the engine makes mid-turn always pass. Every request
refreshes the cache, so a held switch happens after a pause of one TTL; `/tokenscope unlock`
switches now.

## How the dollars are computed

Each request's `input`, `cache_creation`, `cache_read` and `output` tokens are priced at
Anthropic's list API rates for the model that answered (cache writes at 1.25× input, the
5-minute cache). On a subscription nothing is billed per token: the figures are what the same
work would cost on the API, and the Plan tab compares them with your plan's price. The header also
shows Claude Code's own `/cost` total as a cross-check. Workflow agents are attributed to the
latest workflow (the engine does not name a workflow's agents); skill dollars are the spend in
that agent loop while the skill was active.

History (per-day totals and your plan) is kept in the plugin's own store on each machine.

## Develop

```sh
git clone https://github.com/moaazhomaid/claude-plugins
claude --plugin-dir claude-plugins/plugins/tokenscope   # load the working copy
claude plugin validate claude-plugins/plugins/tokenscope
claude plugin test claude-plugins/plugins/tokenscope
```

## License

MIT © Moaaz Homaid
