# Chrome Web Store

**English** · [Deutsch](./webstore.de.md) · [Back to the README](../README.md)

What the extension needs for the [Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies) and what goes into the developer dashboard ([#51](https://github.com/Jerry0205dotde/helium-workspaces/issues/51)). It is not in the store yet.

## The package

Every [release](https://github.com/Jerry0205dotde/helium-workspaces/releases) from 0.3.49 on comes with `helium-workspaces-v<version>-webstore.zip`. That is `extension/` without the `key` field from `manifest.json`, because the store does not accept a manifest with `key` and assigns its own ID. [`tag.yml`](../.github/workflows/tag.yml) builds it.

Still open before the first upload:

- The store version gets a different ID than `jchklfejnmfphkbcpnhdejmeoncejjbe`. `install.sh` and the `allowed_origins` of `native-host.sh` only know the fixed ID so far. The store ID must be added there, otherwise the key and the automatic backup do not work in the store version.
- Switching from the unpacked extension works as described in [Switching to the fixed extension ID](./updating.md): export in the old version, import in the store version with **Replace**, only then remove the unpacked one.
- With automatic updates, the extension and the KWin script no longer always have the same version. The title format of the stash windows (`HWS-Ablage <key> · …`) thereby becomes the interface between the two.

## Store listing

- **Name** and **summary**: come from `extName` and `extDescription` in `_locales/*/messages.json`.
- **Category**: Productivity → Workflow & Planning
- **Icon**: `extension/icons/128.png`
- **Screenshots**: at least one, 1280×800 or 640×400. The pictures in `docs/` are too small.
- **Small promo tile** (440×280): optional, but without it the extension is listed after those that have one.
- **Description**:

  > Workspaces for your tabs: several sets of tabs in the same window, for example "Me" and "Uni", switched by click or keyboard shortcut. Nothing reloads when you switch, so videos and logins keep going.
  >
  > The tabs of the workspaces not shown wait in their own stash windows. On KDE Plasma, the KWin script from the GitHub repository hides these windows from the taskbar and Alt+Tab. Without it, and on other systems, they are visible as minimized windows. The automatic backup to a folder also needs the script's setup.
  >
  > All data stays on your computer: no server, no network requests, no analytics.
  >
  > Source code, setup and help: https://github.com/Jerry0205dotde/helium-workspaces

## Privacy practices

**Single purpose**

> Keeps several sets of tabs ("workspaces") in the same browser window and switches between them without reloading the tabs. Backing up, exporting and importing the workspaces serve the same purpose.

**Permission justifications**

| Permission | Justification |
|---|---|
| `tabs` | Reads the address and title of tabs to save them per workspace, moves tabs between the window and the stash windows when switching, and finds them again after a restart. |
| `tabGroups` | Keeps tab groups (name, colour, collapsed) when their tabs move between windows, and saves them in the backup. |
| `storage` | Stores the workspaces, their tabs, the settings and the key for the KWin script locally in the profile. |
| `unlimitedStorage` | The backup of all workspaces can grow beyond 10 MB with many tabs. Without this permission saving would fail and tabs could be lost after a restart. |
| `contextMenus` | Context menu entries "Move tab to workspace", "Move group to workspace" and "Open link in workspace". |
| `alarms` | Checks every hour whether a daily or weekly automatic backup is due, and unloads the tabs of stashes after the time the user chose, also after the service worker has been ended. |
| `nativeMessaging` | Talks to `native-host.sh` on the user's computer, which the user sets up with `install.sh` from the GitHub repository. It hands over the key for the KWin script, which hides the stash windows, and writes the automatic backups to a folder. Nothing leaves the computer. Without the script the extension works too. |
| `downloads` | **Export** saves the workspaces as a file and waits until the file is written before reporting success. |

The manifest asks for no host permissions.

**Remote code**: No, I am not using remote code.

**Data usage**: Tick only **Web history**: the extension stores the addresses and titles of the tabs in the workspaces, on the user's computer only. Tick all three certifications (no sale or transfer to third parties, no use unrelated to the single purpose, no use for creditworthiness or lending).

**Privacy policy URL**: https://github.com/Jerry0205dotde/helium-workspaces/blob/main/PRIVACY.md

## Developer account

- One-time registration fee and 2-step verification on the Google account, required before publishing.
- Keep the contact email working: notices of rejection and removal only arrive there.
- Support: link to the [issues](https://github.com/Jerry0205dotde/helium-workspaces/issues).
- The dashboard asks whether you are a trader under EU law (Digital Services Act). For a free hobby project, that is usually "not a trader".
- Every update is reviewed again, usually within hours to a few days. The version in `manifest.json` must be higher than the last upload.
