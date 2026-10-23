# Music Fleet

**An independently maintained music playback and discovery project, built around a fleet of Discord voice bots and a shared web experience.**

Music Fleet began as a way to manage several independent music players without running a separate application for every bot. It has since grown into a Node.js codebase that combines Discord voice playback, queue control, a searchable music catalog, persistent personal libraries, lyrics, downloads and a responsive web interface.

This repository is a public, credential-free source release. It does **not** contain the original owner's bot tokens, private settings, saved user data, downloaded media or session databases.

> **Project status:** Active independent development. The web experience and recommendation components are included in the source; a standalone cross-platform music product and native mobile applications are longer-term plans, not released products. This project is not affiliated with Spotify, TIDAL, Discord or any other music service.

## What is in the repository

- **Multi-bot orchestration:** Fleet lifecycle, owner-managed voice-room placement, per-bot players, independent queues and reconnect handling.
- **Playback tooling:** Discord voice transport, FFmpeg integration, yt-dlp source handling, queue controls and source recovery.
- **Music discovery:** Search, artist/album metadata, catalog identity, recommendation and mix services, and source-provider adapters.
- **Personal collections:** Favorites, playlists, listening history, feedback and local imports, backed by a SQLite storage layer.
- **Web experience:** Desktop and mobile-responsive pages for searching, exploring, managing libraries and controlling playback.
- **Lyrics and artwork:** Timed lyrics, synchronized display, multilingual text handling, image resolution and media artwork services.
- **Operations:** Windows startup scripts, optional PM2 tooling, dependency checks, diagnostics and migration utilities.

Music data, provider availability, media rights and source quality depend on external services. The project does not claim to have independent licenses for third-party music or to bypass DRM.

## Technology

- Node.js **22.16+** or Node.js **24+** (see `package.json` for the exact supported runtime range)
- JavaScript, Discord.js and `@discordjs/voice`
- SQLite storage and background workers
- HTML/CSS/JavaScript front end
- FFmpeg, yt-dlp and optional Cloudflare Tunnel for external web access

The GitHub source does not bundle platform-specific executables. The included setup scripts can obtain the supported external tools when needed.

## Quick start

1. Install a supported Node.js release and clone the repository.
2. Run `npm ci` in the repository directory.
3. Set up your own Discord application(s) in the [Discord Developer Portal](https://discord.com/developers/applications); enable the intents documented in the code.
4. Configure your own IDs in `config.js`. Use `tokens.txt.example` to create a local **`tokens.txt`** file, or configure the `BOT_TOKENS` environment variable as described in `.env.example`.
5. On Windows, run `install.bat` and `start.bat`, or run `npm start` after setting up dependencies. For provider tooling run `npm run setup:ytdlp` and, if needed, `npm run setup:cloudflared`.

```sh
npm ci
npm run check:deps
npm run check:config
npm start
```

**Never commit bot tokens, `.env`, authentication cookies, SQLite databases, private media, session keys or personally identifying user data.** The first active bot token is treated as the main bot; additional tokens represent secondary bots. When sharing a fork, remove your private configuration first.

### Running on Windows

The original project includes `install.bat`, `start.bat`, `diagnose.bat`, and Windows-specific PM2 task helpers. Use Node.js 22/24 on Windows 11, install dependencies, supply your own tokens and then run the start script.

### Troubleshooting

Start with `npm run check:deps` and `npm run check:config`; consult `COMMANDS.md`, `GLOBAL_WEB.md` and the documents under `docs/`. Voice playback and catalog checks require working third-party services and valid bot credentials. A successful syntax check cannot guarantee external playback availability.

## Project organization

| Directory | Purpose |
| --- | --- |
| `commands/` and `events/` | Discord commands and event handling |
| `handlers/` | Command/event registration |
| `utils/` | Fleet runtime, playback, catalogs, recommendations, storage, lyrics and web services |
| `web/` | Browser interface and mobile styling |
| `scripts/` | Dependency setup, health checks and administration |
| `deploy/` | Deployment helpers |
| `docs/` | Design notes, release history and architecture |

## Direction

I am building Music Fleet as a long-term engineering project. My current focus is on making the existing fleet and discovery services more reliable, easier to test and easier for other contributors to understand. The longer-term goal is to separate reusable catalog, ranking and playback components from the Discord-specific layer and explore a standalone web and mobile experience. These are objectives rather than claims of an existing commercial-scale platform.

See [ROADMAP.md](ROADMAP.md) for planned milestones, [CONTRIBUTING.md](CONTRIBUTING.md) for collaboration, and [SECURITY.md](SECURITY.md) for responsible reporting.

## Open source and third-party services

Music Fleet is published under the [MIT License](LICENSE). Dependencies and third-party tools retain their own licenses. Use the software in accordance with Discord's rules, provider terms and applicable copyright law. No external service endorses this repository.

## Maintainer

Built and maintained independently by [OOSSAAMMAAA67](https://github.com/OOSSAAMMAAA67). Contributions and clear, reproducible bug reports are welcome.
