Historical release notes before 7.0.0. Some provider integrations described here have since been replaced. See README.md and docs/platform/FEATURES.md for current behavior.

# Music By ! A v6.4.1


## v6.4.1 Animated Album Motion / ultra artwork

- Adds **true animated album artwork** to the Web Player when a verified official release exposes motion art. The static official cover is shown immediately and remains the poster/fallback; motion discovery never blocks audio startup.
- Apple Music Album Motion is resolved from the exact matched Apple album/release and the highest available **square** video variant wins automatically; there is no artificial animation-resolution ceiling in the selector. Tall editorial video is not substituted for the square cover.
- A second motion-art discovery path uses MusicHoarders (Apple Music/TIDAL sources) only after a strong album/artist match. If no verified motion exists, the player stays on the correct static artwork.
- Apple static artwork requests were raised to 3000px and the Apple storefront search was expanded to US/GB/JP/KR/CN/AE/SA/KW/EG/DE/FR/AU. YouTube remains the far-last artwork fallback.
- Fixed a multi-storefront Apple regression where the storefront identifier could escape its async scope and silently drop Apple candidates. Added regression coverage for it.
- Motion playback is resilient: high-quality video failure falls through to lower official variants, then to the static poster; 1-second Web state polling does not restart an already-playing motion loop.
- Previous v6.4.0 deep lyrics synchronization, Arabic moving-lyrics fallback/upgrade, CJK romanization search, TIDAL resolver, and audio-fidelity behavior are retained and regression-tested.

## v6.4.0 Lyrics timing / artwork identity / TIDAL resolver rebuild

- Calibrates provider-synced lyrics against the exact playing upload when a trustworthy caption timing skeleton exists, removing common intro/upload timing drift without one global offset.
- Plain lyrics no longer remain frozen: exact-upload timing is preferred, then a bounded estimated timeline is used while the bot keeps retrying for a reliable synced source.
- CJK native-script fallbacks keep searching for readable Romaji/Pinyin/Romanized lyric bodies and can align them to already-known native timings.
- Discord Auto-Follow uses a smaller sliding lyric window and net REST-vs-voice presentation latency compensation for faster, smoother edits with fewer page-boundary jumps.
- Web lyrics compensate Discord voice presentation latency while preserving the existing UI/animation code.
- Strong lyric title/artist identity is handed back to the artwork resolver so Apple/Deezer/MusicBrainz can replace curator/YouTube thumbnails with official release art.
- TIDAL track links query TIDAL oEmbed first, then public embed metadata, then page discovery; playback still resolves through the existing audio engine.
- Adds dedicated regression coverage for timing calibration, moving Full Text, Romanized-description alignment, artwork identity and TIDAL oEmbed.

- Arabic tracks keep Arabic lyric bodies; English tracks reject explicitly foreign captions; Japanese/Korean/Chinese prefer readable Romanization/Pinyin while native script remains fallback.
- Discord Auto-Follow checks lyric progression every 125 ms while editing only on line changes, preserving the existing UI/card shape.
- Added dependency preflight for Node 22 runtime modules after `npm ci`.
- CJK Romanization validation now requires real transliteration evidence; an English translation of a Japanese/Korean/Chinese song can no longer masquerade as Romaji/Pinyin simply because it uses Latin letters.
- YouTube machine-translated caption variants are excluded from lyric metadata/candidate selection (`skip=translated_subs`), while original auto-caption tracks such as `*-orig` remain eligible under the normal language policy.
- English tracks no longer trust a translated English caption merely because its text is fluent English; caption origin is checked before it can become the displayed lyric body.
- Plain lyrics from providers without reliable language metadata are validated from their actual text instead of being stamped with the expected language.

- Arabic tracks now use script-aware language validation: Turkish/Latin/foreign auto-captions are never displayed as the lyric body merely because their timestamps look valid.
- Arabic-language inference combines track/media identity, yt-dlp metadata and Arabic lyric markers in the source description; a wrong YouTube language guess cannot override an obviously Arabic song.
- Official/source descriptions can provide a high-confidence Arabic plain-lyrics fallback. When only foreign auto-caption timing exists, the bot can discard the foreign words and reuse only the timing skeleton to animate the correct Arabic text.
- Added deep Arabic YouTube version search for SoundCloud/Spotify/TIDAL and difficult YouTube links, while keeping LRCLIB/Karalyr/lrcmux first.
- Added bilingual-title identity extraction (Arabic + Latin transliteration), fuzzy Arabic normalization and confidence-gated candidate scoring so punctuation/year/transliteration differences do not cause misses while unrelated songs remain filtered.
- Japanese/Korean/Chinese behaviour remains language-aware; readable Japanese romaji is explicitly preserved rather than being rejected by the Arabic policy.
- Arabic machine-translated captions are rejected when their native automatic-caption source is non-Arabic; foreign ASR may contribute timing only, never visible lyric words.
- Arabic fallback quality order is manual Arabic subtitles for the exact upload -> synchronized provider match -> verified Arabic source-description body with optional timing skeleton -> Arabic auto-ASR only as a last resort.
- After the LRCLIB fast lane misses, bounded independent Arabic fallbacks run concurrently rather than serially. Provider/HTTP/yt-dlp semaphores still cap global work so deeper search does not compete with live voice audio.
- The public lyric Source label no longer exposes a foreign timing language such as `tr-orig` when only its timestamps were reused; the visible source remains Arabic while timing-language detail stays internal diagnostics.
- Added dedicated Arabic language regression coverage for wrong-language captions, adaptive Arabic timing, bilingual/fuzzy identity matching and Japanese romaji preservation.

