# Music Fleet v8.5.4

- Render the For You home from the user's local listening and saved library first, then refresh the full personalized catalog in the background. Reuse a short lived, user scoped home snapshot for repeat visits and keep the initial page visible if background catalog enrichment is unavailable.
- Keep Explore's existing curated genre, mood, and decade chips instead of rendering every provider genre. Remove the extra “View as list” control.
- Expand sparse decade shelves with multiple catalog searches while preserving verified release-year filtering and provider artwork metadata. Increase the MusicBrainz browse sample to 100 recordings and release groups.
- Remove the redundant “From current provider charts” subtitle and the Discord room/bot line below the mini player.
- Preserve the existing page layout and recommendation ranking. No user library, history, token, or configuration files are rewritten by these changes.
