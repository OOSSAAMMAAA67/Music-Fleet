# Platform 7.3.0 feature coverage

The desktop/phone references guide English navigation, shelf order, detail layouts, the floating phone dock and full-window song/video surfaces. The later 438.316-second recording and nineteen problem screenshots were also reviewed. Production catalogs are provider-backed; labeled QA data exist only in isolated tests.

| Area | Behavior | Data and persistence |
| --- | --- | --- |
| For you | Compact shortcuts; Custom mixes before Suggested new albums; recent/recommended tracks, personal radio, because-you-listened and playlist/genre/artist shelves | Live metadata, actual listening, favorites, follows and feedback |
| Staff Picks | Editorial releases, tracks and playlists | Actual provider editorial data |
| Mixes | Two starters, then progressively earned My Mix 1–6 | Qualified consumed listening, sustained taste clusters and date/taste refresh |
| Public New / Top | Country-aware current releases and ordered charts | Independent of local listening; actual provider dates/order |
| Explore | Dedicated genre/mood/decade/New/Top/Videos/Clean pages; chips and View as list | Categorized real shelves; unsupported format/magazine destinations removed |
| Search | All/Tracks/Albums/Artists/Videos; canonical artist and separate Similar artists | Case/provider deduplication, exact match first, stable IDs and cancellation |
| Albums | Art, tracklist, artist, Play/Shuffle/Save and Other versions | Paginated actual releases and identity/version checks |
| Artists | Verified portrait, tracks/albums, EPs & Singles, Appears on, contributed recordings, related artists, Follow/Radio | Provider IDs, pagination and actual relationships |
| Credits | Recording role/contributor with artist navigation; scoped album fallback | Actual artist/work/release relationships |
| Provider playlists | Detail, complete tracklist copy, play/queue and unsave | Source identity, atomic storage and incomplete-source reporting |
| Local playlists / imports | Create/rename/delete/add/remove; URL/JSON/text imports | Canonical deduplication, recovery and explicit duplicate/failure/truncation counts |
| Hearts / track menus | Save, playlist, artist/album, radio, download, credits and feedback | Catalog identity survives playback-source substitution |
| Collection | Eight destinations and recent activity | User-isolated saves and completed-download records |
| Monthly / Feed | Rankings/mix, followed releases and updates | Repeated consumed playback; seeks and paused time do not count |
| Autoplay | Related next song after queue exhaustion | Saved preferences and queued/recent exclusions |
| Discord audio | Existing Opus/FFmpeg engine and transport | Resource clock, manual-pause ownership and source recovery |
| Song view | Full window, Cover/Similar/Credits/Lyrics, native fullscreen | No browsing sidebar/topbar; ambient colors retained inside fullscreen root |
| Native video | Five shelves, playlist details, landscape watch view and Similar/Credits/Previous/Next/Retry/Close/fullscreen | Muted browser visual synchronized to Discord bot audio; bot pause/seek, highest compatible source, private ranges, cancellation and honest conversion labels |
| Downloads | Original single file or streaming ZIP64; cancel and browser save | Byte preservation and private tickets; full completed transfers only in history |
| Saved Tracks | Play/Shuffle/search/sort/download toggle and row menus | Actual favorites and original source formats |
| Uploads | Decode validation, embedded art, list/play/delete | Owned original files/private art survive restart |
| Phone | Three Home pills, two-column cover grids, five nav destinations, floating dock and cover/lyrics player | Shared routes and Discord actions; narrow layouts |
| Lyrics | Follow, calibration, continuous fill, gaps, Arabic and CJK singing romanization | Playback clock, source word timestamps preserved through Romaji, generation guards and explicit timed/estimated word status |
| Artwork | Cover/portrait identity lookup and missing/dead-image recovery across all surfaces | Original pixels, scoped tickets, failed-source exclusion, cooldown and stale-result guards |
| Motion / cover physics | Verified MP4/WebM/HLS, compatible variants/static fallback; spring tilt/reflection | Actual release-bound media, stable hover bounds and reduced motion |
| Preferences | Autoplay/motion/explicit/country/discovery/genres | Persistent account settings |
| Purchases | Imported external purchase metadata | No fabricated purchase entitlement/payment processing |
| Access / lifecycle | Signed sessions, private jobs/uploads, body deadlines and cancelled process trees | Original bot configuration and saved data preserved |

## Mix milestones

Only My New Arrivals and My Daily Discovery are initially available. A distinct recording qualifies after thirty accumulated consumed seconds. Personal milestones require at least twenty-four hours between the first/latest qualified listening event. Favorites alone, zero-second opens and paused seeks do not unlock mixes.

| Mix | Qualified songs | Artists | UTC listening days | Consumed time | Sustained clusters | Target songs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| My Mix 1 | 12 | 3 | 2 | 40 minutes | 1 | 50 |
| My Mix 2 | 25 | 5 | 4 | 2 hours | 2 | 75 |
| My Mix 3 | 45 | 8 | 7 | 4 hours | 3 | 100 |
| My Mix 4 | 70 | 12 | 10 | 7 hours | 4 | 125 |
| My Mix 5 | 105 | 16 | 14 | 12 hours | 5 | 150 |
| My Mix 6 | 150 | 20 | 21 | 18 hours | 6 | 200 |

A genre cluster needs six qualified songs, two artists, two days and twenty consumed minutes. Missing genre evidence permits an artist cluster with the same song/day/time minimum. Earned order stays stable. Membership uses its cluster and verified artist-radio provenance, affinity, feedback, recency, diversity and novelty. Targets are not padded with duplicates or unrelated charts when suitable tracks are unavailable. `mixProgress` describes earned/remaining requirements.

## External coverage

Exact lyric timing, official animation, artist portraits, credits, dated releases and playable matching versions depend on sources. Plain-only lyrics are explicitly estimated; romanization may be partial for ambiguous readings. The application does not decrypt subscription DRM or invent an unavailable cover/video/relationship. Native codecs and physical refresh-rate support vary by device.