## v6.3.4 Multi-source lyrics / live-sync hardening

- Lyrics now use a layered provider chain: LRCLIB first, Karalyr as an independent synchronized fallback, lrcmux as a bounded multi-provider aggregator fallback, exact/current YouTube captions, version-aware YouTube caption search, and lyrics.ovh as the final plain-text fallback.
- LRCLIB and Karalyr searches use a staged fast lane: high-confidence exact/structured synchronized matches return immediately, while broader deep queries run only when the fast lane is insufficient.
- lrcmux adds one bounded no-key aggregation layer across multiple public lyric providers without launching separate scraper processes from the bot.
- All lyrics HTTP traffic, including YouTube caption downloads, shares one global bounded semaphore. Network timeouts begin only after a slot is acquired, so multi-guild queueing cannot consume the request timeout before the request starts.
- Fixed literal backspace characters in word-boundary regular expressions used by lyrics identity/curator parsing (and the corresponding artwork matcher), improving rare/remix/channel-title recognition.
- Added correct Han-only Chinese language detection while retaining metadata-language override for ambiguous Japanese/Korean sources.
- Enhanced-LRC word timestamps are stripped safely for the current line-level Discord/Web renderer while line timestamps remain synchronized.
- LRC parsing now honors `[offset:+/-ms]`, multiple timestamps on one line, standard millisecond fractions and common colon-fraction variants; provider timing is preserved before Discord/Web rendering.
- Discord Auto Follow no longer marks the first lyric line active before its timestamp; hidden 250 ms provider-side advancement was removed.
- Discord Auto survives transient REST/network edit failures with bounded exponential retry instead of freezing until the lyrics panel is reopened.
- Concurrent SoundCloud secret links preserve case-sensitive `secret_token` identity inside lyrics in-flight/cache keys.
- Karalyr misses are negatively cached to avoid pointless repeat traffic; successful synced results remain normal long-lived lyrics cache entries.
- Added dedicated regressions for provider fallback, Enhanced/offset/multi-timestamp LRC parsing, first-line timing, transient Discord edit recovery, case-sensitive SoundCloud links, public Discord room Auto-follow, private interaction guards, Web stale-track guards, and 18 simultaneous deep lyrics lookups. The HTTP stress test proves the active request ceiling remains 12 and all waiters are released.

## v6.3.3 Deep stability / provider identity / live-audio priority audit

- Provider-stable track identity now prefers the original Spotify/TIDAL/SoundCloud identity over a replaceable playback match, so Favorites, History and Playlists do not duplicate the same external track if its YouTube match changes later.
- Favorites eviction is now loss-safe: a transient atomic-write failure cannot evict the only dirty in-memory copy. History/Favorites atomic backup names are collision-resistant for repeated long-running saves.
- Malformed percent-encoded URLs fail cleanly instead of throwing from `decodeURIComponent`. SoundCloud secret-token query data remains part of canonical track identity.
- Live playback no longer downloads the currently audible track a second time into the seek cache. Only upcoming tracks are audio-prefetched; current artwork/lyrics still warm asynchronously.
- Audio-cache work is bounded to 12 queued jobs and automatically drops to one background downloader while live voice is active, preventing skip/jump bursts from competing with the audible stream.
- Infinite voice rejoin remains enabled, but long outages use bounded exponential backoff instead of hitting Discord every 1.5 seconds forever. A successful join resets the retry budget immediately.
- Windows BAT and PM2 now share the same auto-detected CPU/libuv performance profile; PM2 no longer pins `UV_THREADPOOL_SIZE=8` or an old i5-only profile.
- Added provider-process integration, provider-identity durability, long-run storage/concurrency, cache-pressure and reconnect-backoff regression suites to `npm run review`.
- Synced lyrics now use the live `AudioResource.playbackDuration` clock plus the seek base, so the startup stability grace no longer leaves Web/Discord timing behind the audible stream.
- Discord Auto lyrics no longer regenerates/uploads a PNG every line; it uses lightweight edits and an adaptive latency lead instead of the old fixed +1.5s compensation. Manual lyric pages keep the visual card.
- Async lyric lookups are track-generation checked after provider waits, preventing a late result from the previous track from overwriting the current track after skip/next/recovery.
- Web playback state now carries a play token; seek/recovery/new resources snap to the new authoritative clock instead of being smoothed against the superseded resource.
- Spotify/TIDAL resolved-track identity and source artwork are retained through Favorites, History and user Playlists. Direct SoundCloud provider metadata is retained too.
- Source-provider artwork is preferred over generic YouTube thumbnails when an external link was resolved to YouTube, while verified Apple/Deezer/MusicBrainz artwork remains first.
- Added regression tests for audio-resource lyric clocking, stale async lyric races and source-media persistence across Library/History/Playlists.


