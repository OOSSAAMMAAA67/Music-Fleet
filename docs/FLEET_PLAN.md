# Music Fleet Implementation Plan

Implementation checklist for the v8 archive. Verification evidence is recorded in docs/VERIFICATION.md.

**Goal:** deliver one music source that manages 1–100+ independent bot accounts with shared per-user libraries and one web service.

**Architecture:** FleetManager manages client/player pairs and durable placements. Request/event-local routing selects a bot; user stores and expensive auxiliary services are shared.

**Tech stack:** Node 22.16+ (series 22) or Node 24+, existing CommonJS discord.js / @discordjs/voice / FFmpeg / yt-dlp, Node SQLite and worker threads.

**Spec:** docs/FLEET_DESIGN.md.

## Global constraints

- Preserve public music, lyrics and platform features.
- Use one process and one web listener; give voice connections a distinct group per bot.
- Owner-only commands must produce no reply or reaction for unauthorized users.
- No account secrets in test output or the final template.
- Tests may simulate Discord, but must distinguish simulation from real audio verification.

## Review focus

- Newer placement wins over old disconnect/reconnect events.
- Old web links and overlapping requests cannot mutate another bot's queue.
- A failed login/repair/store write must not stop the other bots or discard saved data.
- Stable bot identity survives token-list reordering and account restart.
- Bounded cache/concurrency behavior remains bounded with 100 bots and 100000 users.

## Task 1: Fleet control plane and configuration

Files: utils/fleetConfig.js, utils/fleetState.js, utils/fleetManager.js, scripts/fleet-manager-test.js.

Interfaces: loadBotDefinitions(config, {env,baseDir}) → definitions[{key,token,main}]. FleetManager({definitions,createClient,createPlayer,state,rootOwnerIds,config,logger}); records, controlClient(), recordFor(key/id), recordForClient(client), start(), onReady(client), place(key,guildId,voiceId,textId), release(key,guildId), distribute(guildId,voiceIds), repairBot(key), restartBot(key), resolveForVoice(guildId,voiceId), resolveSession(session), status(), isOwner(id), isRootOwner(id), close(). FleetState exposes getPins(), setPin(pin), removePin(key,guildId), listOwners(), addOwner(id), removeOwner(id), getPrefixes(), setPrefix(guildId,prefix), flush().

- [x] Write behavioral tests for configuration, placement/release/restart durability, unauthorized ownership, duplicate room assignment, login isolation and 100 fake clients; observe missing-feature failures.
- [x] Implement the modules with serialized pins, paced logins/joins, token redaction and isolated recovery.
- [x] Run `node --test scripts/fleet-manager-test.js`; expected all pass.

## Task 2: Indexed shared storage

Files: new SQLite worker/database/adapters and storage tests; modify only favoritesStore.js, historyStore.js, playlistsStore.js, platformStore.js export selection and the storage adapter modules.

Interfaces: existing default store APIs stay compatible; original exported constructors retain file-backed test compatibility. Export closeSharedStorage() and backupSharedStorage(destination) from the new database module. Defaults use shared data/ databases; normalized listening-event updates are idempotent and incremental. Worker/storage errors reach callers; migration retains originals.

- [x] Write tests for concurrent writes, per-user isolation, lazy migration, interrupted/repeated event writes, close/reopen durability and 100000 indexed users; observe failures.
- [x] Implement SQLite WAL with prepared statements, bounded queues/caches and asynchronous operations where APIs permit.
- [x] Run the new storage suite and inherited storage/durability tests; expected all pass.

## Task 3: Player, message and owner integration

Files: index.js, handlers, events, commands, utils/playerContext.js, utils/fleetRouting.js, utils/musicPlayer.js, config.js.

Interfaces: runWithClient(client,fn), getPlayer(client), context-bound legacy _player; client.fleet/client.player/client.botKey. MusicPlayer({group,platform}) gives every connection its group and close() removes timers/resources. Fleet owner methods from Task 1 are the only placement path.

- [x] Write routing/isolation/authorization tests plus same-guild grouped voice regression before implementation.
- [x] Integrate the factories, context and player groups; remove channel-lock behavior; add silent authorization, owner commands, dynamic help, persistent prefixes and private web command.
- [x] Run routing/voice tests and existing interaction, playback, recovery, audio tests; expected behavior preserved except documented owner-only placement changes.

## Task 4: One shared web service with per-request targets

Files: utils/webPlayerServer.js, web/app.js, web/index.html and new HTTP concurrency tests.

- [x] Write real local HTTP tests for 100 overlapping bot requests, cross-room authorization, old-link room-following, shared library, and concurrent lyrics isolation; observe failures.
- [x] Add request-local runtime resolution, signed originating bot identity, live membership checks and a concise room/bot indication in the existing UI.
- [x] Run HTTP/platform/lyrics regression tests; expected all pass.

## Task 5: Runtime budgets, verification and package

Files: configuration budgets, start scripts/PM2 config, backup/check scripts, docs and outputs.

- [x] Test resource limits and invalid runtime configuration before changes.
- [x] Adjust fleet buffer/progress/prefetch/extraction limits; preserve high quality and bounded shutdown.
- [x] Run inherited `review` checks, new fleet suites, cardinality/load simulations and dependency preflight. Save exact counts, timings and limitations.
- [x] Request an independent whole-source review, fix substantive findings with reproducing tests and rerun affected suites.
- [x] Build sanitized final ZIP and inspect its contents, config, documentation, lockfile and absence of credentials/intermediate files.
