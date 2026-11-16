# Troubleshooting

**English** · [Deutsch](./troubleshooting.de.md) · [Back to the README](../README.md)

## Stash windows are visible in the taskbar or Alt+Tab

A visible stash window has a title like `HWS-Ablage 3f9c… · Uni`, and its first tab is the page "Workspace stash". Do not close it, or the tabs of that workspace are closed. Check in this order:

1. Is the KWin script running?

   ```bash
   qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded helium-workspaces
   ```

   If the output is not `true`, run `./install.sh` again. It installs, enables and loads the script.
2. Do the keys match?

   ```bash
   kreadconfig6 --file kwinrc --group Script-helium-workspaces --key token
   ```

   The output must contain the key the popup shows under **Key for install.sh** (comma-separated with several browsers or profiles), and the window title must show it after `HWS-Ablage`. If the title contains no key (`HWS-Ablage · Uni`), reload the extension in `chrome://extensions`.
3. To repair, click **Copy** under **Key for install.sh** in the popup and run the command in the repository folder. The script reloads the KWin script, and after one or two seconds the stashes disappear from the taskbar.

## `install.sh` aborts

- **`Programs that install.sh needs are missing`**: install the programs listed below it from the [requirements](../README.md#requirements). `install.sh` has not changed anything yet.
- **`Invalid key`**: no key or an incomplete key was entered. In the popup, click **Copy** under **Key for install.sh** and run the copied command. The key consists of 24 characters `0`–`9` and `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Cannot find 'org.kde.kwin.Scripting.unloadScript' in object /Scripting at org.kde.KWin`** or **`KWin script was not loaded`**: `install.sh` cannot reach KWin, for example over SSH or in a text console. The script is then already installed but not loaded. Run it again in a terminal inside the Plasma session.

## Tabs are missing after a restart

If the workspace list shows "… tabs not restored", Helium could not recreate these tabs. **Try again** switches to the workspace and creates them once more. If tabs are missing without this notice, wait a moment. The assignment after startup takes up to 20 seconds.

## The extension is disabled or does not respond

If the extension is switched off in `chrome://extensions`, developer mode was usually off. The stash windows are then in the taskbar. Turn developer mode back on; the extension is then active again and marks the stashes anew.

Otherwise click **Errors** or **service worker** on "Workspaces". Messages of the extension start with `[workspaces]`. **Reload** often helps, and the tabs are kept.