## v6.3.1 SoundCloud deep-performance hardening

- SoundCloud share-link resolution now uses one total 5-second deadline and a GET-first fast path, with a small redirect cache; a healthy short link requires one redirect request rather than paying separate HEAD + GET waits.
- yt-dlp arguments are provider-aware: SoundCloud no longer inherits YouTube-only player-client extractor arguments, while YouTube keeps the existing tuned client rotation.
- SoundCloud metadata and rare deep-playlist fallback remain bounded and do not change the audio codec, bitrate, buffering, queue, or FFmpeg/Opus quality settings.
- Media-cache and lyrics metadata probes now preserve provider awareness so SoundCloud links avoid unnecessary YouTube-specific work.
- CPU scheduling is now auto-detected: the Windows launcher no longer pins the bot to a 6-thread affinity mask, while real-time audio remains above-normal priority and background work yields CPU when playback is live.
- Added regression coverage for mobile SoundCloud sets, API playlist URLs, secret-token track URLs, fast short-link resolution, and provider-specific yt-dlp arguments.

## v6.3.0 SoundCloud / external music-link resolver

- SoundCloud track links and `/sets/` playlists are handled as first-class URLs through the existing yt-dlp audio pipeline; YouTube remains the primary text-search source.
- `on.soundcloud.com` share links are canonicalized when possible, with yt-dlp fallback if redirect resolution is temporarily unavailable.
- SoundCloud flat-playlist entries no longer risk being reconstructed as YouTube URLs merely because an extractor ID happens to be 11 characters.
- Incomplete SoundCloud flat playlist metadata triggers one bounded deep extraction fallback before the queue is built.
- Spotify and TIDAL **track** links are accepted as metadata links and resolve to one result through the existing primary playback source; they do not replace the audio engine or turn a single link into a pseudo-playlist.
- Added deterministic source-link and SoundCloud queue-transition regression tests.


## v6.2.6 deep recovery / lyrics / artwork audit

This pass also hardens runtime ownership under failure: Web queue navigation rolls back on failed starts, loop replays use normal recovery, SIGINT/SIGTERM shutdown is owned centrally, and long-lived Discord collection/Auto-Lyrics sessions have bounded UI-session lifecycle caps.

- Discord Auto Lyrics now keeps a lightweight recovery session even when the first lookup has only plain lyrics or no synced timings. It retries in the background and upgrades the same message automatically when synchronized lyrics become available.
- Web lyrics retries now explicitly bypass empty/plain-only caches while preserving already-synced results. Plain text stays visible immediately, but the browser continues probing for synced timings without requiring a page refresh.
- Idle suppression is generation-guarded so an older stop/seek/retry timer cannot accidentally clear suppression armed by a newer playback operation.
- Playback errors are stored per queue/guild as well as in the legacy global field, preventing one guild's failing source from contaminating another guild's error UI.
- Temporary artwork fallbacks now re-run the official Apple/Deezer/MusicBrainz search in the background every minute while keeping the current fallback visible. Official covers replace it automatically once a provider recovers.
- Library/history serialization no longer launches deep artwork searches for up to 1000 rows at once; only current playback owns aggressive artwork resolution. Cached artwork is reused for collection rows, reducing provider rate-limit pressure and improving current-track artwork success.
- Audio quality, i5-9400F 6C/6T CPU profile, Opus bitrate, 48 kHz path and saved data remain unchanged.

## v6.2.5 playback race hardening

Playback startup now uses a newest-request-wins generation so rapid play/seek/skip/stop actions cannot let an older delayed yt-dlp/FFmpeg pipeline overwrite a newer track. Delayed Idle/error events are resource-owned, recovery callbacks are generation-guarded, and direct HTTP audio fetches have a bounded timeout. Audio encoding/quality settings and the i5-9400F performance profile are unchanged.

## v6.2.4 playback/runtime recovery hotfix

