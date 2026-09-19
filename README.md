# pi-teams

Native cross-pi-agent communication and self-forks. Every pi agent
process registers with a local broker and gains an endpoint other
agents can reach directly; a fork of the main agent is a disciple
process of it and is tied to the parent's lifetime, going away with it.
The extension surfaces the endpoints at session start, lists them on
demand, and spawns tied forks, so multiple pi agents on this machine
coordinate natively instead of through the shared tree.

## What it provides

- **Broker** (`src/teamd.py`): a loopback TCP registry and relay on
  `127.0.0.1` with an ephemeral port and a random token, published
  atomically in `TEAM_ROOT/endpoint` (default `~/.local/state/
  pi-teams`). Every connection must present the token in a hello
  handshake before any op. A per-root broker lock (a `.broker.lock`
  marker acquired atomically at start) guarantees a single broker even
  when many sessions boot and race at once, so an in-place extension
  reload never spawns one broker per session. Agents register once,
  exchange JSON-lines messages, discover each other, and are swept when
  their connection goes idle past the heartbeat timeout. The registry
  is mirrored to `registry.json` atomically for non-connected readers.
- **Client** (`src/team.py`): one persistent connection per agent is the
  endpoint; while it stays open the agent is reachable and relayed
  messages arrive on it. CLI: `team register`, `team ls`, `team send
  <id> <kind> <text>`, `team follow`, `team terminate <id>`,
  `team fork --name <n> [-- argv...]`, `team deregister`.
- **Fork lifetime and GC**: a fork registers with its parent's team id
  in the `parent` field and reports the pid of the pi it serves as its
  owner. Liveness is connection-based everywhere: when a parent's
  connection closes, or a fork goes idle (no work contact for
  PI_TEAMS_FORK_IDLE, default 300s; zero disables), the broker closes
  the fork's endpoint, drops the entry, and signals the owner pid, so
  the forked pi dies for real instead of outliving its parent as a
  hold-shim ghost. A working teammate stays alive: the extension
  publishes busy state from pi's own lifecycle events
  (agent_start/agent_settled) and the hold streams it in its heartbeat,
  which resets the idle clock. Only forks are ever signalled; main
  agents are never touched.
- **Extension** (`extensions/pi-teams.ts`): registers the running pi,
  keeps its endpoint open through a held connection, injects a compact
  teammates note before the first agent run, and answers
  `/team ls|status|send|spawn|kill`. Identity rides through CLI args
  (`--id/--name/--role/--parent/--session`) because pi.exec does not
  forward env, and the held connection exits on an EOF on its stdin
  (a hosted session's PTY) so the endpoint dies with its pi instead of
  pinging forever as an orphan. When a fork starts, the pi child
  registers through the same extension.
- **Awareness**: at session start the extension tells the agent which
  teammates are live, their endpoints, and that `/team send <id> ...`
  is the direct channel.

## Validation

Enforced in this repository; run all of it with:

```
python3 tests/run.py
```

That chains, in order:

- **README format lint** (`tests/readme_lint.py`): title/heading
  structure, 80-column prose wrap (URLs and code may exceed), no
  trailing whitespace or tabs, balanced fences, required sections.
- **OOP lint** (`tests/oop_lint.py`): no module-level mutable state, no
  `global`, no bare `except`, no `var` in the extension.
- **Broker protocol tests** (`tests/broker_test.py`): handshake token
  rejection, endpoint publication, registration and discovery, relay
  delivery, undeliverable reports, deregistration, connection-close
  drop, and idle sweep.
- **Fork lifecycle tests** (`tests/fork_test.py`): a fork stays alive
  while its parent stays connected and exits on its own when the
  parent's connection closes or an explicit terminate is issued; the
  registry is cleaned in both cases.

Tests run on isolated roots under `TMPDIR`
(`~/tmp/pi-teams-sandbox`), never the system `/tmp`.

## Deployment

`scripts/install.sh` copies `src/teamd.py` and `src/team.py` into
`$HOME/.local/bin`, installs the extension into the pi agent home
extensions dir, and records installed bytes in a manifest;
`scripts/uninstall.sh` removes exactly what was installed. Both stage
every write through a same-directory temp file before the atomic move.
Restart pi sessions after installing so the extension loads; the broker
starts on demand per session.

```
scripts/install.sh      # install broker, client, and extension
scripts/uninstall.sh    # remove exactly what install.sh wrote
```

Adoption rule: validate on `main` (tests green) and only then install,
never the reverse.

## Roadmap

- **Notification previews in the logs**: surface inbound team messages
  as collapsed one-line previews that peek on demand instead of
  growing the transcript. Research note: pi-tui has no built-in
  expand/collapse component; the pattern is a collapsed row that
  toggles by swapping the component's rendered lines and calling
  `tui.requestRender()`, or a peeking overlay mounted through
  `ctx.ui.custom(..., { overlay: true })` with `overlayOptions` sizing
  and a `visible(termWidth, termHeight)` guard. See
  `ctx.ui.setWidget`/`setStatus` for the persistent surface.
- **Task routing**: kind-based delivery (task/result/notice) with
  acknowledgement and retry.
- **Broker upgrades**: spooling for offline recipients, authenticated
  roots, and a tighter spawner tie so forks reap promptly when the
  spawning pi process dies hard (currently bounded by the heartbeat
  sweep) without any pid probing.

## Attribution

- Messages are JSON objects exchanged over the `TEAM_ROOT/endpoint`;
  the broker relays `to`/`from` envelopes and keeps the registry.
- Original work in this repository; no upstream code is imported.

## License

MIT, see LICENSE. © 2026 Edrick Sinsuan.