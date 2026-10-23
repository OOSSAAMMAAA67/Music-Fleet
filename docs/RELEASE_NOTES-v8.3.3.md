# Music Fleet v8.3.3

- Bind every Fleet playback command to the member's current assigned voice room and its saved text channel. A bot mention cannot redirect playback to another bot.
- Apply the same voice/text binding to music buttons, select menus, modal submissions, and the private skip command. Wrong-room message commands are ignored; wrong-room components are acknowledged without a visible reply.
- Keep web playback controls bound to the authenticated member's current assigned voice room.
- Replace the rotating `-help | الموسيقى` presence with the persistent default activity `By ! A`.
- Add the owner-only `activity <text>` and `activity off` command to set or clear the activity across the Fleet. Changes are saved and re-applied when a bot reconnects.
- Preserve the existing configuration, resource settings, tokens, bot placements, and user databases from the supplied v8.3.2 package.
- Validate 50-bot room routing and fleet-wide activity persistence during release checks. Regression test files stay in the work area and are not included in the release ZIP.