- Replaced deprecated Discord interaction `ephemeral: true` response options with `MessageFlags.Ephemeral`.
- Message commands now recover when the invoking Discord message is deleted before a reply: the bot falls back to a normal channel message instead of failing with `MESSAGE_REFERENCE_UNKNOWN_MESSAGE`.
- Cloudflare Quick Tunnel browser disconnect noise (`Incoming request ended abruptly: context canceled`) is treated as a benign client cancellation, while real edge/tunnel errors remain visible. Chunked cloudflared stderr parsing is line-buffered so the same error is not emitted repeatedly.
- Live YouTube playback now rotates across five independent yt-dlp client strategies on retries instead of retrying the same broken delivery path. Playback retries are bounded per strategy so failure moves to the next client quickly.
- FFmpeg is not spawned until yt-dlp has produced real media bytes. A source failure therefore no longer cascades into misleading `pipe:0 / Invalid data found when processing input` errors.
- The i5-9400F 6C/6T CPU/RAM/audio-quality profile is unchanged; the recovery work does not lower bitrate, resampling quality or the HQ Opus pipeline.
## v6.2.3 playback startup hotfix + aggressive 16GB RAM profile

Fixed the v6.2.2 playback blocker `Cannot access 'artworkResolver' before initialization`. The cause was a block-scoped redeclaration of `artworkResolver` later inside `_playOnce`, which shadowed the already-loaded module binding and placed the earlier artwork call in JavaScript's temporal-dead-zone. The duplicate declaration is removed, and a dedicated regression test prevents this class of startup failure from returning. Artwork/lyrics/history warm-up is now auxiliary by construction: synchronous or asynchronous failures in these enrichments are isolated and can no longer tear down otherwise healthy voice playback.

The i5-9400F CPU topology remains deliberately balanced across all six logical CPUs: up to 2 threads for live audio, up to 3 background-heavy threads during one live stream, and one coordinator budget for Node/Discord/Windows. Idle heavy work may use five threads. This uses all six hardware threads under real load without oversubscribing them. For the 16GB RAM target, the Node heap ceiling is raised to 7GB, Sharp native cache to 1GB, raw artwork cache to 768MB, animated-card cache to 1GB, and the live stream high-water buffer to 192MB. Audio codec, bitrate, resampling, gain and quality settings are unchanged.

## v6.2.2 broader multilingual lyrics recovery

Lyrics search now treats the expected language as a preference instead of a hard requirement. If Japanese is unavailable it may use English, and if English is unavailable it may use Japanese or another available caption track rather than showing an empty lyrics page. Anime/OST upload titles are parsed more deeply, including Opening/Ending/OP/ED conventions, `Song by Artist`, and Japanese corner quotes such as `「曲名」`. Deep YouTube lyric searches include `lyrics`, `歌詞`, `romaji lyrics`, and `english lyrics` variants. Exact-source caption probing checks more language/format candidates, transient empty results expire quickly, metadata misses are retried sooner, and the Web Player automatically re-runs a failed empty lookup while the same track is still playing. CJK caption validation now counts Japanese/Chinese/Korean characters directly instead of relying on spaces, so normal Japanese lines are no longer rejected as “too short.”

## v6.2.2 i5-9400F / 16GB dynamic CPU profile

This build is tuned specifically for the Intel Core i5-9400F (6 cores / 6 threads) with 16GB DDR4. The Discord/Node event loop stays a single coordinator by design; CPU-heavy work is delegated to FFmpeg and Sharp/libvips so all six logical CPUs can be used when useful without forcing pointless 100% load.

- Windows `start.bat` does not force a CPU-affinity mask; Windows can schedule the bot across every logical CPU detected on the machine, while Node is launched Above Normal.
- With no live voice stream, heavy FFmpeg/Sharp work can use up to five CPU threads while one logical CPU is kept for Node/Discord/Windows.
- While one live stream is active, background FFmpeg/Sharp capacity drops dynamically to three threads and the live audio FFmpeg may use two. With additional live streams, background and per-stream thread budgets shrink further instead of oversubscribing the 6C/6T CPU.
- Live audio child processes are prioritized above background work. Heavy rendering is Normal when idle and is reduced to Below Normal while voice audio is active; background prefetch/download helpers stay Below Normal.
- Sharp/libvips follows the same dynamic CPU budget and retains a bounded 1GB native cache.
- libuv worker count is selected dynamically by the runtime performance profile from the detected machine instead of being fixed to an old six-core host.
- Node launches with a 7GB maximum old-space budget on the 16GB host; visual caches remain bounded at 768MB raw artwork and 1GB animation cache.
- Heavy animated/transcode FFmpeg jobs are serialized, preventing two multi-threaded encoders from fighting the live voice pipeline.
- Current artwork/lyrics plus the next tracks are warmed after playback is stable; audio-cache downloads are only queued for upcoming tracks, and live playback throttles cache downloading to one background job.
- `ecosystem.config.cjs` intentionally runs one Discord process. PM2 cluster mode is not used because duplicate Discord gateway/voice clients would reduce stability rather than improve performance.

Use `start.bat` on the target Windows i5-9400F machine, or `pm2 start ecosystem.config.cjs` if PM2 is preferred. PM2 does not need an affinity mask because Windows already exposes all available processors by default; the runtime profile still applies the thread budgets and process priorities.

## v6.1.7 deep artwork + lyrics follow

