# Music Fleet v8.5.11

- Expanded “Albums you’ll enjoy” with back-catalog album searches based on listening artists and preferred genres when chart and release sources are sparse. The shelf excludes newly released and already saved albums, requires usable artwork, limits repeat artists in the leading results, and reshuffles daily.
- Rebuilt Staff Picks from editorial selections, current charts, recent releases and personalized album/playlist discovery. It now presents selected albums, selected tracks and playlists in three non-empty, varied shelves, with daily ranking variation and bounded provider requests.
- Moved Personal radio directly above Your listening history in both featured and full home responses; listening history remains the final shelf.
- Kept the nine-second featured-home and Staff Picks provider budgets. Full-page album work reuses completed featured-search results and does not repeat those requests.
- Preserved bot tokens, saved bot/guild placement, and all non-favorite user data from the supplied private release. Only favorite-data files are excluded.
- Removed test scripts and temporary verification artifacts from the operational ZIP. The Windows installer now validates the saved bot configuration and PM2 setup instead of trying to run tests that are not shipped.
