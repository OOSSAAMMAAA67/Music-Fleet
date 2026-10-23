# Music Fleet v8.5.7

## Home recommendations and loading

- Keep the home skeleton visible until the featured For You shelves are ready, with a quiet local fallback if catalog providers are unavailable. A previously completed home snapshot can still appear immediately.
- Build the first recommendation stage from fresh album tracklists as well as current chart tracks, using the album cover when a track has no separate artwork.
- Restore a separate “Albums you’ll enjoy” shelf, omit empty shelves, and move personal radio below the main discovery shelves.
- Shorten radio artwork labels and clamp them to two lines so provider titles do not cover the card artwork.
- Continue loading the broader For You catalog after the featured shelves render.

## Package contents

This archive is distributed without `node_modules`, `data/`, `tokens.txt`, or active credentials. Install dependencies with `npm ci`, copy `tokens.txt.example` to `tokens.txt`, then add private bot tokens locally. User favorites, listening history, cached media, and local bot state are not included.
