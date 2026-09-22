# pi-teams

Native cross-pi-agent communication and self-forks. Every pi agent
process registers with a local broker and gains an endpoint other
agents can reach directly; a fork of the main agent is a disciple
process of it and is tied to the parent's lifetime, going away with it.
The extension surfaces the endpoints at session start, lists them on
demand, and spawns tied forks, so multiple pi agents on this machine
coordinate natively instead of through the shared tree.

## What it provides

- **Broker** (`src/teamd.py`, a thin CLI over `src/team_broker.py`,
  `src/team_root.py`, `src/peer_link.py`, and `src/peer_tunnel.py`): a
  loopback TCP registry
  and relay on `127.0.0.1` with an ephemeral port and a random token, published
  atomically in `TEAM_ROOT/endpoint` (default `~/.local/state/
  pi-teams`). Every connection must present the token in a hello
  handshake before any op. A per-root broker lock (a `.broker.lock`
  marker acquired atomically at start) guarantees a single broker even
  when many sessions boot and race at once, so an in-place extension
  reload never spawns one broker per session. Agents register once,
  exchange JSON-lines messages, discover each other, and are swept when
  their connection goes idle past the heartbeat timeout. The registry
  is mirrored to `registry.json` atomically for non-connected readers.
- **Client** (`src/team.py`, a thin CLI over `src/team_client.py`): one
  persistent connection per agent is the endpoint; while it stays open
  the agent is reachable and relayed messages arrive on it. CLI: `team
  register`, `team ls`, `team send
  <id> <kind> <text>`, `team follow`, `team terminate <id>`,
  `team deregister`.
- **Fork lifetime and GC**: a fork registers with its parent's team id
  in the `parent` field and reports the pid of the pi it serves as its
  owner. Liveness is connection-based everywhere: when a parent's
  connection closes, or a fork goes idle (no work contact for
  PI_TEAMS_FORK_IDLE, default 300s; zero disables), the broker closes
  the fork's endpoint, drops the entry, and signals the owner pid, so
  the forked pi dies for real instead of outliving its parent as a
  hold-shim ghost. Only the process is reaped: a fork's session file
  remains, so it can still be resumed. A working teammate stays alive:
  the extension publishes busy state from pi's own lifecycle events
  (agent_start/agent_settled) and the hold streams it in its heartbeat,
  which resets the idle clock. Only forks are ever signalled; main
  agents are never touched.
- **Busy-file GC**: the broker also sweeps stale `.busy` state files. A
  file whose agent is no longer registered and whose mtime is older than
  PI_TEAMS_BUSY_GRACE (default 120s) belongs to an old /reload-idle
  session and is removed; a registered agent keeps its file however old
  the mtime is, and paths outside the team root are never touched. This
  clears flags left by a reload, crash, or reaped fork.
- **Teammate-session GC**: a spawned teammate is a normal pi session, so
  it appears in `/resume`. The broker removes a fork's session file when
  it is reaped or deregisters, and sweeps any teammate-marked session
  file whose agent is not live and whose mtime is older than
  PI_TEAMS_SESSION_GRACE (default 1h; PI_TEAMS_SESSIONS_ROOT overrides the
  scan root). A user's own session and a live fork's file are never
  touched, and deletions are guarded to the sessions root.
- **Broker self-restart**: the broker stamps its endpoint with a hash of
  its own source and tracks its last-active time. After an install or
  reload replaces the code, it exits on its own once it has been idle for
  PI_TEAMS_RESTART_GRACE (default 60s), removes its endpoint, and the next
  session start or spawn starts the replacement. It never self-exits
  while agents are active, so a reload cannot kill live work; the
  extension only starts a broker when none is published.
- **Attach an existing session**: any running pi session that is not
  already a teammate can become one without spawning a new process.
  `team_attach` (or `/team attach <parent> [name]`) asks the target
  agent to re-register under a fork id of the requester, so it reports
  to the requester and the broker GCs it with the parent. An agent
  belongs to one team: a target that already has a parent is refused,
  and a parent with no parent of its own may be attached and become a
  teammate too. `/team detach` returns the session to a plain main agent
  so it is no longer reaped. The session file is preserved, so an
  attached session stays in `/resume`.
