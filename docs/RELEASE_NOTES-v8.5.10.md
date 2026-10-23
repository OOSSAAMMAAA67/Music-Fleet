# Music Fleet v8.5.10

- Fixed the Windows installer and diagnostics calling the removed `test:fleet` script. Both now run the shipped platform regression suite; the legacy npm script remains as a compatibility alias.
- Added an installer preflight that checks all required npm scripts before `npm ci` or any external tool downloads, so a broken package command is reported immediately.
- Preserved the existing bot token file, bot/guild placement state, and non-favorite data in the private release. Favorites and `node_modules` remain excluded from the downloadable archive.
