# Updating and uninstalling

**English** · [Deutsch](./updating.de.md) · [Back to the README](../README.md)

The two steps of a normal update are in the [README](../README.md#updating).

## While reloading

When reloading, Chromium closes all pages of the extension, including the stash markers. The stash windows then show up in the taskbar briefly until the extension marks them again after one or two seconds. The tabs stay where they are.

## Once: switching to the fixed extension ID (from version 0.3.0)

Up to version 0.2.23 the extension's ID depended on the path of its folder. Since 0.3.0 the `key` field in `manifest.json` fixes it. On the first reload after updating, the extension therefore gets the new ID `jchklfejnmfphkbcpnhdejmeoncejjbe` once, and Helium treats it as a newly installed extension with empty storage: workspaces, backup, settings and key are missing, and Chromium closes the stash pages. The tabs stay in their windows; the old stashes are now ordinary minimized windows. To get everything back:

1. **Export before updating:** open **Export / Import** in the workspace list and save the export. Without one, the newest file of the automatic backup in `Downloads/helium-workspaces/` works too, the one with the latest modification date.
2. **Update** as described in the [README](../README.md#updating): `./install.sh --update`, then **Reload** in `chrome://extensions`. The workspace list then only shows "Default". Do not restart Helium until after the import, otherwise it restores the old stashes as normal windows and they stay visible afterwards.
3. **Import with Replace:** open **Export / Import**, choose the file from step 1, select **Replace** and click **Import** twice. The extension takes over windows whose tabs all belong to a workspace in the file, tabs and history included: the visible window shows its workspace again, the minimized ones become stashes again. Whatever is missing in them is added from the file.
4. **Enter the new key:** click **Copy** under **Key for install.sh** in the popup and run the command in the repository folder. Until then the stash windows show up in the taskbar. `install.sh` then lists the old and the new key; `./install.sh --remove <old key>` removes the old one.
5. **Check the settings:** the import takes **Mute stashes**, **Unload stashes after** and **Automatic backup** from a file made by version 0.2.22 or later; otherwise set them again. Set any shortcuts you chose yourself in `chrome://extensions/shortcuts` again. The extension no longer cleans up automatic backups with a date in their name in `Downloads/helium-workspaces/`, made by versions before 0.3.5; they can be deleted by hand.

Afterwards `chrome://extensions` also lists a switched-off "Workspaces" entry with the old ID. It does no harm; on start Helium only loads the extension with the new ID.

## Once: from a version with `extension/token.js`

Once, when updating from a version that kept the key in `extension/token.js`: after the reload the extension creates a new key, and the stash windows are visible. So after reloading, click **Copy** under **Key for install.sh** in the popup and run the command in the repository folder. `install.sh` then deletes the old `extension/token.js`.

## Uninstalling

Without the extension the stash windows lose their marker, but their tabs stay in the windows. To make sure no tabs keep running invisibly:

1. **Back up.** In the workspace list, open **Export / import** and save the export.
2. **Show every workspace once.** Switch through all workspaces once so that each one exists as a window. Workspaces that only exist in the backup (for example after a start with the new tab page) are created in the process. Resolve "tabs not restored" notices with **Try again**.
3. **Remove the KWin script.**

   ```bash
   ./install.sh --uninstall
   ```

   This brings the stash windows back to the taskbar and Alt+Tab, then unloads the script, removes it and deletes its entries from `kwinrc`. As with installing, run it in a terminal inside the Plasma session. If it cannot reach KWin, it stops without removing anything.
4. **Remove the extension.** In `chrome://extensions`, click **Remove** on "Workspaces". This deletes the workspaces and the backup from the profile. After that the repository folder can be deleted.

The stash windows stay minimized until you click them. Each one contains the tabs of one workspace. Merge or close the tabs as you like. Leftover tabs with the address `chrome-extension://…/stash.html#…` are empty and can be closed. If a window still stays invisible, quit Helium and start it again.
