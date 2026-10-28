# swarm-board

A Claude Code pane that shows a manager session, the worker sessions it spawned (as a tree), and the messages they sent each other. It only reads what the cloud-session tools already expose:

- **Swarms**: any of your sessions that other sessions name as `parent_session_id`. The most recently updated one is selected by default; buttons at the top switch between them.
- **Agents tab**: the manager on top, labelled MANAGER, then its workers indented by depth, each with a status (working / blocked / review_ready / completed / failed) and the session's latest one-line summary.
- **Messages tab**: every `send_message` and `create_session` call those sessions made, merged into one timeline (sender → receiver).

Refreshes every 90 s, or when you press ↻. `/swarm` reopens the pane.

Requires the `claude-code-remote` MCP server, which cloud sessions have.

Limits: scans your 300 most recent sessions; the first scan of a transcript reads up to 4000 assistant events, so older messages in a very long manager transcript are missing.

## Install

```
/plugin install swarm-board --marketplace rowancallahan/swarm-board
```
