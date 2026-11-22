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
3. To repair, run `./install.sh` in the repository folder, answer the question with <kbd>Enter</kbd> (registers `native-host.sh` again, the keys are kept) and open the popup. If the stashes stay visible, click **Copy** under **Key for install.sh** in the popup and run the command in the repository folder. The script reloads the KWin script, and after one or two seconds the stashes disappear from the taskbar.

## `install.sh` aborts

- **`Programs that install.sh needs are missing`**: install the programs listed below it from the [requirements](../README.md#requirements). `install.sh` has not changed anything yet.
- **`Invalid key`**: an incomplete key was entered. <kbd>Enter</kbd> without input leaves writing the key to the extension. In the popup, click **Copy** under **Key for install.sh** and run the copied command. The key consists of 24 characters `0`–`9` and `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Service 'org.kde.KWin' does not exist.`** or **`Cannot find 'org.kde.kwin.Scripting.isScriptLoaded' in object /Scripting at org.kde.KWin`**: `install.sh` cannot reach KWin, for example over SSH, in a text console or outside Plasma. `install.sh` has not changed anything yet. Run it again in a terminal inside the Plasma session.
- **`KWin script was not loaded`**: KWin was reachable, and the package and `kwinrc` are already updated, but KWin did not load the script afterwards. Run `./install.sh` again in a terminal inside the Plasma session (<kbd>Enter</kbd> keeps the key) and check whether the script can be loaded under *Window Management → KWin Scripts* in System Settings. After `--update`, the repository is already on the new version; once `./install.sh` succeeds, reload the extension in `chrome://extensions`.

## Tabs are missing after a restart

If the workspace list shows "… tabs not restored", Helium could not recreate these tabs. **Try again** switches to the workspace and creates them once more. If tabs are missing without this notice, wait a moment. The assignment after startup takes up to 20 seconds.

## After a restart the extension is gone and stashes show `ERR_BLOCKED_BY_CLIENT`

If a window shows "jchklfejnmfphkbcpnhdejmeoncejjbe is blocked – This page has been blocked by Helium" after the start and the extension's icon is missing, Helium did not load it on start. The cause is an entry with the old ID from before 0.3.0 that points to the same folder (see [Switching to the fixed extension ID](./updating.md#once-switching-to-the-fixed-extension-id-from-version-030)). Neither of the two shows up in `chrome://extensions`.

1. **Do not close** the stash windows with the error page, their tabs belong to the workspaces.
2. Quit Helium.
3. Run `./install.sh` in the repository folder and answer the question with <kbd>Enter</kbd>. It reports "Removed old entries of the extension". This needs `python3`. If Helium is still running, it changes nothing and says so.
4. Start Helium. The extension loads again with its workspaces, backup and key, and the stashes are hidden again.

## The extension is disabled or does not respond

If the extension is switched off in `chrome://extensions`, developer mode was usually off. The stash windows are then in the taskbar. Turn developer mode back on; the extension is then active again and marks the stashes anew.

Otherwise click **Errors** or **service worker** on "Workspaces". Messages of the extension start with `[workspaces]`. **Reload** often helps, and the tabs are kept.
