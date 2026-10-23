# Music Fleet v8.3.6

## Additional recovery edge case

- When the bot itself returns to its assigned voice room, the room-membership check now arms the empty-room timer if the last human-leave event was missed during a gateway outage. A human already present in the channel cache clears the empty timer.
- The 10-minute stop still waits for a ready, stable connection in the exact assigned room, checks the current human-member cache at expiry, and defers while voice recovery is active.
- A bot entering the room does not count as a human. A human joining cancels the timer.
- Existing v8.3.5 fixes remain: single-flight voice recovery with backoff, strict assigned-room verification, current-track panel retry ownership, separate per-bot playback state, owner activity default `By ! A`, and room-scoped Discord/Web Player controls.

## Validation scope

- Local fake-client tests cover missed leave events detected when the bot returns, bot-versus-human membership, expiry-time membership recheck, outage deferral, recovery retries, exact room validation, panel delivery retries, 50 isolated room routes, and 50-client activity application.
- No live Discord token or voice connection was used. These checks do not prove real Discord availability, unlimited fleet size, or months/years of unattended uptime.
