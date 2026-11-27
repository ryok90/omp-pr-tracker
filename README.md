# omp-pr-tracker

An [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) extension that lists the GitHub pull requests opened or pushed to during the current session, in a widget above the prompt.

## What it detects

- **Created PRs**: `gh pr create` (via `bash` or `eval`), and the `github` tool's `pr_create` op (directly or through `write xd://github`).
- **Pushes**: `git push` output (`To <remote>` + ref lines) on GitHub remotes, resolved to the branch's PR with `gh pr list --head`; and the `github` tool's `pr_push` op.
- **Subagents**: PRs found by in-process subagents show up in the main session's list.

Tracked PRs are saved as session entries, so they survive resume and rewinds. Each row shows state (`OPEN`, `DRAFT`, `MERGED`, …) and title.

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
omp plugin install github:ryok90/omp-pr-tracker
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
