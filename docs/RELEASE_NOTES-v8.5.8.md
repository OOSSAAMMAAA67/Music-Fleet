# Music Fleet v8.5.8

## Restore private bot configuration

- Restores the original `tokens.txt` directly from the user's supplied v8.5.6 archive so startup no longer fails with a missing-token error.
- Keeps the file byte-for-byte unchanged; token values are not printed in build logs or release notes.
- Continues to omit `node_modules/` and `data/`, including saved favorites and listening state.
- Carries forward v8.5.7 home loading, recommendation shelves, and concise radio artwork labels without changing the web layout.

This is a private archive containing bot credentials. Do not publish or share it.
