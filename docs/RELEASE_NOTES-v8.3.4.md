# Music Fleet v8.3.4

## Voice outage recovery

- Voice reconnect signals from the health monitor, Discord voice events, and fleet room pins now share a per-queue single-flight join lane. Concurrent events cannot start overlapping `join()` calls for one bot/guild queue.
- A signalling or connecting voice connection is retained while its gateway handshake is active. A stuck handshake is refreshed only after the configured wait interval; normal transient retries use jittered exponential backoff capped by `REJOIN_MAX_DELAY` and continue indefinitely when `REJOIN_MAX_TRIES` is zero.
- The current track, playback intent, and last consumed position are retained on disconnect. DNS, socket, timeout, and voice readiness failures during recovery no longer mark that recording as a failed track or consume it. The player waits for the next serialized recovery attempt and resumes at the saved position.
- Recovery logs are limited to the start/restoration of an outage and a warning no more than once per minute per queue. Voice state transition logs are rate-limited.

## Now-playing panels

- Every successful playback startup now asks its own `MusicPlayer` queue to publish or update the public panel. This also covers tracks restored by automatic next-track and recovery paths.
- Panel send/edit work is serialized per queue. A lightweight card with controls is sent before artwork generation; the existing animated visual can upgrade it afterward. Discord delivery errors schedule quiet exponential-backoff retries rather than silently losing the panel.
- Commands reuse the same panel publisher and keep the text destination attached to the active room or the fleet's pinned text room. A bot's queue and panel remain separate from the other bots in the fleet.

## Empty-room stop

- When the assigned voice room becomes empty of human members, a per-queue ten-minute timer starts. A human joining cancels it. At expiry, the channel membership and voice connection are checked again before playback and the abandoned queue are cleared.
- If the Discord client or voice connection is not ready, the timer waits and rechecks instead of trusting stale cached membership. The bot remains connected to its assigned voice room.

## Compatibility and data

- Existing shared libraries, history, favorites, playlists, web state, bot tokens, channel assignments, and user configuration are preserved by the release builder. The new behavior uses defaults in source and does not rewrite the existing `config.js`.
- Node.js compatibility remains Node 22.16+ in the 22 series or Node 24+.

## Validation scope

- Local fake-client regressions cover concurrent join/reconnect signals, transient DNS recovery, panel isolation/delivery retry, ten-minute timeout behavior with a shortened test clock, and cancellation when a member returns.
- The package is not logged into Discord during tests. These simulations do not prove live Discord voice service availability, all real bot tokens, or months/years of unattended operation.
