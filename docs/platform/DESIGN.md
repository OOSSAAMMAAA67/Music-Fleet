# Music By ! A 7.3 platform design

The English application preserves Discord playback, signed user/guild sessions, original saved data and Node >=22.12.0 support. Browsing is quiet and cover-led; song/native video views occupy the viewport.

## Components

- PlatformCatalog: live canonical search, paginated recordings/releases/artists, relationships, categorized discovery and country-aware public charts/releases. IDs retain provider/entity kind.
- PlatformStore plus original favorites/history/playlists: atomic saves, preferences, feedback, follows, repeated consumed play events, monthly rankings and crash recovery.
- PlatformService: Home/editorial/discovery/feed, two starter mixes and zero-to-six earned clusters. Public discovery is independent of history; bounded caches refresh with country/date/taste. Artist detail carries a short Popular list and a separate expanded playbackTracks pool with availability reporting.
- PlatformSources/Media/Downloads: recording/version matching, one catalog recovery after retryable source failure, actual media preparation, original-byte downloads, compatible video and scoped cancellation/expiry.
- PlatformArtwork/ArtworkHttp: cover/portrait provenance, provider identity hydration, failed-source exclusion, original-raster HTTPS proxy, private tickets and physical concurrency limits. Existing official motion lookup remains separate.
- web/artwork.js: shared visibility-scheduled recovery, DOM-construction handling, request coalescing, cooldown and old-identity guards.
- Existing web server: authenticated catalog/library/media APIs and unchanged Discord action/lyrics dispatch. Production browser-audio output and its selector are removed. Private legacy audio routes remain for compatibility and explicit native-decoder QA.
- Web shell: compact sidebar/search/shortcuts, shelves/details, phone floating dock; no browsing sidebar/topbar in song view. Ambient palettes are inside the fullscreen shell. Native video uses a fullscreen-capable DIV inside its dialog, retaining toolbar/sidebar/footer. It is muted in the browser, starts the prepared exact video source in Discord and follows the voice clock. No browser-output selector exists.

## API contract

Items retain `{kind,id,title,author?,thumbnail?,url?,duration?,artistId?,albumId?,provider?,genres?,releaseDate?,tracks?,credits?}`. Metadata-only recordings are resolved before queueing; catalog IDs remain authoritative.

| Route | Behavior |
| --- | --- |
| GET /api/platform/home?tab=for-you\|staff\|uploads | Typed shelves, profile, freshness and mixProgress |
| GET /api/platform/explore?genre=&mood=&decade=&mode=new\|top\|videos\|clean | Dedicated category and actual shelves; unsupported format modes rejected |
| GET /api/platform/search?q=&type=all\|tracks\|albums\|artists\|videos | Canonical results, separate Similar artists and stable IDs |
| GET /api/platform/detail?kind=&id=&name= | Actual recording/entity, paginated lists and supplied relationships/credits |
| GET /api/platform/mix?id=&seed= | Unlocked mix/progress and actual unique ranked membership |
| GET /api/platform/library?kind= | Persistent account collections |
| GET /api/platform/stats?month=YYYY-MM | Consumed totals, rankings, months and monthly mix |
| GET /api/platform/feed | Followed releases and monthly updates |
| POST /api/platform/library | Actual save/unsave/follow/unfollow/feedback/settings |
| POST /api/platform/credits | Deep exact-recording credit lookup; labeled album fallback; no provider redirect |
| POST /api/platform/artist | Canonical performer search for raw upload titles; uploader names do not replace an embedded artist |
| POST /api/platform/import | Playlist and duplicate/failure/partial-source reporting |
| POST /api/platform/artwork/resolve | Verified cover/portrait result and private tickets |
| GET/HEAD /api/platform/artwork/image?id= | Exact validated raster; user/guild isolated |
| POST /api/video/prepare | Private native job, MIME and actual quality label |
| GET/HEAD /api/video/file?id= | Authenticated prepared source and byte ranges |
| POST /api/platform/download | Original file or streaming ZIP64; cancellation |
| GET/HEAD /api/platform/download/file?id= | Original bytes/ranges; history after full completed transfer |

Existing /api/action, /api/library and /api/lyrics remain the Discord bridge. Useful partial catalog results render without a generic outage banner; an empty failed page has Retry. Diagnostic failure metadata is retained.

## Correctness and animation

A playback clock drives each lyric surface. Cue end boundaries clear gaps; web fill progresses inside a cue. Follow off retains manual position. Pause/seek/skip/source changes invalidate obsolete results. Arabic remains Arabic; CJK singing transliteration preserves timestamps. Plain-only estimates are labeled.

Artwork verifies recording/release/version and portrait roles. Failed sources are not restored on state polls. Private tickets retain owner/guild isolation; HTTPS redirects, DNS and allowlists are validated. The raster proxy retains original bytes. Motion is actual provider media with variant/static fallback.

Navigation uses short opacity/transform transitions. Catalog cover physics runs for active surfaces and settles to neutral. Palette backgrounds use gradient layers instead of large animated blur filters. Fullscreen contains palette layers; native video retains controls. Reduced motion is honored. Headless cadence is separate from still capture and does not certify a physical 120 Hz display.

Worker/cache/image-validation budgets and cancellation protect voice/interaction from stale work. Zero media-byte caps preserve complete original media; positive host caps and actual attachment limits stay explicit. Recovery never swaps an explicit video URL for another video or drops catalog identity.

## Verification boundaries

Source suites cover identity, races, body deadlines, process cancellation, persistence, progressive membership, category correctness, artwork byte/role/isolation, download recovery and lyric fill. Browser suites use actual production routes/actions and native FFmpeg-generated audio/video. An explicit QA audio element supplies native currentTime only for clock testing; production act and playback handling remain unchanged. External catalogs/lyrics/Discord membership use labeled fixtures; universal live-song and Discord delivery guarantees are outside those fixtures.
