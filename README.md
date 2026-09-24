# pi-teams

Native cross-pi-agent communication for pi. Every pi session registers
with a local broker and gains an endpoint other agents can reach
directly; spawned teammates are persistent child sessions whose
lifetime is tied to their parent. The extension surfaces the team at
session start, and spawns, waits on, messages, attaches, and reaps
teammates through agent tools — so multiple pi agents coordinate
natively, without a shared filesystem as the channel.

## What it provides

- **Broker** — `src/teamd.py`, composed from `team_broker.py`,
  `team_root.py`, `peer_link.py`, `peer_tunnel.py`, `idle_warning.py`,
  and `peer_transport.py`:
  - Loopback TCP registry and relay on `127.0.0.1`; ephemeral port and
    random token, published atomically at `TEAM_ROOT/endpoint`
    (default `~/.local/state/pi-teams`).
  - Token-gated hello handshake, JSON-lines relay, connection-based
    liveness (no pid probing), registry mirrored to `registry.json`.
  - Per-root broker lock: one broker per root, even when many sessions
    race at startup or the extension reloads.
- **Client** — `src/team.py` over `src/team_client.py`: one persistent
  connection per agent (`team hold`); CLI ops: `register`, `ls`,
  `send`, `follow`, `terminate`, `deregister`.
- **Extension** — `extensions/pi-teams.ts` plus the modules under
  `extensions/pi-teams/`: registers the running pi, holds its
  endpoint open, injects the teammates note before the first run, and
  exposes the tools and the single command below.
- **Tools** (agent-facing; commands are not the interface):

  | Tool | Ability |
  | --- | --- |
  | `team_spawn` | Spawn a named, resumable teammate for one task |
  | `team_wait` | Block for reports (see `team_wait` below) |
  | `team_send` | Message an agent, local or on a linked peer |
  | `team_attach` | Turn a live session into a teammate |
  | `team_detach` | Return an attached session to a main agent |
  | `team_kill` | Terminate an agent by id |
  | `team_ls` / `team_peer` / `team_tail` | List, link peers, tail chat |

  Sending and waiting are member-only; a teammate may only message its
  own team and asks its parent to attach outsiders. The broker enforces
  this itself: message ops carry a per-session send token
  (`TEAM_SEND_TOKEN`, minted by the extension for its hold and each
  teammate), so a raw `team.py send` from a shell cannot speak for an
  agent — it is refused with `send-token`. Read-only diagnostics stay
  open (`team ls`, `team peer list`). The one command is `/team-ls`: a
  settings-style dock of live agents with last-active times. It is
  read-only — acting on a teammate is a tool call.

### Spawn model

- `team_spawn` takes a task (plus an optional name). The extension
  supplies the session, inherits the current model and thinking level,
  and prepends the report-back instruction. The teammate starts clean —
  like a `subagent` delegation, it receives only the task text — and
  runs with the general teammate role (reports, messaging, waiting,
  leading its own sub-team, no memory writes).
- The launch is a headless pi RPC session, not `pi -p`: the extension
  owns it through `child_process`, holds its stdin open, and inherits
  the model, thinking level, and session directory. `pi.exec` is
  deliberately not used: it opens the child's stdin to `/dev/null` and
  drops the `env` option, which would kill the hold and strip fork
  identity.

### team_wait and the hang watchdog

- The wait ends on the first report; other ids keep running and their
  later reports arrive as ordinary messages. Escape or a queued user
  message ends it early; the bound is `timeout`, `PI_TEAMS_WAIT`, or
  300s. A report not consumed still arrives as a message.
- While waiting, the agent publishes `waiting`, which exempts a fork
  from idle GC.
- A teammate silent past the stall bound (`stall` parameter,
  `PI_TEAMS_STALL`, default 90s; 0 disables) looks hung: the wait
  itself sends it a continue-or-report steer once per teammate. Any
  traffic from the teammate — not only a final report — resets the
  stall clock, so a working teammate is never nudged.

### Fork lifetime and GC

Liveness is connection-based everywhere; only forks are ever
signalled, never main agents.

- **Idle GC**: with no work contact for `PI_TEAMS_FORK_IDLE`
  (default 300s), the broker warns before it kills. It leaves the
  teammate a timestamped warning file under the team root
  (`<id>.warn`) and steers it to delete the file. The fork is spared
  while `PI_TEAMS_GC_WARN_GRACE` (default 60s; 0 reaps immediately)
  is open; deleting the file is the working answer and resets the
  idle clock, while leaving it past the grace reaps the fork. A
  busy or waiting hold deletes the file itself. A parent-gone fork
  is warned the same way and reaped when the warning goes
  unanswered. (`PI_TEAMS_GC_PING_GRACE` is still read as a legacy
  fallback.)
- **Work keeps forks alive**: pi's lifecycle publishes busy state
  (`agent_start`/`agent_settled`) and the hold streams it in its
  heartbeat, resetting the idle clock. Any message the fork sends
  counts too, and clears an outstanding warning.
- **Reaping** closes the endpoint, drops the entry, and signals the
  owner pid. A spawned teammate's session file is removed with it;
  attached sessions keep theirs in `/resume`.
- **Busy-file GC** clears stale `.busy` state: a file whose agent is
  unregistered and untouched past `PI_TEAMS_BUSY_GRACE` (default
  120s) is removed; registered agents keep theirs.
