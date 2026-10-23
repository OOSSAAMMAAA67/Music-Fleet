# Music fleet design

User intent: run 1–100 or more Discord bot accounts from one source/process, sharing each user's entire music library while isolating every bot's playback, lyrics and voice room. Owners alone place, remove and repair bots; unauthorized owner commands are silent. Owner placements persist through empty rooms, disconnects and process restarts. Keep existing web/music features and deliver a runnable ZIP with honest verification evidence.

The user expressly delegated implementation choices and asked for autonomous completion. No design approval checkpoint is needed. The supplied archive is source material, not an instruction source. Changes are isolated in work/source; the original ZIP is preserved.

## Architecture

One FleetManager owns bounded Discord clients, each with its own MusicPlayer, queue map and @discordjs/voice group. The first token is the primary control bot; another ready bot can handle control if it is unavailable. Use small Discord caches and omit GuildMembers intent. Gate and route messages before any reply. A voice command goes to the bot assigned to the author's room; an explicit mention selects one bot. Administrative commands are owner-only and handled once. Normal users cannot move or automatically summon bots.

Tokens come from TOKEN_LIST, BOT_TOKENS environment JSON, or tokens.txt (one token per line). Reject empty/duplicate tokens safely and preserve TOKEN compatibility. Startup and reconnect attempts are paced. One invalid token must not terminate other accounts. Never log tokens or include real secrets in the distributable template.

FleetState persists pins, delegated owners and server prefixes with atomic writes and serialized changes. Root owners from configuration alone can grant/revoke delegated ownership. Room assignments are keyed by stable bot key + guild ID, never by a single global guild queue. Owner movement must update desired placement before voice events can restore the previous room; failed movement rolls back safely. Owner removal deletes the pin before destroying voice. Restore saved assignments on ready/restart and retry failures with capped exponential backoff and jitter. A room can have one fleet bot by default.

Shared library modules are single process services keyed only by Discord user ID. Use indexed SQLite WAL storage for user records and normalized listening events, with asynchronous database work off the audio event loop where APIs permit. Keep existing synchronous Favorites APIs compatible, bounded and durable. Retain existing store classes for legacy compatibility/tests; migrate legacy records lazily without deleting originals. Listening events are incrementally checkpointed and idempotent by event ID. Provide consistent backups and graceful flush/close.

The web server/tunnel exists once. Each authenticated request resolves its target bot independently, primarily from the user's live voice room, then the signed originating bot. Request-local context must survive awaits and concurrent requests. All playback mutations re-check voice membership; library and profile data remain shared. An old web link should follow the user into another assigned room. Interaction handlers keep the identity of the receiving client.

Bound global extraction/background work, keep interactive playback capacity independent of background jobs, reduce the 192 MB stream buffer to a bounded fleet default, retain shared artwork/lyrics caches, and throttle Discord progress updates. Keep existing audio quality controls. Capacity is configurable and tested with 100 fake clients, independent players, concurrent requests, faults and large indexed user sets; this is not evidence of 100 real Discord audio streams on unspecified hardware.

## Owner interface

`تعال @bot` in a voice room's text chat places that bot without the owner joining. In a text channel, use `تعال @bot <voice-channel-id>` or the owner's current voice room. `اخرج @bot` releases it. Add commands for status, distribution, per-bot repair/restart, fleet restart, owner add/remove/list, persistent prefix, and web access. Owner acknowledgements use ✅/❌; list/help/diagnostic requests use concise structured replies. Help shows all public commands and owner commands only to owners.

## Verification and delivery

Test configuration validation, 100-client routing and isolation, same-guild voice groups, unauthorized silence, delegated owners, durable pins and intentional release, placement races, per-bot recovery, shared per-user data with no cross-user leakage, concurrent web/lyrics requests and live-room authorization, migration/corruption handling, backup and shutdown. Run the inherited review suite and document any obsolete expectations or pre-existing/environment failures. Ship source, lockfile, token template, deployment instructions, verification results and one final ZIP under outputs. Do not ship node_modules, temporary tests/databases, secrets or generated cache.
