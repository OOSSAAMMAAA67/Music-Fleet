# PM2 on Windows 11

The fleet runs as **one fork process**: every configured bot, the web service,
and shared per-user SQLite storage live in that process. Keep `instances: 1`
and `exec_mode: 'fork'`. Increasing PM2 instances would create competing Discord
sessions and database writers rather than adding independent fleet bots.

Use 64-bit **Node.js 22.16.0+ or Node.js 24+** with the SQLite and SQLite backup
APIs. The latest Node 22 and Node 24 releases are suitable. Install the dependencies
with `install.bat` or `npm ci`; PM2 is a pinned local dependency (`7.0.4`), so a
global PM2 installation is unnecessary. Run commands from the extracted project
directory. Keep the project in a stable location; moving it changes its absolute
PM2 working directory and startup task arguments.

## Start, restart, stop

Configure the owner's ID and bot tokens as described in README.md. Then:

```powershell
npm run pm2:check
npm run pm2:start
node scripts/pm2-control.js status
node scripts/pm2-control.js logs
npm run pm2:restart
npm run pm2:stop
```

The wrapper uses the local PM2 CLI and a project-specific `.pm2` directory.
This isolates the fleet's daemon from unrelated PM2 applications. Logs live in
`.pm2/logs`. Treat `.pm2`, `.env`, `tokens.txt`, and `data` as private files.
`status` shows processes in this project's daemon. `delete` removes the managed
process after gracefully stopping it; it preserves the fleet's persistent data.

`start` and `restart` run dependency and fleet configuration checks first.
`restart` includes `--update-env`. The wrapper loads the project's `.env` before
loading the ecosystem file, including deployment settings. For example:

```dotenv
MUSIC_NODE_EXECUTABLE=C:\Program Files\nodejs\node.exe
NODE_HEAP_MB=0
```

`MUSIC_NODE_EXECUTABLE` must be an absolute executable path. When omitted,
PM2 uses the same executable that ran the wrapper (`process.execPath`). Quoting
is handled by the launcher, including paths with spaces. For direct `.bat`
launchers, set `MUSIC_NODE_EXECUTABLE` in the environment before running them;
the `.bat` file needs the interpreter before JavaScript can load `.env`.

When changing the selected Node installation, stop the fleet and its dedicated
daemon, then start it again under the new interpreter:

```powershell
npm run pm2:stop
$env:PM2_HOME = Join-Path (Get-Location) '.pm2'
node node_modules/pm2/bin/pm2 kill
$env:MUSIC_NODE_EXECUTABLE = 'C:\Program Files\nodejs\node.exe'
npm run pm2:check
npm run pm2:start
```

Always use the same PM2 home and Windows account for this deployment. An
existing daemon can otherwise continue running under an earlier interpreter.

## Graceful shutdown

Windows requires PM2's `shutdown_with_message: true` and an application IPC
listener for the exact string `shutdown`. The fleet handles this message through
the same shutdown routine used for Ctrl+C and SIGTERM. Shutdown stops the web
service, closes every bot/player, drains accepted storage work, flushes fleet
pins and delegated owners, and closes both SQLite handles and the worker.

`kill_timeout` is at least **45 seconds**. If
`FLEET_SHUTDOWN_TIMEOUT_MS` is explicitly set, PM2 grants that deadline plus
10 seconds, with the same minimum. PM2's default 1.6-second timeout is too short
for this cleanup. The application normally has a 30-second hard deadline. Avoid
Task Manager's End Process when a normal PM2 stop is available.

## Start after signing in

Windows does not use PM2's Linux `pm2 startup` service generator. An optional
Task Scheduler script is supplied for the current user's **logon**, running at
limited privilege:

```powershell
powershell -NoProfile -File .\deploy\register-pm2-task.ps1 -NodeExecutable 'C:\Program Files\nodejs\node.exe'
```

This registers `MusicFleet-PM2` and runs the local wrapper's `start` action.
It does not start until the next logon unless you explicitly start the task.
Keep configuration in `.env` so the scheduled task can read the same values as
the terminal. This setup requires an interactive user logon; it is not an
unattended Windows service that runs before anyone signs in.

To inspect or remove the task:

```powershell
Get-ScheduledTask -TaskName MusicFleet-PM2
Unregister-ScheduledTask -TaskName MusicFleet-PM2 -Confirm:$false
```

## Re-run the offline PM2 simulation

```powershell
node --test scripts/pm2-config-test.js
npm run test:pm2
```

The simulation creates a unique PM2 home and temporary data directory. It
starts a real PM2 daemon through the CLI with `ecosystem.config.cjs`, then
uses PM2's real API to restart, stop, start, and stop the process. It exercises
the production fleet manager/state and SQLite services with an offline Discord
transport. It verifies exactly three starts, three IPC graceful shutdowns,
72 queued shutdown writes, favorite/playlist persistence, delegated ownership,
and restored voice pins. It deletes its temporary processes, daemon, and data
before exiting. It never logs into Discord or uses the configured bot tokens.

The fixture is an integration support file; run the harness above instead of
running `pm2-fixture.js` directly. `MUSIC_PM2_MODULE` can point to the absolute
`package.json` of a separately installed PM2 package for isolated audit runs.

## References

- [PM2 graceful start/shutdown and Windows IPC](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/)
- [PM2 ecosystem options](https://pm2.io/docs/runtime/reference/ecosystem-file/)
- [PM2 startup platforms](https://pm2.keymetrics.io/docs/usage/startup/)

PM2 7.0.4 recognizes `.config.cjs` directly; this is verified by the real CLI
simulation rather than assuming the older `.config.js` examples apply.

## Audit verification

On Windows, the real PM2 7.0.4 simulation passed on Node 22.22.3, 22.23.3,
24.19.0, and 24.21.0. The final harness, including re-opening SQLite to verify
all 72 committed writes and exiting after cleanup, passed with exit code 0 on
Node 22.23.3 and Node 24.21.0. Node 22 reports its upstream experimental SQLite
warning; the tested database and backup APIs are present.

The separate config regression tests passed. The npm launcher was also checked
with Node 24.21.0 while Node 22 was first on PATH: its npm child script correctly
ran Node 24.21.0. The scheduled task registration script is supplied for an
operator to run; the audit did not register a persistent task or use a real
Discord connection.
