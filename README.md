# Helium Workspaces

**English** · [Deutsch](./README.de.md)

Helium Workspaces brings Opera-style workspaces to the [Helium browser](https://github.com/imputnet/helium-linux): several sets of tabs in the same window, switchable by click or keyboard shortcut. Nothing reloads when you switch, so videos and logins simply keep going.

It consists of a browser extension and a small KWin script for KDE Plasma. The extension speaks English and German and follows the language of the browser. The UI names in this README are the English ones.

## "Why not just use profiles?"

Profiles separate everything: logins, history, extensions, and every profile needs its own window. I only wanted to separate the tabs, for example "Me" and "Uni", and still stay logged in everywhere.

Helium doesn't have that built in, so I built it.

## How it works

Every normal window shows exactly one workspace. The tabs of the workspaces that are not shown live in hidden **stash windows**, one per workspace. Switching moves the tabs between the windows instead of closing them. That is why they stay loaded.

Three parts work together:

- **The extension** (folder `extension/`) moves the tabs and creates the stash windows. The first, pinned tab of every stash is a page of the extension. It sets the window title to `HWS-Ablage <key> · <workspace name>`.
- **The key** is created on the first start of the extension and kept in its storage in the Helium profile. `install.sh` writes it to the KWin settings (`kwinrc`).
- **The KWin script** (folder `kwin/`) looks for browser windows whose title contains `HWS-Ablage` followed by this key. It removes them from the taskbar, Alt+Tab, the overview and the pager and keeps them minimized. A website therefore cannot pose as a stash, because it does not know the key.

### Limitations

- Tabs in stashes stay loaded. They keep using memory, and videos or music keep playing in the background. With **Mute stashes** in the workspace list they at least play silently. With **Unload stashes after** they are unloaded after a chosen time (see below).
- Pinned tabs belong to all workspaces and always stay in the main window.
- Several windows can show the same workspace, for example after <kbd>Ctrl</kbd>+<kbd>N</kbd>.
- Incognito windows are not handled.
- The extension also works without the KWin script, but the stash windows are then visible as minimized windows.

## Requirements

- [Helium](https://github.com/imputnet/helium-linux) on Linux. Tested with Helium 0.21.
- KDE Plasma 6 with KWin 6, on Wayland or X11. Other desktops do not hide the stash windows.
- For `install.sh`: `bash`, `tr` and `git` as well as `kpackagetool6`, `kreadconfig6`, `kwriteconfig6` and `qdbus6`. On Arch the packages are called `coreutils`, `kpackage`, `kconfig` and `qt6-tools`.
- A running Plasma session. `install.sh` loads the script straight into KWin over the D-Bus of that session. The safest way is to run it in a terminal inside the session.
- In Helium, under *Settings → On startup*, the option **"Continue where you left off"**. With any other startup setting Helium does not restore the stash windows on startup. The extension then rebuilds the workspaces from its backup, but the tabs reload and lose their history (see [What is preserved](#what-is-preserved)). At the end, `install.sh` lists the Helium, Google Chrome and Chromium profiles that lack this option and changes nothing there.

### Google Chrome and Chromium

The extension also runs in Google Chrome and Chromium. It is installed the same way under `chrome://extensions`, and the startup setting above applies there too. Two parts have to be told apart:

- **Extension:** creating, renaming, switching and deleting workspaces, moving tabs, pinned tabs and the keyboard shortcuts. This works the same as in Helium. Tested with Google Chrome 157.0.8103.78 and Chromium 160.0.8158.0.
- **Desktop integration:** the KWin script only hides stash windows of browsers it knows by their window class (X11) or app ID (Wayland): `helium`, `google-chrome`, `chromium` and `chromium-browser`. Tested with Google Chrome 157.0.8103.78 and Chromium 157.0.8103.38 under KWin 6.8.2, as native Wayland windows and as X11 windows via XWayland. Other browsers such as Brave, Vivaldi or Edge are only recognized once they are added to the list, see below. Until then their stash windows stay visible as minimized windows.

### Other browsers

`install.sh --browsers` sets which window classes (X11) or app IDs (Wayland) the KWin script recognizes, separated by commas and not case-sensitive. The list replaces the default list `helium,google-chrome,chromium,chromium-browser`, so it has to name every browser you use:

```bash
./install.sh --browsers helium,brave-browser
```

The setting is kept for later runs of `install.sh` without `--browsers`. `--browsers ''` restores the default list.

To find a browser's window class, run this in a terminal inside the Plasma session and then click a window of the browser:

```bash
qdbus6 org.kde.KWin /KWin org.kde.KWin.queryWindowInfo | grep resourceClass
```

Alternatively in System Settings under **Window Management → Window Rules**: click **Add New…**, then **Detect Window Properties** and click a window of the browser. **Window class (application)** shows the same value. Flatpak versions may report a different class than the system package.

## Installation

### First installation

1. Clone the repository:

   ```bash
   git clone https://github.com/Jerry0205dotde/helium-workspaces.git
   cd helium-workspaces
   ```

2. Open `chrome://extensions` in Helium and turn on **Developer mode** in the top right.
3. Choose **Load unpacked** and select the folder `extension/` from the repository.
4. Pin the workspace button to the toolbar.
5. Click the workspace button, expand **Key for install.sh** at the bottom and click **Copy**. This copies the complete command including the key:

   ```bash
   ./install.sh <key>
   ```

   Paste it into a terminal in the repository folder and run it. It sets up the KWin script.

   The last line of output is `Fertig.` ("Done."). The KWin script is then installed, enabled and loaded, and it knows the key.
6. To check, create a second workspace and switch back and forth. No additional browser window may appear in the taskbar.

Do not move the folder after loading it. Helium loads the extension from exactly this folder on every start. Leave developer mode turned on. Without it Helium disables unpacked extensions.

### Updating

There are no automatic updates. Helium loads the extension straight from the repository folder, so a new version only arrives when you fetch it yourself:

1. Fetch the new version and update the KWin script:

   ```bash
   cd helium-workspaces
   ./install.sh --update
   ```

   This runs `git pull --ff-only` and sets up the KWin script again without asking. The key and the browser list are kept.
2. In `chrome://extensions`, click **Reload** (the circular arrow) on "Workspaces". Restarting Helium is not enough, the old background logic can still be running afterwards. At the end `install.sh` names the new version, the popup shows it in the bottom right.

When reloading, Chromium closes all pages of the extension, including the stash markers. The stash windows then show up in the taskbar briefly until the extension marks them again after one or two seconds. The tabs stay where they are.

Do not remove and re-add the extension to update it. When it is removed, Helium deletes all workspaces and the backup.

Once, when updating from a version that kept the key in `extension/token.js`: after the reload the extension creates a new key, and the stash windows are visible. So after step 2, click **Copy** under **Key for install.sh** in the popup and run the command in the repository folder. `install.sh` then deletes the old `extension/token.js`.

### The key

On its first start the extension generates a random key and keeps it in its storage in the Helium profile. Websites cannot read it there. The popup shows it under **Key for install.sh**, and `install.sh` writes it to `kwinrc`. That way every device has its own key. If the key in `kwinrc` does not match the one in the popup, the stash windows stay visible.

To bring workspaces to another device, use the export (see below). It does not contain the key.

## Usage

| Action | How |
| --- | --- |
| Open the workspace list | Toolbar button or <kbd>Alt</kbd>+<kbd>W</kbd> |
| Next / previous workspace | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↓</kbd> / <kbd>↑</kbd>, or in the list <kbd>↓</kbd> / <kbd>↑</kbd> and <kbd>Enter</kbd> |
| Back to the last used workspace | <kbd>Alt</kbd>+<kbd>Q</kbd>, pressing it again jumps back (like Alt+Tab) |
| Straight to workspace 1–9 | set your own shortcuts at `chrome://extensions/shortcuts` (Chromium suggests at most four), or <kbd>1</kbd>–<kbd>9</kbd> in the list |
| Create a workspace, rename it, change its color or emoji, delete it | in the list |
| Change the order | drag in the list |
| Move a tab to another workspace | Right-click anywhere on the page, including a link, an image or selected text → **Move tab to workspace**, or click ↪ next to the target in the list |
| Move several tabs at once | Select the tabs with <kbd>Ctrl</kbd> / <kbd>Shift</kbd>, then as above. Fully selected groups keep their title and color. |
| Move a whole tab group | In a tab of the group, right-click the page → **Move group to workspace** |
| Export or import workspaces | in the list → **Export / import** |
| Mute a workspace | in the list, click 🔊 next to the workspace (shown while something in it is audible) |
| Always mute workspaces that are not shown | in the list, tick **Mute stashes**. Tabs get their sound back when they return; tabs muted by hand stay muted. |
| Unload the tabs of workspaces not shown | in the list → **Unload stashes after** |

Good to know:

- The list can be used entirely by keyboard: <kbd>Tab</kbd> to move, <kbd>↑</kbd> / <kbd>↓</kbd> picks a workspace, <kbd>Enter</kbd> switches to it, <kbd>1</kbd>–<kbd>9</kbd> switches directly, <kbd>Esc</kbd> closes the editor. Reordering works in the editor with ↑ / ↓.
- Pinned tabs belong to all workspaces and always stay in the window.
- Tab groups survive switching.
- If you pick a tab from a stash window, for example via the tab search, the last used main window shows its workspace with the selected tab.
- Several windows may show the same workspace, for example after <kbd>Ctrl</kbd>+<kbd>N</kbd>.
- **Unload stashes after** (default: **never**) unloads the tabs in a stash once they have been there for that long. The time counts from switching away from the workspace. Unloaded tabs free their memory and keep their address, title, group and back history. When you switch back they reload; playing videos, scroll position and unsaved input are gone then. Tabs whose sound can be heard stay loaded; muted ones are unloaded too.
- A deleted workspace can be brought back with **Undo** at the top of the list until the browser restarts, tabs included. Its tabs then open again from the backup when you switch to it. The same goes for the workspaces removed by **Replace** on import.
- If the window is closed with the X button, the extension rebuilds all workspaces from its backup on the next start.
- The export is a JSON file with all workspaces including order, colors, emoji, tabs, tab groups and pinned tabs, for example for another device or a new profile. On import the file is first checked and summarized. **Merge** only adds what is missing: a workspace with the same ID or the same name gets the tabs it does not have yet. **Replace** deletes the existing workspaces including their tabs and therefore asks for confirmation.

## What is preserved

The extension stores permanently in the profile:

- the workspaces with name, color, emoji and order as well as the workspace used last,
- a backup of all tabs with address, title and tab group, plus the pinned tabs.

Only within the running browser session:

- which window shows which workspace and which tab was last active in each workspace,
- the state of the loaded pages: playing videos, scroll position, form input and the back history of every tab, as long as it is not created anew.

After a restart with "Continue where you left off", Helium itself restores all windows including the stashes, with history. During the first 20 seconds the extension assigns the windows back to the workspaces based on their addresses. The pages reload as they do after any browser restart.

A workspace is rebuilt from the backup when its window is missing: after a start with a different startup setting, after closing the last window with the X button, or on import. Then only address, title, group and pinned tabs come back. The pages reload, have no back history, and unsaved input is gone. So that not all of these pages stay loaded, the extension unloads every tab created this way as soon as it has finished loading, except the active one. It reloads when you click it. Logins stay, because cookies belong to the profile.

Helium (or rather Chromium) occasionally loses a tab on restart if it was being moved between two windows at the very moment the session file was rewritten. The extension detects this on startup and recreates missing tabs in the same position. Such tabs then reload and no longer have a back history.

## Troubleshooting

### Stash windows are visible in the taskbar or Alt+Tab

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

   The output must be the key the popup shows under **Key for install.sh**, and the window title must show it after `HWS-Ablage`. If the title contains no key (`HWS-Ablage · Uni`), reload the extension in `chrome://extensions`.
3. To repair, click **Copy** under **Key for install.sh** in the popup and run the command in the repository folder. The script reloads the KWin script, and after one or two seconds the stashes disappear from the taskbar.

### `install.sh` aborts

The messages of `install.sh` itself are in German.

- **`command not found`** or **`Kommando nicht gefunden`**: a program from the [requirements](#requirements) is missing.
- **`Ungültiger Schlüssel`** ("invalid key"): no key or an incomplete key was entered. In the popup, click **Copy** under **Key for install.sh** and run the copied command. The key consists of 24 characters `0`–`9` and `a`–`f`.
- **`Could not connect to D-Bus server`**, **`Cannot find 'org.kde.kwin.Scripting.unloadScript' in object /Scripting at org.kde.KWin`** or **`KWin-Skript wurde nicht geladen`** ("KWin script was not loaded"): `install.sh` cannot reach KWin, for example over SSH or in a text console. The script is then already installed but not loaded. Run it again in a terminal inside the Plasma session.

### Tabs are missing after a restart

If the workspace list shows "… tabs not restored", Helium could not recreate these tabs. **Try again** switches to the workspace and creates them once more. If tabs are missing without this notice, wait a moment. The assignment after startup takes up to 20 seconds.

### The extension is disabled or does not respond

If the extension is switched off in `chrome://extensions`, developer mode was usually off. The stash windows are then in the taskbar. Turn developer mode back on; the extension is then active again and marks the stashes anew.

Otherwise click **Errors** or **service worker** on "Workspaces". Messages of the extension start with `[workspaces]`. **Reload** often helps, and the tabs are kept.

## Uninstalling

Without the extension the stash windows lose their marker, but their tabs stay in the windows. Only the running KWin script brings these windows back to the taskbar. To make sure no tabs keep running invisibly, follow this order:

1. **Back up.** In the workspace list, open **Export / import** and save the export.
2. **Show every workspace once.** Switch through all workspaces once so that each one exists as a window. Workspaces that only exist in the backup (for example after a start with the new tab page) are created in the process. Resolve "tabs not restored" notices with **Try again**.
3. **Make the stashes visible.** In `chrome://extensions`, **disable** the extension with the toggle; do not remove it yet. The KWin script then brings the stash windows back to the taskbar and Alt+Tab. They stay minimized until you click them. Each window contains the tabs of one workspace. Merge or close the tabs as you like. Leftover tabs with the address `chrome-extension://…/stash.html#…` are empty and can be closed.
4. **Remove the KWin script.** Only now, because hidden windows do not reappear without the running script:

   ```bash
   ./install.sh --uninstall
   ```

   This unloads the script, removes it and deletes its entries from `kwinrc`. As with installing, run it in a terminal inside the Plasma session. If it cannot reach KWin, it stops without removing anything.

   If the script was removed too early, quit Helium and start it again. After that the windows are visible normally again.
5. **Remove the extension.** In `chrome://extensions`, click **Remove** on "Workspaces". This deletes the workspaces and the backup from the profile. After that the repository folder can be deleted.

## A few notes

This is a private hobby project. Expect bugs.

## Testing

```bash
node --test test/*.test.js
```

This only needs Node.js 22 or later, no browser and no KWin. The tests load `background.js` and the files it loads unchanged into a replica of the Chrome APIs and use it to run through switches with groups and pinned tabs, several windows, restarts with and without session restore, reloading the extension, deliberately failing API calls, changes in quick succession, and export and import including merging and replacing. On top of that come syntax, manifest and KWin metadata, and the KWin script runs against a replica of the KWin API to check which windows it hides. `install.sh` runs against stand-ins for the KDE commands: installing including the hint about the startup setting, `--uninstall`, and `--update`, which pulls with real `git` from a test repository. The same checks run in CI on every pull request.

If anything in `extension/` changes, the version in [`manifest.json`](./extension/manifest.json) must be higher than on `main`, otherwise `static.test.js` fails. The version is shown in the bottom right of the popup, so after an update you can see whether the new code is running. The comparison is against `origin/main`; `VERSION_BASE` selects a different ref. If the ref is missing, the check is skipped.

When a higher version lands on `main`, [`tag.yml`](./.github/workflows/tag.yml) tags that commit as `v<version>`, for example `v0.2.0`.

With a Chromium-based browser, the most important flows also run in a real browser:

```bash
CHROME=/usr/bin/chromium node --test test/chromium.test.js
```

[`chromium.test.js`](./test/chromium.test.js) installs the extension into a fresh profile and runs through: switching with a tab group and a pinned tab without reloading any page, reloading the extension, quitting and restarting with "Continue where you left off" and with "Open the New Tab page", and closing with the X button and restarting. Without `CHROME` the test is skipped, and without a display the browser stays invisible. In CI it runs with Chrome for Testing.

The same `CHROME` also runs [`popup.test.js`](./test/popup.test.js) and [`transfer.test.js`](./test/transfer.test.js): the popup and the import page in headless Chromium, driven with real mouse and keyboard events. They check leaving a field by click, <kbd>Tab</kbd>, <kbd>Enter</kbd> and <kbd>Esc</kbd>, confirmations and double clicks. The pages' messages go to the replica of the Chrome APIs, not to an installed extension.

The tests do not check KWin. After changing that, briefly check by hand:

1. Reload the extension in `chrome://extensions` and run `./install.sh` with the key from the popup.
2. Set up two workspaces and switch back and forth a few times: no stash window appears in the taskbar, <kbd>Alt</kbd>+<kbd>Tab</kbd> or the overview.
3. Reload the extension in `chrome://extensions`: after about a second the stash windows are hidden again.
4. Quit Helium and start it again: the stash windows stay hidden.

## Structure

- [`extension/`](./extension): the extension (Manifest V3)
  - [`background.js`](./extension/background.js): the service worker, receives events and messages and loads the rest of the background logic:
    [`core.js`](./extension/core.js) (basics), [`switch.js`](./extension/switch.js) (switching), [`backup.js`](./extension/backup.js) (backup),
    [`restore.js`](./extension/restore.js) (restoring from the backup), [`reconcile.js`](./extension/reconcile.js) (reconciliation after a restart),
    [`workspaces.js`](./extension/workspaces.js), [`export-import.js`](./extension/export-import.js), [`unload.js`](./extension/unload.js) (unloading),
    [`sound.js`](./extension/sound.js) (sound), [`icons.js`](./extension/icons.js) (icons) and [`menus.js`](./extension/menus.js) (context menu)
  - [`popup.html`](./extension/popup.html) / [`popup.js`](./extension/popup.js): the workspace list
  - [`transfer.html`](./extension/transfer.html) / [`transfer.js`](./extension/transfer.js): export and import, [`exchange.js`](./extension/exchange.js): the file format and its validation
  - [`stash.html`](./extension/stash.html) / [`stash.js`](./extension/stash.js): the page that marks a window as a stash
  - [`label.js`](./extension/label.js): the character shown in a workspace's icon
- [`kwin/`](./kwin): KWin script that hides the stash windows
- [`install.sh`](./install.sh): set up the KWin script and write the key, update with `--update`, remove it again with `--uninstall`
- [`test/`](./test): automated tests, [`fake-browser.js`](./test/fake-browser.js) replicates the Chrome APIs, [`page.js`](./test/page.js) drives the popup and the import page in Chromium, [`chromium.js`](./test/chromium.js) drives a real Chromium

## License

[GPL-3.0-or-later](./LICENSE). You may use, change and share Helium Workspaces, as long as anything you pass on based on it is also under the GPL and comes with its source code.
