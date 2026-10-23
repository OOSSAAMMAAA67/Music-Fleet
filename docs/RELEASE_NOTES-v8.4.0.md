# Music Fleet v8.4.0

## Music discovery and recommendations

- Album pages now retry through an alternate catalog when the requested provider is unavailable or returns no tracks. The alternate result must match the album title family and artist and contain a real track list; the page keeps the original requested ID and reports recovery provenance.
- Recommended new tracks now come only from dated albums released within the previous 120 days. Future, invalid, and stale dates are excluded. The shelf never fills with chart tracks when release details are unavailable.
- Release discovery inspects up to 24 fresh album tracklists through the existing bounded catalog queue, carries verified release dates and album artwork to tracks, and deduplicates duplicate album identities from multiple providers.
- Fresh-release recommendations select at most one track per artist and album while alternatives exist. Daily discovery and personal mixes apply separate artist and album diversity limits.
- Personal artist mixes can use verified related artists and their catalog tracks, in addition to the seed artist's catalog. Provider results are checked against the related artist identity before use.
- Taste ranking uses listening duration and completion, recency, diminishing returns for repeated plays, favorites, followed artists and albums, search intent, opened albums/artists/playlists, preferred genres, provider popularity, and negative feedback. Search and repeated-detail signals decay over time and repeated identical actions are coalesced.
- “Less like this” reduces the ranking of similar artist/genre tracks. “Hide this recommendation” suppresses the matching recording while leaving other tracks by that artist eligible.

## Storage and compatibility

- Search and catalog-open signals are optional fields in existing user platform records. Legacy JSON and SQLite records without the field remain readable.
- Existing listening history is processed without a fixed 5,000-event recommendation slice. The existing zero-means-unlimited interaction setting is retained.
- No page layout or animation redesign is included. Existing track menus expose the two feedback actions.

## Provider and validation boundaries

- Recommendations depend on available provider catalogs and release dates. When providers return too few verifiable new releases, the new-track shelf may contain fewer items rather than older chart content.
- Local fixture tests validate catalog fallback, date filtering, diversity, related-artist mixes, feedback, signal persistence, and history processing. They do not establish live Discord behavior, provider uptime, or population-scale ranking parity with proprietary streaming services.