- **Session GC** removes teammate-marked transcripts whose agent is
  not live and whose mtime is past `PI_TEAMS_SESSION_GRACE` (default
  1h; `PI_TEAMS_SESSIONS_ROOT` overrides the root). Deletions are
  guarded to the sessions root.
- **Self-restart**: the broker stamps its endpoint with a source hash
  and exits once idle for `PI_TEAMS_RESTART_GRACE` (default 60s) after
  the on-disk source changes, never while agents are live; the next
  start adopts the new code.

### Attach

`team_attach` re-registers a running session under the requester's
fork id. An agent belongs to one team: a target that already has a
parent is refused, and a teammate cannot attach. `team_detach` reverses
it. A spawned teammate's transcript goes with its process; an attached
session stays in `/resume`.

### Awareness

At session start the extension lists live teammates and points at the
tools. Inbound messages arrive as `pi-teams` custom messages with a
triggering turn; every sent or received message also writes a
one-line `[pi-teams]` log entry with a truncated, expandable preview.

## Cross-host peers

Two machines with SSH between them federate their brokers.

- **Setup** — `team_peer add <ssh-host>`: the broker reads the peer's
  loopback endpoint over the existing SSH session, owns a loopback-
  bound `ssh -L` tunnel, and links the brokers. `team_peer remove`
  unlinks; both sides persist the config and rebuild on restart.
- **Remote spawn** — `team_spawn` accepts `host`. One spawn service
  launches locally or asks the peer host's main agent to spawn, so the
  peer owns the process, session, and reaping. `team_wait` waits by id.
- **Messaging** — ids carry a host label (`<host>:fork-...`), so
  `team_send`, reports, and `team_kill` reach peer-hosted ids through
  the same link; an undeliverable target reports back. A local target
  whose connection dropped recently parks the message in a durable
  mailbox instead: the broker delivers it when the target registers
  again, redeliveries carry the original envelope id, and parked
  messages expire after a ttl.
- **Lifetime** — a remote-parented fork lives until its parent's link
  drops, then its host reaps it. Pid signalling never crosses hosts.
- **Password-only hosts** — a non-interactive SSH failure fails closed
  with the one-line setup command to run manually
  (`sh .../peer-ssh-setup.sh user@host`); after that `team_peer add`
  succeeds unattended.

Usage: `team_peer add B`, then `team_spawn host="B"` and
`team_wait(id)`. Only loopback is forwarded; the SSH session provides
confidentiality, integrity, and host authentication.

## Validation

```
python3 tests/run.py
```

Runs on isolated roots under `TMPDIR` (`~/tmp/pi-teams-sandbox`),
never the system `/tmp`. It chains:

- **readme lint** — title, section set, 80-column prose, no tabs or
  trailing whitespace, balanced fences.
- **OOP lint** — no module-level mutable state, no `global`, no bare
  `except`, one top-level class per file, 1200-line file cap.
- **Extension tests** (`node --test tests/extension_test.mjs`) — the
  launch paths (ProcessRunner, `windowsHide`, windowless Windows
  broker, detached-only-when-needed), the spawn template and clean
  context, the wait/steer/stall watchdog, inbox and pending-request
  ownership, member gating and same-team scoping, attach/notify
  flows, and peer-add failure guidance.
- **Broker protocol tests** (`broker_test.py`, `fork_test.py`,
  `attach_test.py`, `setup_script_test.py`) — handshake and token
  rejection, registry and relay, idle sweep and the idle-warning
  courtesy (spared when answered, reaped on silence), waiting-fork
  exemption, orphan sweeps, fork lifecycle with the parent, and
  two-broker federation including remote-parent reaping.

## Deployment

### As a pi package

```
pi install git:github.com/ederevx/pi-teams@v0.4.0
pi install npm:pi-teams          # once published to npm
pi install /absolute/path/to/pi-teams
```

The package ships the broker and client under `src/`; the extension
runs them from its own directory, so install needs no setup step.
`PI_TEAMS_BIN` overrides the lookup. The broker starts on demand, one
per `TEAM_ROOT`.

### Manual install

```
scripts/install.sh      # broker, client, and extension into ~/.local
scripts/uninstall.sh    # remove exactly what install.sh wrote
```

Installs `src/*.py` as `teamd`/`team` plus importable modules, the
extension into the pi agent home, and a byte manifest;
`uninstall.sh` removes exactly that manifest. Writes are staged
through same-directory temp files and moved atomically. Run from Git
Bash on Windows. Restart pi sessions after installing.

Adoption rule: validate on `main` (tests green), then install — never
the reverse. Each release tags the validated HEAD and records the
commits since the previous tag in `CHANGELOG.md`.

## Roadmap

- **Task routing**: kind-based delivery (task/result/notice) with
  acknowledgement and retry.
- **Broker upgrades**: spooling for offline recipients, authenticated
  roots, and a tighter spawner tie so forks reap promptly when the
  spawning pi dies hard (currently bounded by the heartbeat sweep)
  without pid probing.

## Attribution

- Original work; no upstream code is imported. Messages are JSON
  envelopes over `TEAM_ROOT/endpoint`, relayed by the broker.

## License

MIT, see LICENSE. © 2026 Edrick Sinsuan.
