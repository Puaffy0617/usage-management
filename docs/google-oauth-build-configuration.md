# Gemini OAuth refresh build configuration

Gemini quota refresh requires an explicitly configured OAuth client pair. Supply
both `CC_SWITCH_GOOGLE_OAUTH_CLIENT_ID` and
`CC_SWITCH_GOOGLE_OAUTH_CLIENT_SECRET` to the Rust build environment. CI can map
protected Actions secrets to those build variables. Keep values out of source,
commits, logs and diagnostic output.

Use the same registered client that issued the existing Gemini CLI refresh token.
A different client registration does not automatically gain permission to refresh
that token. These build settings identify the OAuth application; they are not
user passwords, access tokens or refresh tokens. They are compiled into the
desktop executable, so use only an appropriate installed-application client.

Existing account metadata and token files remain unchanged. Quota reads using a
usable access token continue normally. When refresh is needed and this build has
no complete client pair, the application reports the missing configuration. It
still tries an existing access token before returning that error. Gemini CLI can
renew its own existing sign-in; a correctly configured build can also perform the
existing refresh flow. No account is signed out or removed by this change.
