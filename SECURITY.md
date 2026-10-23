# Security Policy

## Sensitive data

Never commit Discord bot tokens, `.env` files, Cloudflare credentials, session signing keys, private SQLite data, OAuth tokens, authentication cookies or downloaded user content. Review `config.js` for personal IDs before publishing your own fork.

If any real secret is accidentally pushed to a public repository, revoke/rotate it immediately and investigate where it was used. Removing it from the current revision does **not** remove it from Git history.

## Reporting a vulnerability

Please avoid publishing a working exploit or private user data in a public issue. Open a GitHub security advisory in the repository's Security tab if enabled, or contact the maintainer privately through GitHub. Provide a minimal reproduction, affected versions and expected impact. Do not test against other users' accounts or services without permission.

Third-party provider or Discord issues should be reported through those providers' own disclosure programs.