Artwork resolution now uses a staged official-first search across Apple/iTunes, Deezer and MusicBrainz/Cover Art Archive, including album/single fallback and curator-channel title recovery. Returned official URLs are validated before the browser sees them; YouTube artwork stays at the end of the chain only.

Lyrics matching remains version-aware and now parses additional exact-source caption formats (JSON3/VTT/SRV/TTML). Discord Auto Lyrics continues across normal queue transitions by resolving the next track automatically, while Web lyrics keep per-track stale-result guards.

## v6.1.7 version-aware deep lyrics

Lyrics resolution now identifies the exact playing version before accepting synchronized timestamps. Explicit remix/edit/live/slowed/sped-up and similar markers are retained as identity data, named remixes are cross-checked, and duration is used to distinguish providers that omit version labels. For altered tracks, exact-source captions are preferred when available; otherwise the resolver runs parallel LRCLIB searches and then version-aware YouTube caption probes. A related but timing-incompatible result can still be used as plain text, but it is not animated with unsafe timestamps.

The Web Player also binds every lyrics response to the current track. Switching songs clears the old lines immediately, starts the new lookup without waiting for an older request, and rejects a response if the server track changed during lookup. This removes the old behavior where the previous song's lyrics could remain visible until a page refresh.

The official high-resolution artwork resolver remains official-first and is further expanded in v6.1.7 with collaborator-aware title parsing, quoted-track handling, additional artist aliases and deeper album/single queries before any YouTube fallback.

The final v6.1.7 audit also serializes Auto-follow edits across session restarts, makes artwork caching source-aware so one upload cannot suppress another upload's deeper album lookup or leak its fallback thumbnail, and isolates exact-source synced-caption caches per playing URL so source-specific timing cannot leak across uploads.


## v6.1.3 deep official artwork resolver

The Web Player artwork resolver now performs a wider official-first search. It runs multiple Apple Music/iTunes and Deezer track queries in parallel, then performs a deeper pass using yt-dlp music metadata (track, artist, album and album artist) plus Apple/Deezer album searches and MusicBrainz/Cover Art Archive release/release-group artwork. Exact remix/version matches stay highest priority, but if a provider does not list that exact variant the resolver can still use the official cover for the same song/album instead of dropping immediately to a YouTube thumbnail. Wrong-artist same-title matches remain rejected.

YouTube is no longer exposed while the official lookup is pending. The player shows the neutral placeholder for that short window, keeps several official cover URLs in the browser fallback chain, and only then falls back through YouTube maxres/hq images after all official candidates fail. Official results are cached for six hours; temporary misses are cached only briefly so provider outages do not pin low-quality artwork.

Discord music bot + real Web Player for Node.js 22.12+ and Windows 10/11 64-bit.

Run `install.bat` once, then `start.bat`.


The Player stage now keeps a single track-title area: the floating duplicate metadata card was removed from the HTML, while the bottom transport bar remains unchanged.

Current Web Player artwork is resolved independently from the YouTube playback source. Apple/iTunes, Deezer and MusicBrainz/Cover Art Archive metadata are matched against the exact title, credited artist and version/remix signature. Apple artwork is requested at 2000×2000 when available. The providers run without blocking voice playback, results are cached, and the resolver does not mutate the Discord/source thumbnail. If no trustworthy official match is found, the browser receives a highest-first YouTube fallback chain (maxres → hq720 → sd → hq), and image failures automatically advance through that chain. A remix request cannot silently fall back to a different remix or the original mix.


## v6.1.7 lyrics/live-follow and official-art hotfix

- Fixed multi-artist YouTube title parsing (for example `Gryffin & Audrey Mika - Safe With Me (Last Heroes Remix)`) so the remix identity is searched instead of treating the artist prefix as part of the song title.
- Fixed named-remix extraction so the remixer name is no longer polluted by the whole song title. This restores safe synced-LRCLIB matching for exact remixes while still rejecting a different edit with incompatible duration.
- Discord prefix lyrics now have a real auto-follow session; `Auto On` is no longer merely a label. Component-based Auto uses the same session manager so only one follower edits the message.
- Web lyrics clear immediately on track changes and automatically retry a track-change race instead of waiting for a manual page refresh.
- Artwork parsing now understands collaborator prefixes and quoted anime/J-pop track titles, expands artist aliases, searches more Apple/Deezer variants and storefronts, keeps album/single artwork ahead of YouTube, and retries misses sooner.


## v6.1.2 official artwork resolver + single title area

The desktop artwork hover was recalibrated against the three supplied comparison recordings. Pointer capture now begins only on the physical, untransformed artwork rectangle; the old pre-hover halo is removed. Resize/reflow resets and disarms the card so a stationary cursor cannot tilt it merely because the window changed size. The tilt starts gently at the edge, strengthens through the inner band, then relaxes again toward the centre while retaining the existing damped 60/120 Hz response and roughly eight-degree peak.