- **Extension** (`extensions/pi-teams.ts`, a thin entry that composes
  the responsibility modules under `extensions/pi-teams/`): registers
  the running pi,
  keeps its endpoint open through a held connection, injects a compact
  teammates note before the first agent run, and answers
  `/team ls|status|send|attach|detach|kill`. The hold
  and forked pi are
  launched with Node's `child_process`, not `pi.exec`: `pi.exec` opens
  a child's stdin to `/dev/null` and drops the `env` option, which
  would make the hold exit on its first read and strip a fork of its
  identity. A stdin pipe owned by the extension keeps the hold alive
  exactly as long as its pi; identity and fork parentage ride in the
  child environment, and EOF on that pipe (pi gone) drops the endpoint
  instead of leaving an orphan. Forks reuse the running pi runtime
  (`process.execPath` plus its entry script) instead of the `pi` name,
  so a Windows launcher shim is never spawned directly. Teammates are
  spawned only by the `team_spawn` tool, so every one is a named,
  persistent pi session stored in the parent's session directory (or
  the default store) and appears in `/resume`; the fork's own `notice`
  records the exact session file. A teammate is a persistent headless
  pi RPC session, not a one-shot `pi -p` task: the extension owns the
  launch, holds its stdin pipe open so the teammate stays alive for
  messages, and closes the pipe when this pi goes away. There is no
  override for the pi command, so the structured spawner is the only
  launch path. The tool takes a task plus an optional name: the
  extension supplies the session, inherits the current model and
  thinking level, and prepends the report-back instruction. Context
  follows pi's own subagent semantics: like a `subagent` delegation,
  the teammate starts with a clean context and receives only the task
  text - the parent's transcript is never forked in, so no cache-warmth
  heuristic decides what the teammate sees. Every teammate also runs
  with the general teammate role, appended as its system prompt: it
  reports to its parent, messages the team, waits on reports, can lead
  its own sub-team, links peer hosts, and writes no memory. GC reaps
  only the process, leaving the session file for later resumption.
  When a fork starts, the pi child registers through the same extension.
  `team_wait` actively waits: it blocks until each named teammate
  reports, returning the reports as the tool result. The wait stays
  steerable and interruptible: Escape aborts it through the run's abort
  signal, and a queued user message makes it yield early so the steer is
  delivered at once. A report not consumed by the wait still arrives as
  an ordinary pi-teams message. While it waits the agent is published as
  waiting, so the broker keeps a waiting fork exempt from idle GC.
- **Tools**: the extension exposes `team_ls`, `team_send`,
  `team_spawn`, `team_wait`, `team_attach`, and `team_peer` as agent
  tools. Sending and waiting are member-only, and a teammate may only
  message its own team - to reach an outsider it asks its parent to
  attach that agent; a root is unrestricted. Listing, spawning,
  attaching, and peer linking stay open, so a session can join a team
  and link peers without a shell or raw `ssh`.
- **Awareness**: at session start the extension tells the agent which
  teammates are live, their endpoints, and that `/team send <id> ...`
  is the direct channel. Inbound relayed messages are surfaced to the
  agent as `pi-teams` custom messages, so a teammate can report a
  result back and the parent sees it without polling. Every sent and
  received message also appends a one-line `[pi-teams]` log entry with
  a truncated preview, expandable to the full payload.

## Cross-host peers

Two machines that already have SSH between them can federate their
pi-teams brokers, so an agent on one host spawns a teammate on the other
and messages cross both ways.

- **One-call setup**: `team_peer add <ssh-host>` asks the broker to
  read the peer's loopback endpoint over the existing SSH session and
  own a loopback-bound `ssh -L` tunnel to that broker, then links the
  two brokers. No broker rebinding, no TLS, no manual tunnel, and the
  agent never touches ssh.
- **Remote spawn**: `team_spawn` takes an optional `host`. One spawn
  service routes internally: a host-less or this-host request launches
  the process here, and any other host resolves that host's main agent
  through the same agent directory and asks it to spawn, so the peer
  host owns the process, session, and reaping. The
  caller never branches on local versus ssh, and the teammate reports
  back through the federation. `team_wait` waits for it by id.
- **Bidirectional messaging**: every agent id carries a host label
  (`<host>:pi-...`, `<host>:fork-...`); a message to a peer-hosted id is
  relayed across the peer link (the `team_send` tool or `/team send`),
  and `team_ls` lists the federated agents. An undeliverable target
  reports back. Local `/team send`, `team_wait`, and reports are
  unchanged. A `/team kill` of a peer-hosted id is routed to its host.
- **Lifetime**: a teammate spawned for a remote parent is kept alive
  until the peer link drops, then reaped on its own host by
  connection-based GC. Removing a peer closes its ssh tunnel, and a
  tunnel that dies on its own prunes the broker's link instead of
  pointing at a dead port. Pid signalling never crosses hosts.
- **Durable links**: the broker remembers each peer's SSH target and
  rebuilds the tunnel and broker link when the broker restarts, so a
  reload or restart never leaves the broker pointing at a dead loopback
  port.
