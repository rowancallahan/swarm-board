---
name: swarm-board
description: Create or update this manager session's live Swarm Board, a claude.ai page showing its worker sessions, the messages between them, and posted perf and CI results. Use when the user asks for the swarm board or dashboard, or asks you to post performance or test results to it.
---

# Swarm Board

The board is a private claude.ai page (`board.html` in this skill's folder). It reads sessions live through the viewer's "Claude Code Remote" connector, so it needs no updates for agent status or messages. You only republish it to post perf and CI results.

## Make the board (once per manager)

1. Get this session's id: `get_session` (claude-code-remote) with no `session_id`. The pin is `m-` plus the id without its `session_` prefix (`session_01Abc` gives `m-01Abc`).
2. Copy `board.html` from this skill's folder to your scratchpad as `board.html`.
3. Publish it with the Artifact tool:
   - `file_path`: that copy
   - `title`: `Swarm Board` plus the project name
   - `icon`: `network`
   - `capabilities`: `{"mcp": {"servers": [{"server": "Claude Code Remote", "tools": ["list_sessions", "get_session", "list_events"]}]}}`
4. Give the user the link with the pin as its hash: `<artifact url>#m-<id>`. Without the hash, the page shows a picker of every manager session instead.
5. Keep the artifact URL in your own notes. If you lose it, `Artifact` `action: "list"` finds it.

## Post perf and test results

Write up to three kinds of files in one scratchpad folder, then publish them into the board:

- `perf.md`: performance per commit or branch, newest first. Put a plot on its own line as `![caption](plots/name.svg)`.
- `tests.md`: which CI checks ran on which branch and commit, and their results. A table works well.
- `plots/*.svg`: plots as standalone SVG with explicit colors and a white or transparent background. Keep each under 2 MB.

Publish with the Artifact tool:

- `url`: the board's URL. From a session that did not publish the board, `read` it first.
- `file_path`: your `board.html` copy, unchanged.
- `files`: `{"posts/perf.md": "<folder>/perf.md", "posts/tests.md": "<folder>/tests.md", "posts/plots/<name>.svg": "<folder>/plots/<name>.svg"}`

Leave `capabilities` out; the page keeps its declaration. Files you leave out stay as they were. Pass `null` for a path to remove it. Post only numbers you measured or that a worker reported, and say which commit each is from.