The reflection is intentionally smaller than the TIDAL reference but more visible than v6.0. It stays surface-derived, travels farther with orientation, and leads the mechanical spring slightly so it feels responsive rather than fixed. The late mobile player rule is also correctly scoped back inside the mobile media query, keeping the compact song panel in its desktop position on wide screens.

## Web Player

The bot starts the Web Player on a loopback-only origin (`127.0.0.1:3780`) and publishes it through an outbound Cloudflare Tunnel. No router port-forward is required. The browser animates progress, lyrics and artwork-derived colors locally at display refresh rate. Actual frame rate depends on the browser, display and device. Discord does not support a 60Hz live message progress bar.

**v5.9.1 global mode:** with the default configuration, the source automatically prepares a SHA-256-verified `cloudflared` binary and opens a trusted `https://*.trycloudflare.com` URL. Web Player buttons generated by the bot use that current HTTPS address, so phones and computers outside the host LAN can open the site without Chrome's `Not secure` badge. Cloudflare terminates public TLS; no self-signed certificate is shipped because a self-signed certificate would still be untrusted on other people's devices. Private session tokens are moved out of the address bar into `sessionStorage` after first load.

The zero-account Quick Tunnel is an automatic fallback, not a permanent production hostname: its URL can change when the tunnel process is recreated. For a stable official address such as `https://music.example.com`, use a Cloudflare remotely-managed tunnel and set **both** `CLOUDFLARE_TUNNEL_TOKEN` and `WEB_PLAYER_PUBLIC_URL`. The same source then keeps the stable hostname while `cloudflared` creates outbound-only connections to Cloudflare. See `GLOBAL_WEB.md`.

Views: Player, Search, Live Lyrics, Library, Playlists, History, Discover and Queue. Search finds playable songs with yt-dlp and album/artist metadata through MusicBrainz. Album songs are matched to playable sources when selected. Albums and artists depend on the external metadata service and may have incomplete coverage. Personal playlists support create, rename, add/remove and delete; Library and History have individual removal, and History can be cleared after confirmation. The responsive interface adds a sidebar and mouse-follow artwork tilt/light. Library/History/Discover support click-order multi-selection plus Play Selected, Queue Selected, Play All and Queue All.

## Lyrics sync

Discord's message-update latency cannot be made frame-perfect. Discord lyrics therefore use `DISCORD_LYRICS_SYNC_OFFSET_MS = 1500`ms so the line is shown about 1.5 seconds early to compensate for message-edit latency. The Web Player follows synced timestamps locally with `requestAnimationFrame`, so `WEB_LYRICS_SYNC_OFFSET_MS` defaults to `0`ms; its per-browser fine adjustment remains available if a specific device/source needs tuning.

## Audio download

The Download option uses yt-dlp + FFmpeg to produce MP3 (`--audio-quality 0`). The installer updates the bundled Windows executable from the nightly channel, and Python fallback installs `yt-dlp[default]` so current YouTube JavaScript/EJS challenge support is not silently omitted. The engine uses bounded retries for transient network failures and rotates immediately on YouTube 403/client/format failures through (`default`, `android`, `web_embedded`, `ios`, `mweb`, `web_safari`), preserving clean retry outputs and following the same reliability ideas as the newer Control media engine. `install.bat` still updates yt-dlp from the nightly channel by default. Discord delivery still respects its attachment limit and only recompresses when needed; Web Player downloads stream directly to the browser.

Spotify track URLs are metadata-mapped to a playable source; playlists/albums are intentionally not treated as one audio file.

## Performance

- `STREAM_HIGH_WATER_MARK` remains **128MB** per audio pipeline.
- `FFMPEG_THREADS: 0` lets FFmpeg use the machine appropriately.
- Browser animations are GPU-friendly CSS/SVG animations and do not spam Discord's API.
- History keeps the latest 5,000 unique tracks per user; favorites keep up to 500 per user. Both are isolated per member and stored in sharded per-user files.
- Up to 60 playlists per user and 500 tracks per playlist are stored in separate durable files. Discover considers the user's saved favorites and full retained history.
- Completed source audio is cached in the background (4 GiB default disk cap, 24-hour retention) so subsequent seeks can start locally. An early seek before the cache completes falls back to the original streaming path.
- The animated Discord artwork, time and text progress bar share the original player embed, with controls below it. The timer edits the embed at most once per changed second without reuploading the image, changing attachments or repainting buttons. Discord clients may briefly repaint an animated image when an embed is edited; this cannot be eliminated while keeping the live timer inside that same embed.
- Web state is refreshed at 1Hz while visual progress/lyrics animation is performed locally with `requestAnimationFrame` at the browser display cadence. The UI uses six artwork-derived ambient colors and transform-based motion; the artwork itself is never stretched into the background.

Use downloads only for media you own or have permission to save.

Copyright © 2026 ! A. By ! A.


