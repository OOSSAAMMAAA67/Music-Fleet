# Music Fleet v8.3.5

## Deep review fixes

- A ready voice connection is accepted as recovered only after the bot's cached voice state confirms the exact assigned voice room. A missing or mismatched channel state triggers the serialized join/recovery path instead of being treated as a successful recovery.
- A delayed empty-room stop rechecks the bot's assigned room, the Discord client, connection readiness, current human membership, and pending recovery state. It waits for voice state to remain stable after reconnect before stopping, and never stops while a human is present in the channel cache.
- A second bot entering an otherwise empty room no longer cancels the 10-minute stop timer. A human returning cancels it immediately.
- Now-playing delivery retry ownership follows the current track. A failed old panel attempt cannot block or replace the retry for a newer track.
- The owner activity default remains `By ! A`; the old `-help | الموسيقى` activity is not restored.
- Per-bot/per-room command routing, Discord controls, Web Player authorization, and shared user libraries remain as in v8.3.4. Playback queues, voice connections, panels, and current tracks remain independent.

## Validation

- Local regression checks passed for 50 isolated bot/room routes, voice/text pairing, mentioning another bot, silent wrong-room command/component handling, 50-client activity application, concurrent recovery signals, a transient DNS retry, preservation of the current track, exact pinned-room verification, separate panels, panel-send failure and newer-track retry, other-bot exclusion, the 10-minute empty-room timer using a shortened test clock, and human-return cancellation.
- JavaScript syntax checks passed for the changed player, voice-state handler, and regression harness.
- No live Discord token or voice connection was used. These local simulations do not prove Discord availability, all real bot permissions, unlimited fleet size, or months/years of unattended uptime.
- The release builder verifies every ZIP CRC, all manifest hashes, and exact preservation of the supplied `config.js`, `tokens.txt`, and `data/` files.
