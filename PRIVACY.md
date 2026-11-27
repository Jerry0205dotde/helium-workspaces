# Privacy policy

**English** · [Deutsch](./PRIVACY.de.md) · [Back to the README](./README.md)

This policy covers the Helium Workspaces browser extension, its KWin script, `install.sh` and `native-host.sh`.

## In short

Everything stays on your computer. The extension has no server, makes no network requests, contains no analytics or advertising and shares no data with anyone, not with the developer either.

## What the extension stores

To keep your workspaces, the extension stores in the browser's extension storage (`chrome.storage.local`) of your profile:

- your workspaces with name, colour and emoji, and their tabs (address and title), tab groups (name, colour, collapsed) and pinned tabs
- the IDs of windows, tabs and tab groups, so it finds them again after a restart
- your settings, such as **Mute stashes**, **Unload stashes after** and **Automatic backup**
- a random key for the KWin script (24 hex digits), created by the extension on first start

Web pages cannot read this storage. It is removed when you remove the extension. Incognito tabs are not stored beyond the incognito session.

## Files on your computer

- **Export** saves a file with your workspaces, their tabs and settings where you choose, through the browser's download function.
- **Automatic backup** passes the same export to `native-host.sh` on your computer via native messaging. It writes it to `~/.local/share/helium-workspaces/backups/`, at most ten files per browser profile. This only works if you set it up with `install.sh`.
- The extension sends its key to `native-host.sh`, which writes it to `~/.config/kwinrc`. The KWin script uses it to recognise the stash windows of this profile and hide them.

None of this leaves your computer. Only programs running under your user account can read these files, as with any other file of yours.

## Use of the data

The data is used only to provide the extension's single purpose: keeping several sets of tabs in the same window and switching between them, including backing them up and restoring them. It is not sold, not used for advertising or to assess creditworthiness, and not read by any person.

The use of this data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements.

## Changes

If this policy changes, the new version is published here, and the history of this file shows what changed. Should the extension ever send data off your computer, this is stated here and in the extension before it happens, and it asks for your consent.

## Contact

Questions go to the [issues on GitHub](https://github.com/Jerry0205dotde/helium-workspaces/issues).
