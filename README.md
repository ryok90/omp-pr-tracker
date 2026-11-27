# omp-pr-tracker

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) extension that lists the GitHub pull requests opened or pushed to during the current session, in a widget above the prompt.

## What it detects

- **Created PRs**: `gh pr create` (via `bash` or `eval`), and the `github` tool's `pr_create` op (directly or through `write xd://github`).
- **Pushes**: `git push` output (`To <remote>` + ref lines) on GitHub remotes, resolved to the branch's PR with `gh pr list --head`; and the `github` tool's `pr_push` op.
- **Subagents**: PRs found by in-process subagents show up in the main session's list.

Tracked PRs are saved as session entries, so they survive resume and rewinds. Each row shows state (`OPEN`, `DRAFT`, `MERGED`, …) in GitHub's colors, and title.

### State icons

When omp uses Nerd Font symbols, each state is prefixed with GitHub's own Octicon (`git-pull-request-draft`, `git-pull-request`, `git-merge`, `git-pull-request-closed`). The plugin follows omp's symbol preset (`theme.symbols.preset`) instead of probing the terminal:

- omp switches to the `nerd` preset by itself when the terminal confirms Nerd Font support (Glyph Protocol), or when you set `symbolPreset: nerd`.
- With `unicode` or `ascii`, labels are shown without icons, so terminals lacking the glyphs never show boxes.
- Icons show as boxes? Your font predates these Octicons: install a current Nerd Font, or set `symbolPreset: unicode` to hide them.

## Commands

| Command | Effect |
| --- | --- |
| `/prs` | Refresh title/state of every tracked PR |
| `/prs add <url> [url…]` | Track PRs the detector missed |
| `/prs toggle` | Hide or show the list |

## Requirements

- omp
- [`gh`](https://cli.github.com/) installed and authenticated. Lookups that fail only log a warning.
- GitHub only (including Enterprise hosts reachable by `gh`).

## Install

```sh
omp plugin install omp-pr-tracker
```

Or through the [`ryok90-omp` marketplace](https://github.com/ryok90/omp-plugins):

```
/marketplace add ryok90/omp-plugins
/marketplace install omp-pr-tracker@ryok90-omp
```

Restart omp afterwards. Upgrade with `omp plugin upgrade omp-pr-tracker`; turn it off with `omp plugin disable omp-pr-tracker`.

For local development, clone and link instead:

```sh
git clone https://github.com/ryok90/omp-pr-tracker.git
omp plugin link ./omp-pr-tracker
```

## Notes

- The divider above the list follows the prompt's border colour by lazily importing an internal omp module. If a future omp moves it, the divider falls back to the theme's `border` colour; nothing else breaks.
- Session entries use the type `pr-tracker.opened`; it is kept stable for compatibility with existing sessions.

## License

MIT
