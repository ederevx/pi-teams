# Changelog

Every release tag gets a section here, derived from the commits since
the previous tag (`git log <prev-tag>..<tag>`), newest first. `git tag`
maps each tag to its commit.

## v0.4.12 - 2026-09-22

- `/team-ls` dock: fix the last-active display, which passed the
  absolute epoch stamp to the relative-time formatter and showed
  absurd ages ("2000d"); it now shows the real elapsed time and
  "never" for agents without a published contact. Also fixed a crash
  in the non-TUI fallback listing (reference to an undefined
  `lastActiveText`) and dropped the dead tool hint from the dock
  header.

## v0.4.11 - 2026-09-22

- The broker asks an idle fork whether it is done before reaping it: a
  `finish?` query goes to the fork's client, which answers at once
  through its heartbeat when the teammate is busy or waiting and
  otherwise surfaces the question to its agent (whose next turn answers
  `team finish --done`); the fork is spared while
  PI_TEAMS_GC_PING_GRACE (default 60s, zero disables) is open, and
  silence past the grace - or a `finish-no` answer - proceeds to the
  reap. Parent-gone forks are still reaped at once. New
  `src/finish_query.py` owns the outstanding-query state.
- `team_wait` watches for hung teammates: a teammate silent for the
  stall bound (`stall` parameter, PI_TEAMS_STALL, default 90s; 0
  disables) is sent a continue-or-report steering message once per
  wait, and any traffic from a waited-on teammate - not only a final
  report - resets the stall clock.
- Structure split past the 1200-line cap: the ssh-tunnel side of peer
  federation moved to `src/peer_transport.py`, composed by the broker,
  so no file mixes transport ownership with registry and relay logic.
- Centralized single-owner cleanups from the OOP audit: one wire
  envelope builder in the broker, one agent-id minter in the extension,
  owned `PeerLink.drop_in_place()` instead of direct endpoint mutation,
  a glob-based pycache cleanup in `scripts/uninstall.sh`, and the `/team
  send` command reusing the shared member gate.