### Mobile downloads and responsiveness
Downloads are prepared server-side and then handed to the browser as a native streamed attachment instead of buffering the complete MP3 in browser memory. This is substantially more reliable on iOS/Android. Playback state is polled lightly while motion/progress/lyrics are rendered locally with `requestAnimationFrame`; actual refresh rate follows the device/browser display and may reach 120 Hz on compatible hardware, but is not artificially capped or guaranteed.


## v5.9.1 global HTTPS + v5.8.4 live-player reliability

- Discord's public Now Playing message is edited through one serialized lane. The 1-second timer, buttons and animated WebP can no longer overwrite one another, so the progress bar stays live and the artwork remains inside the embed.
- The Library collection now includes a visible **Remove a song from Library** selector.
- Lyrics warm in the background only after audio has reached the Playing state; opening Lyrics reuses the cache/in-flight request instead of delaying playback.
- Web Player state polling sends compact counts/queue length rather than the whole queue each second, and mobile downloads use a Safari/iOS-safe streamed hand-off.
- The decorative `HQ · 48 kHz` chip was removed. Mobile artwork uses a compositor-only subtle loop while desktop keeps pointer tilt/glare.
- Global access now starts automatically through a trusted Cloudflare HTTPS tunnel while the origin stays bound to loopback. A stable custom hostname can be attached with a named tunnel token + `WEB_PLAYER_PUBLIC_URL`.

- v5.8.4: automatic track transitions reuse one public Discord player message when editable, abandoned web download jobs clean themselves after 10 minutes, API sessions use a request header, and older mobile browsers get a seek-width fallback.
- v5.9.1: worldwide HTTPS gateway management, verified cloudflared auto-setup, loopback-only origin, automatic Quick Tunnel fallback, named-tunnel production mode, tunnel restart supervision, and a global-web contract test.

## v5.9.2 stable Discord artwork and startup recovery

- Playback ticks edit only the separate progress message, keeping the animated image from being repainted on every tick. The text bar uses eighth-cell steps, so short songs show motion more often.
- Historical v5.9.2 setting: PCM used Prism's 128 kbps encoder. The v5.9.5 default below supersedes this path.
- Failed initial Web Player/tunnel startup is retried every 30 seconds while the bot is online. Local 200-request concurrency is covered by the review suite; this does not certify reachability from every country.
- Quick Tunnel URLs change after reconnection and have no production uptime guarantee. For a lasting shareable link, configure a named tunnel with a working domain and token, then test that exact hostname externally.

## v5.9.3 quiet controls

- Pressing the public player's Skip button shows a private confirmation only to the person who pressed it. On the final track, the existing player card changes to a stopped state without adding a second public confirmation.
- Typing `سكب` (or `تخطى` / `skip`) uses a reaction on the command instead of a new public bot embed. Frequent text controls such as pause, previous, seek, loop, shuffle and volume do the same after success; important play/queue messages and useful input errors retain their existing behavior.
- Use `/سكب` or `/skip` to skip with a genuine private response and no public command text. These application commands are registered when the bot becomes ready. Ordinary typed messages are public by Discord design and cannot receive an ephemeral reply; the legacy text commands remain available without public success cards.

## v5.9.4 inline progress and checkmark reactions

- The time and progress bar are back above the animated image in the original Discord player card; no second progress message is created. The same card stays in place across track changes.
- One edit per changed second updates the timer and fractional bar. The edit retains the existing attachment and leaves controls untouched unless their state changes. Track transitions wait for the new artwork before resuming timer edits.
- Frequent successful text playback controls now react with the same green `✅` on the user's command message. An invalid `سكب` still reacts with `❌`; important public playback notices remain as before.
- The animated card generator, its color motion and source resolution/quality settings are unchanged. Discord's embed refresh can still briefly repaint the image; users who need locally smooth motion can open the existing Web Player.

## v5.9.5 voice audio quality correction

- Historical v5.9.5 default: `yt-dlp bestaudio -> FFmpeg/libopus -> Ogg/Opus demux -> Discord`. This 384 kbps path avoided the earlier 128 kbps limit but is superseded by v5.9.6 below to make volume buttons seamless.
- The source selector picks the best audio stream available from the provider without preferring a potentially lower quality Opus variant. In v5.9.5 FFmpeg applied the initial volume before encoding, so changing volume reopened the track. v5.9.6 removes that restart as described below.
- Transient failures retry the high quality path. `AUDIO_PIPELINE_FALLBACK` is off by default, preventing silent PCM/128 kbps downgrades. Enable it only when a lower quality emergency path is preferable to stopping a track.
- The v5.9.5 regression test generated a stereo sample and inspected outbound Opus packets. Its sample averaged about 362 kbps locally. Listening quality also depends on the source and the channel's bitrate setting. Discord voice does not deliver TIDAL MAX/FLAC lossless audio.

## v5.9.6 seamless volume with high bitrate

