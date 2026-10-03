# moaazhomaid · Claude Code plugins

A Claude Code plugin marketplace by [Moaaz Homaid](https://github.com/moaazhomaid).

## Install

In Claude Code, on any device and any account:

```
/plugin marketplace add moaazhomaid/claude-plugins
/plugin install tokenscope@moaazhomaid
```

Or from a shell:

```sh
claude plugin marketplace add moaazhomaid/claude-plugins
claude plugin install tokenscope@moaazhomaid
```

Restart Claude Code after installing. To pick up new releases later:

```sh
claude plugin marketplace update moaazhomaid
claude plugin update tokenscope@moaazhomaid
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [tokenscope](plugins/tokenscope) | Live token & USD observatory: input, cache write, cache read and output per agent, subagent, workflow, task, skill and model; prompt-cache countdowns per model; a model lock while the cache is warm; subscription leverage and rate-limit gauges. |

## License

MIT