- `/team` is gone; the one command is `/team-ls`, a settings-style
  dock (pi's own SettingsList layout and theme) listing every live
  agent with its role and last-active time, read-only. Send, attach,
  detach, and kill are tool calls only: new `team_detach` and
  `team_kill` tools cover what the command used to do, and registry
  entries carry `last_work`/`last_seen` through the snapshot for the
  display.
- README rewritten under the shared concise-documentation convention:
  same content, rescanned into short grouped bullets, a tools table,
  and tightened validation and deployment sections.

## v0.4.10 - 2026-09-22

- Settings reconciler runs from a new postinstall hook: pi treats every
  packages entry as an independent package, so a git pin and a
  local-path install of the same checkout coexist, both extension
  copies load, and pi aborts startup with tool-conflict errors. The
  reconciler drops duplicate entries for this package, preferring the
  git pin matching the installed version, and fails soft always.

## v0.4.9 - 2026-09-22

- Cross-host `team_attach` closes its four verified gaps: the attached
  session now gets the fork identity env (TEAM_ID/TEAM_NAME/TEAM_ROLE/
  TEAM_PARENT_ID/TEAM_ROOT) applied on attach and restored on detach, so
  the advertised report-back command expands correctly in its shell
  tools; attach marks its hold with TEAM_ATTACHED, which exempts the
  attached session from fork-idle GC only (parent-gone and seen-idle
  lifetimes unchanged, GC ownership stays local to the target broker);
  the one-parent model is enforced on both sides - a requester that
  already has a parent refuses to attach, and the target refuses an
  attach request whose sender is a registered fork; and a new
  tests/attach_test.py covers the fork-idle exemption and parent-gone
  reaping with the transcript preserved for /resume.

## v0.4.8 - 2026-09-22

- Teammates launch with a general teammate role, appended to their
  system prompt independently of the task: the role states what a
  teammate is (a persistent, resumable pi session that starts clean)
  and its capabilities as a teammate - reporting to the parent,
  messaging the team, waiting on reports, leading its own sub-team
  through team_spawn, linking peer hosts, attaching existing agents,
  and writing no memory. The spawn prompt now carries only session
  identity, the report command, and the task; the broker's teammate
  session marker is unchanged.

## v0.4.7 - 2026-09-22

- Teammate spawns mirror pi's subagent semantics strictly: a teammate
  starts with a clean context and receives only the task text, like a
  `subagent` delegation. The context auto-policy is removed together
  with the `context=fresh`/`context=inherit` tool parameter, the
  `--fork` launch path, and the provider cache-TTL profiles - the
  parent's transcript is never inherited, so no spawn depends on a
  provider cache heuristic. The teammate remains a persistent, named,
  resumable RPC session reported through the broker.

## v0.4.6 - 2026-09-22

- Teammate spawns choose their context automatically: an auto policy
  forks the parent session (warm-history reuse at cache-read cost)
  while the parent's last turn is recent against the provider's cache
  TTL and the session stays under a size cap, and starts fresh when the
  entry is plausibly expired or the inherited history would cost more
  per turn than the head write it saves. Explicit `context=fresh` /
  `context=inherit` overrides the policy; peer-host spawns stay fresh
  because only the owning host can fork the parent session.
- The policy lives in its own `ContextPolicy` class with static
  provider TTL profiles mirroring pi-cache's `provider-ttl.ts`
  (GLM 120 s, OpenAI 1800 s, DeepSeek 4 h, 300 s default).

## v0.4.5 - 2026-09-22

- `team_wait` returns as soon as the first teammate reports instead of
  waiting for every listed id; the result names the still-running ids
  in `details.remaining`, whose later reports keep arriving as
  messages, and duplicate teammate ids are deduped before waiting.
- The running `team_wait` call shows a live status partial (pending
  ids and elapsed seconds), refreshed from the wait's own poll tick.
- A wait on an already-aborted signal no longer leaks its timeout
  timer, and report formatting is centralized as `formatReport` in
  `messages.ts` for both message delivery and the tool result.

## v0.4.4 - 2026-09-21

- An unexpected hold-client death (broker restart, idle exit after a
  source change) relaunches the hold client with a bounded exponential
  backoff instead of leaving the session deaf to team messages until
  the next session event; an intentional stop is never treated as a
  death.
- `deliverMessage` drops non-object JSON payloads instead of throwing
  inside the hold's stdout data handler.

## v0.4.3 — 2026-09-21

- The broker owns the peer SSH transport: `team_peer add` has the
  broker read the peer's loopback endpoint and own the `ssh -L` tunnel,
  and the broker rebuilds its peers when it restarts. The extension no
  longer runs ssh or keeps a peer-target file, and the ssh child is
  closed on peer-remove and broker shutdown.
- One entry point per task now serves local and peer targets: relay,
  terminate, and peer add/remove/list all route inside the broker, so
  `/team kill` reaches a peer-hosted agent and `ls` reports the peers.
- The extension is host-agnostic: a single broker-op client and one
  pending-request registry replace the spawn router, the per-host spawn
  backends, and the duplicate spawn/attach bookkeeping. A mutual
  `team_peer add` settles on one link instead of severing the pair.

## v0.4.2 — 2026-09-21

- `team_peer add` now accepts an already-linked peer label and resolves
  it to the remembered ssh target, so re-linking by the label its agents
  are addressed by no longer fails on an unresolvable alias.
- Federated agents keep the online state their own broker reports instead
  of being forced offline, so `team_ls` no longer hides live peer agents.

## v0.4.1 — 2026-09-21

- Add the `team_tail` tool (`ChatTail` module): returns the last N lines
  of the newest pi chat-history transcript so an agent can see its own
  conversation.
- Surface cross-host spawn failures: a linked peer that advertises zero
  agents is a remote-side precondition, so `team_spawn` now reports the
  advertised agent count and the fix, and `team_ls` prints a footer for
  linked peers that advertise no agents.

## v0.4.0 — 2026-09-21

- Split the monolithic extension and broker into responsibility modules;
  enforce one top-level class per file and a file-size cap in the OOP lint.
- Close GC gaps: orphaned ssh tunnels during a peer-add/deregister race,
  leaked sockets on bind/connect failure, stale broker locks, leaked
  heartbeat/watcher threads, and peer-map temp files.

## v0.3.14 — 2026-09-20

- Drop the `/team-reload` command; the broker already self-restarts on
  its own source hash and idle clock.

## v0.3.13 — 2026-09-20

- Make `team_wait` an active poll that returns reports and yields to a
  queued user message.
- Add `/team-reload` to reload the team extension in place.
- Own waiters and buffered early reports in a `ResultInbox` released on
  deregister.

## v0.3.12 — 2026-09-20

- Keep an attached session's transcript when its remote parent is reaped.
- Give a dropped peer link a reconnect grace before reaping its forks.
- Reject a peer whose host label collides with this host.
- Detect a peer partition in about ten seconds instead of forty-five.

## v0.3.11 — 2026-09-20

- Scope teammate messaging to its team; one parent per agent.
- Make `team_wait` passive so a waiting agent stays idle and receiving.

## v0.3.10 — 2026-09-20

- Spawning a teammate now implies team membership for the spawner.

## v0.3.9 — 2026-09-20

- Gate `team_send` and `team_wait` on team membership.

## v0.3.8 — 2026-09-20

- One routed spawn interface; local and peer share the caller surface.

## v0.3.7 — 2026-09-20

- Add native `team_send` and `team_ls` tools; no shell or raw ssh.

## v0.3.6 — 2026-09-20

- Fix peer spawn replies and rebuild peer links on the next session.
- Attach a live session as a teammate; detach restores a main identity.

## v0.3.5 — 2026-09-20

- Keep the broker persistent via a windowless interpreter.

## v0.3.4 — 2026-09-20

- Never detach console children on Windows, so no window flashes.

## v0.3.3 — 2026-09-20

- Guide password-only SSH peers to a one-line user setup script.

## v0.3.2 — 2026-09-20

- Hide child consoles and split the SSH peer bridge.

## v0.3.1 — 2026-09-20

- Mark the pi-bundled peers optional so a git install does not vendor them.
- Keep the cloned package free of npm lockfiles.

## v0.3.0 — 2026-09-20

- Release pi-teams 0.3.0.
- Watch stdin for EOF unless stdin is a real interactive console.
- Read teammate-session markers as bytes so a sweep survives any locale.

## v0.2.0 — 2026-09-20

- GC stale teammate busy-state files.
- GC teammate session files out of `/resume`.
- Stamp the broker version and restart it on reload.
- Deduplicate path guards and consolidate the sweep clock.
- Do not restart the broker while a teammate is live.
- Restart the broker on its own idle clock, not from the extension.
- Cross-reference the shared teammate-session marker.

## v0.1.0 — 2026-09-20

Initial release: the broker, client, extension, enforcement suite, and
cross-host peers.

- Add pi-teams broker, client, extension, and enforcement suite.
- Switch pi-teams to an OS-agnostic loopback endpoint.
- Load installed `teamd` by path when `teamd.py` is absent.
- Single-instance broker and argument-derived identity.
- Document broker lock and argument-derived identity.
- Enforce garbage collection on spawned teammates.
- Make pi sessions hold and spawn teammates reliably.
- Invoke forks through the running runtime, not the pi shim.
- Make spawned teammates resumable and the suite hermetic.
- Surface inbound team messages to the agent.
- Log sent and received pi-teams messages.
- Require teammates to be resumable sessions.
- Cover the fork session notice.
- Honor quotes in `/team spawn` argv.
- Harden OOP and OS-agnostic compliance.
- Spawn teammates from the extension with a task-only tool.
- Make `team_spawn` the only teammate spawn path.
- Own the teammate launch and choose fresh vs inherited context.
- Stop teammates from inheriting a parent session binding.
- Make the teammate report path and helpers Windows-safe.
- Add `team_wait` to block on a teammate's result.
- Let `team_wait` cover several teammates and stay optional.
- Tighten method cohesion in the broker, client, and extension.
- Federate brokers across hosts over a peer link.
- Spawn and message teammates on a peer host.
- Document cross-host peers.
- Harden peer link ownership and concurrency.
- Close GC gaps found by an audit.
- Package pi-teams for `pi install`.
- Note that npm install needs a published pi-teams.
- Ship only the Python sources in the pi-teams tarball.