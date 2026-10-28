# swarm-board

A Claude Code pane that shows a manager session, the worker sessions it spawned (as a tree), and the messages they sent each other. It only reads what the cloud-session tools already expose:

- **Swarms**: any of your sessions that other sessions name as `parent_session_id`. The most recently updated one is selected by default; buttons at the top switch between them.
- **Agents tab**: the manager on top, labelled MANAGER, then its workers indented by depth, each with a status (working / blocked / review_ready / completed / failed) and the session's latest one-line summary.
- **Messages tab**: every `send_message` and `create_session` call those sessions made, merged into one timeline (sender → receiver).

- **Perf tab**: renders `.swarm/perf.md` from the manager session's branch. A line that is only `![alt](plots/x.svg)` draws that SVG (path relative to `.swarm/`, max 128 KB) on desktop, web, VS Code and mobile; the terminal shows the alt text.
- **Tests tab**: renders `.swarm/tests.md` from the same branch, same rules.

Perf and Tests are free-form posting places: agents commit and push those files; the pane only reads them. The branch is the first one listed in the manager session's outcomes. The session running the pane needs the project repo attached, since it reads through the GitHub tools.

Snippet for the manager's instructions:

> Keep `.swarm/perf.md` (performance per commit, plots as SVG under `.swarm/plots/`, linked as `![caption](plots/name.svg)` on their own line) and `.swarm/tests.md` (which CI checks ran for each branch/commit and their result) up to date on your branch. Newest first.

Refreshes every 90 s, or when you press ↻. `/swarm` reopens the pane; where the app does not place side panes, `/swarm` prints the board as text instead (`/swarm agents|msgs|perf|tests`; plots become GitHub links). Cloud sessions viewed in the desktop or web app attach no surface, so they get the text form.

Requires the `claude-code-remote` MCP server, which cloud sessions have.

Limits: scans your 300 most recent sessions; the first scan of a transcript reads up to 4000 assistant events, so older messages in a very long manager transcript are missing.

## Install

```
/plugin install swarm-board --marketplace rowancallahan/swarm-board
```
