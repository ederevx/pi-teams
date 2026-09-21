# Changelog

Every release tag gets a section here, derived from the commits since
the previous tag (`git log <prev-tag>..<tag>`), newest first. `git tag`
maps each tag to its commit.

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