- **Password-only hosts**: the peer path is non-interactive, so a host
  that needs a password or has an unknown key fails closed with a
  guided error instead of hanging. The agent then tells the user to run
  one line in their terminal (printed in the error, e.g. `sh
  .../peer-ssh-setup.sh user@host`): it trusts the host key once and
  installs a local key, prompting for the password only. `team_peer
  add` then succeeds unattended.

Usage: on host A run `team_peer add B`, then `team_spawn` with
`host="B"` and `team_wait(id)`. `team_peer remove B` unlinks. The peer
must already run pi-teams; the SSH session supplies confidentiality,
integrity, and host authentication, and only loopback is forwarded.

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
  `global`, no bare `except`, no `var` in the extension, one top-level
  class per source file, and no file over 1200 lines, so a
  responsibility cannot accrete into a monolithic single file.
- **Extension tests** (`tests/extension_test.mjs`): every child launch
  goes through ProcessRunner with `windowsHide` set; `spawnDetached`
  never detaches on Windows, and the persistent broker launches through
  a windowless Python interpreter there; `spawnTask` builds
  the teammate template from a task alone, resolves pi from the running
  runtime, starts the teammate clean without ever forking the parent
  session, and no custom spawn path exists; one spawn service addresses
  a local process or a peer host's main agent; `peerAdd` asks the
  broker to own the ssh tunnel and relays its setup guidance on
  failure; the broker-op
  client carries every request/response call; a pending request resolves
  from its reply, fails on a non-ack, and times out or cancels without
  leaking; every outbound `send` carries this agent's id so a peer's
  reply and a remote fork's parent reach the real agent; a report is
  delivered as a message rather than held by a
  waiter; a teammate may only reach its own team while a root is
  unrestricted; an attach re-registers the session as a fork and
  notifies the parent, an inbound attach request converts the session
  and acks the requester, an already-attached target and a second parent
  are refused, and detach restores a main identity; a
  password-only or unknown host fails
  with the one-line setup guidance and no tunnel; the broker starts
  detached only when absent.
- **Setup-script tests** (`tests/setup_script_test.py`): the user-run
  script's help, argument errors, and `--dry-run` plan; dry-run prints
  the commands and changes nothing.
- **Broker protocol tests** (`tests/broker_test.py`): handshake token
  rejection, endpoint publication, registration and discovery, relay
  delivery, undeliverable reports, deregistration, connection-close
  drop, idle sweep, a waiting fork's exemption from fork idle GC, and
  two-broker federation (cross-host relay both ways, an undeliverable
  remote target, and reaping of remote-parent forks when the parent
  disconnects or its peer link drops).
- **Fork lifecycle tests** (`tests/fork_test.py`): a fork stays alive
  while its parent stays connected and exits on its own when the
  parent's connection closes or an explicit terminate is issued; the
  registry is cleaned in both cases; a `send --id` stamps the caller's
  real id onto the relayed message.

Tests run on isolated roots under `TMPDIR`
(`~/tmp/pi-teams-sandbox`), never the system `/tmp`.

## Deployment

### As a pi package

pi-teams is a pi package: `package.json` declares the extension under
the `pi` key and carries the `pi-package` keyword, so pi can install it
directly.

```
pi install git:github.com/ederevx/pi-teams@v0.4.0
pi install npm:pi-teams          # once published to npm
pi install /absolute/path/to/pi-teams
```

The package ships the broker and client under `src/`, and the extension
runs them from its own package directory (the sibling `src/`), so
`pi install` needs no setup step. Set `PI_TEAMS_BIN` to a directory
holding `teamd`/`team` to override that lookup, or for the manual layout
below. The broker still starts on demand, one per `TEAM_ROOT`.

### Manual install

`scripts/install.sh` copies every `src/*.py` into `$HOME/.local/bin`
(the entries as `teamd` and `team`, the rest as importable modules,
plus `scripts/peer-ssh-setup.sh` as the `peer-ssh-setup` helper),
installs the extension entry and its `pi-teams/` module directory into
the pi agent home extensions dir, and records installed bytes in a
manifest; `scripts/uninstall.sh` removes exactly what was installed.
Files are staged through a same-directory temp file before the atomic
move; the extension module directory is staged whole and swapped in.
On Windows, run both scripts from Git Bash (the shell pi itself uses
there). Restart pi sessions after installing so the extension loads;
the broker starts on demand per session.

```
scripts/install.sh      # install broker, client, and extension
scripts/uninstall.sh    # remove exactly what install.sh wrote
```

Adoption rule: validate on `main` (tests green) and only then install,
never the reverse. Each release tags the validated HEAD and records the
commits since the previous tag in `CHANGELOG.md`.

## Roadmap

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