- The default voice path is now `yt-dlp bestaudio -> FFmpeg 48 kHz stereo PCM -> live gain -> Opus at 384 kbps -> Discord`. The Opus encoder's bitrate is set through its underlying Opus control; Prism's public setter caps at 128 kbps, so it is not used. The outgoing Opus packets retain their exact 20 ms boundaries and are not encoded again by Discord's voice library.
- The 128 MB source buffer stays before the live gain. The downstream PCM and Opus packet queues are deliberately small, so volume down/up/mute do not restart the song or wait behind minutes of already encoded audio. Mute value 0 persists into new tracks.
- Direct audio file URLs use this same voice pipeline, instead of silently going through the generic 128 kbps inline-volume encoder.
- A local regression streams real audio packets, changes gain several times during playback, decodes the packets to verify the volume change, and checks a 384 kbps packet rate before changing gain. Latency on Discord itself remains subject to the network and client; a local test cannot guarantee uninterrupted playback for every user.

## v5.9.7 Web Player polish and resampling

- The Now Playing title is a smaller, translucent glass card constrained to the free space beside the artwork on wide screens. It sits below the artwork on tablets and phones; long names truncate with a full-name hover tooltip.
- The original round progress dot remains visible while a timed track is playing. Its position uses subpixel movement at the browser refresh rate, while the elapsed label advances once per second and existing seek behavior stays intact.
- Desktop artwork retains its size, placement, color glow and lighting. Pointer tilt now follows a critically damped spring measured against the stationary art zone; it settles back smoothly and respects reduced-motion settings. On a 120 Hz capable display the browser can paint at that rate, subject to actual device load.
- The 44.1-to-48 kHz FFmpeg conversion uses SoX resampling at 28-bit precision and retains timestamp correction. The Opus target remains 384 kbps, and live volume changes still happen before encoding without restarting the song. Better resampling cannot restore detail absent from the source or turn Discord voice into lossless audio.

## v5.9.8 transient voice gateway response

- Discord's voice WebSocket may occasionally return an HTTP 5xx response, including 521. Its voice connection now has an error listener, so this event no longer reaches the process-wide uncaught-exception shutdown handler. The voice library retains its own automatic rejoin behavior; repeated 5xx messages are summarized at most once every ten seconds per guild.
- The `ephemeral` deprecation line from the pinned discord.js version is an informational warning. It does not change private reply delivery, audio, or performance, so interaction response behavior remains unchanged.

## v5.9.9 audio startup repair

- The default 48 kHz conversion uses FFmpeg's built-in resampler. v5.9.7 requested SoXR, which the FFmpeg installed on some Windows systems does not support; that prevented songs from producing sound. An old `config.js` that still requests SoXR now probes the actual FFmpeg executable and automatically uses the compatible filter if SoXR is unavailable.
- Startup waits for a real audio packet. An empty `readable` event at end of input no longer counts as successful playback; FFmpeg errors remain handled after that first packet, so an invalid source fails the song without taking down the whole bot and voice connection.
- `npm run check:ffmpeg` now checks actual 44.1 kHz to 48 kHz audio conversion, in addition to the executable's version. The default Opus target remains 384 kbps, and changing volume continues to act on the live stream without restarting it.

## v5.9.10 player artwork and typography

- The cover keeps its size and placement. The old moving `drop-shadow` filter and image transform have been removed from the artwork texture; the small 3D tilt uses a time-based damped spring, with a separate slower reflection driven by the cover orientation. Its color changes remain subtle, and the artwork returns to an untransformed plane when settled. Effective frame rate follows the display and browser; 120 Hz is supported when the device actually paints at that rate.
- Song metadata sits in a compact glass panel to the left of the artwork on wide desktop layouts. The panel stays clear of the cover and adapts below it on narrower windows. Sidebar and collection action glyphs are now vector SVGs rather than font symbols, so they render consistently at fractional display scaling.
- Real artwork detail remains limited by the source thumbnail. This UI change cannot create resolution that the music provider does not supply. The Web and Discord audio paths and the v5.9.9 FFmpeg repair remain unchanged.

## v5.9.11 reference motion calibration

- The 120.7-second, 60 fps reference recording was decoded into 7,240 frames. Cover borders and the visible cursor were tracked to estimate the perspective and response; low-confidence and track-transition intervals were excluded from the numerical fit. The cover now uses an eight-degree tilt, a camera distance of 1.4 cover widths, and a damped spring calibrated to that trace. Perspective follows the actual cover width when the layout changes.
- Reflection is derived from the cover's surface normal and a fixed scene light, with restrained diffuse, specular and Fresnel terms. It no longer drifts according to an independent timer or follows a raw cursor coordinate. The animated background colors remain active.
- Motion simulations cover all nine hover regions, neutral return, pointer limits, 60/120 Hz consistency, stationary reflection, and production script delivery. The recordings support an approximate motion match; these numerical checks do not certify identical browser rendering or a measured 120 fps on every device. Audio, tokens and saved data are preserved.