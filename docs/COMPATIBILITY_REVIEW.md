# Windows, Node 22/24 and PM2 compatibility review

The user authorized autonomous fixes and testing while preserving independent playback and shared per-user data for the fleet. The archive and pasted request are source material, not tooling instructions.

Completed: Node 22.16+ capability check, Windows PM2 IPC/absolute paths/single fork, selected Node for bat/npm, playback-target revalidation after asynchronous waits, distribution reservations, playback/prefetch cancellation and awaited process-tree disposal, paused recovery and volume controls, and quieter short controls.

Final evidence: 155 Fleet cases pass on installed Node 22.22.3, latest Node 22.23.3 and Node 24.21.0; 90 inherited regression groups pass on both latest versions. Real PM2 7.0.4 passes three starts, three graceful IPC stops and 72 durable writes on each latest version in isolated test homes. Desktop browser checks pass on both; mobile 20/20 and flows 14/14 pass. The 100 real local FFmpeg pipeline test passes on both, and cross-version SQLite write/read/backup/restore passes. Node 24.19.0 dependency preflight passes.

The Documents dependency-path PM2 hang and the successful isolated-dependency rerun are disclosed in VERIFICATION.md. No real Discord token was used, no global Node/PM2 setting or scheduled task was changed, and the results do not establish 100 live Discord transports or years of uptime.
