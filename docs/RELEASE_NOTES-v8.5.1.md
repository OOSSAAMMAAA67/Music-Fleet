# Music Fleet v8.5.1

## Web discovery responsiveness

- The For You page now uses a small personalized first-render profile and then warms the deeper artist, related-artist, and genre candidate profile in the background. Completed enrichment is cached by user and profile revision; catalog facts remain safely reusable.
- Fresh release-tracklist lookup is limited to a relevance-ranked, artist-diverse sample of six albums. Discovery requests carry one shared deadline, and they skip album-version expansion that is only needed on the explicit album-detail page.
- The shared catalog scheduler now has a bounded FIFO queue, configurable concurrency/queue limits for service integrations, and a finite wait deadline. Overflow and expired waiters return a retryable degraded-provider result instead of accumulating indefinitely.
- Temporary scheduler pressure and empty failed catalog responses are not retained as long-lived discovery cache entries.
- Provider deadlines now flow through home charts, releases, and album tracklist requests. Explicit album detail retains its existing complete behavior.
- Added regression simulations for a stalled album outside the first-render sample and catalog queue saturation. Existing recommendation ranking, tracklist freshness, diversity, playback, artwork, lyrics, and web UI files are unchanged.

## Verification scope

The release is built from the supplied v8.3.8 archive and preserves all `tokens.txt` and `data/**` bytes. Local verification includes the platform suite, configuration/dependency preflight, syntax checks, and package CRC/manifest checks. Provider behavior is exercised with deterministic local simulations; no live Discord account or real provider availability is claimed.
