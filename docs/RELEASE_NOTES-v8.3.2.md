# Music Fleet v8.3.2

## Voice-room authorization

- Music playback commands now require the listener to be in a voice channel. If a queue is active, the listener must be in that queue's exact voice channel.
- Fleet mode also verifies that the current voice channel is assigned to the bot receiving the command.
- Discord music components, including the More menu and Web Player link action, require the listener to be in the assigned voice room. Modal submissions recheck the live voice state.
- The `panel`, `nowplaying`, and `web` commands require the assigned voice room before showing controls or issuing a Web Player session link.
- Every Web Player action rechecks the session owner's live voice channel and active bot target, in Fleet and single-bot mode. Leaving voice or switching rooms rejects the request.

The production archive omits standalone QA scripts and test fixtures. The release report remains available beside the archive.
