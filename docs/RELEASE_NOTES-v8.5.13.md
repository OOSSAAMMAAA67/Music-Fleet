# Music Fleet v8.5.13

- Restores voice-room playback routing to the exact saved voice/text-channel pair from the v8.5.11 baseline. No cross-channel playback permission change is included.
- Keeps ordinary `ش` requests from any member in the assigned room on the shared queue while a track is active. `ش_الان` remains the explicit replace-current command; `وقف` remains available to members routed to that room.
- Makes queue confirmation independent from the now-playing card refresh. If Discord rejects the confirmation reply after a track has been queued, the bot acknowledges the successful queue operation with ✅ rather than incorrectly reacting ❌.
- Release contents are based on v8.5.11. Saved fleet/configuration/token data is retained; only favorites data, dependencies, and development/test artifacts are excluded.
