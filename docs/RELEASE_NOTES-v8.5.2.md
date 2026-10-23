# Music Fleet v8.5.2

## Personalized mixes and Explore quality

- Personal mixes unlock progressively from sustained listening history, up to eight taste clusters. Each remains hidden until at least 30 eligible unique tracks can be assembled. Ready mixes contain a profile-stable daily selection of 30–100 tracks, capped by the available catalog, with limits on repeated artists and albums.
- Album diversity now uses normalized album and artist identity before provider-specific IDs, preventing the same named album from returning repeatedly through different catalog sources.
- Personalized home genre shelves use the same artist and album diversity rules as Explore category shelves.
- Explore catalog recovery now runs when provider results exist but none pass the requested mood, genre, decade, freshness, exclusion, and explicit-content filters. Fallback search results still pass through the same eligibility checks.
- Fresh album tracks inherit alternate catalog cover candidates so the existing artwork manager can move past missing or broken primary covers.
- Playlist suggestions search the listener's top artist and top genre independently, then merge and deduplicate the results.
- Added focused quality simulations for mix readiness/length, cross-provider album diversity, Explore fallback recovery, genre-shelf variety, playlist personalization, and artwork alternatives.

## Verification scope

These changes improve the local ranking and catalog-recovery behavior; they do not claim access to or replication of private Apple Music, Spotify, or TIDAL recommendation models. Local tests do not establish current live catalog availability, Discord playback, or real-browser rendering.
