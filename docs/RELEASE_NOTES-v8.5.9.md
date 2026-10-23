# Music Fleet v8.5.9

## Restore all non-favorite bot state

- Keeps the original tokens.txt byte-for-byte so the supplied bot tokens remain available at startup.
- Preserves every non-favorite file from the supplied v8.5.6 archive, including the bot fleet state and pinned room assignments, shared library database, SQLite WAL files, and other saved bot data.
- Excludes only favorite records under data/ (favorites/, favorites.json, favorites.sqlite, and any associated sidecars). node_modules/ remains omitted so dependencies can be installed with npm install.
- Carries forward the v8.5.7 home/recommendation and artwork fixes and the v8.5.8 token restoration.

The archive contains private bot credentials and state. Keep it private.
