# Music Fleet v8.5.0

## Recommendation and catalog improvements

- Recommendations now combine fresh-release tracklists, the user's strongest artist and genre signals, related-artist catalogs, sustained listening clusters, provider charts, saved favorites, and recent listening with weighted reciprocal-rank fusion. Recording identity uses ISRC when available and normalized title/artist as a fallback, so duplicate catalog entries can enrich each other instead of occupying multiple slots.
- Ranking weighs listening time and completion, repeated plays with diminishing returns, recency, favorites, search and detail intent, saved artists/albums, learned next-track transitions, recent repeats, exact hides, and decaying negative feedback. A skip is a track-focused soft signal; a manual stop, disconnect, shutdown, or playback error is neutral. Old explicit skip records still work when their corresponding signal was not stored.
- Daily discovery and radio mixes use artist, album, and genre diversity selection after relevance scoring. New arrivals require a valid recent release date and a real provider tracklist, with strict one-track-per-artist and one-track-per-album selection.
- Personalized candidate retrieval is bounded to at most nine artist/related-artist/genre lookups for a discovery request, plus at most one extra verified provider radio lookup. Catalog responses use stable public catalog keys and are shared through the existing cache; user histories and ranking context remain user scoped. Provider methods may fan out internally, so this is not a cap on total HTTP requests.
- Album detail now tries a catalog fallback when the primary provider is temporarily unavailable or has no tracklist. Recovery requires a matching album title family, matching credited artist, a different provider, and an actual non-empty tracklist; incorrect homonyms and empty albums are rejected.
- Existing UI layout is retained. The track menu's “Less like this” feedback continues to soften recommendations for related listening signals without hard-hiding the track; exact hide remains available separately.

## Verification

`npm run test:platform` runs album recovery, persistent signals, recommender unit and integration simulations, diversity and transition simulations, production playback-ledger persistence, and prefix/shortcut regressions. The suite is offline and deterministic; it does not prove live-provider uptime, live Discord behavior, or long-duration stability.

This release uses the catalog metadata and provider APIs available to the project. It does not use proprietary Apple Music, Spotify, or Tidal listening graphs and makes no claim of matching or exceeding their recommendations.
