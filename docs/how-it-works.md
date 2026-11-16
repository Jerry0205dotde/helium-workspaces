# How it works

**English** · [Deutsch](./how-it-works.de.md) · [Back to the README](../README.md)

Every normal window shows exactly one workspace. The tabs of the workspaces that are not shown live in hidden **stash windows**, one per workspace. Switching moves the tabs between the windows instead of closing them. That is why they stay loaded.

Three parts work together:

- **The extension** (folder `extension/`) moves the tabs and creates the stash windows. The first, pinned tab of every stash is a page of the extension. It sets the window title to `HWS-Ablage <key> · <workspace name>`.
- **The key** is created on the first start of the extension and kept in its storage in the Helium profile. `install.sh` writes it to the KWin settings (`kwinrc`).
- **The KWin script** (folder `kwin/`) looks for browser windows whose title contains `HWS-Ablage` followed by this key. It removes them from the taskbar, Alt+Tab, the overview and the pager and keeps them minimized. A website therefore cannot pose as a stash, because it does not know the key.

## The key

On its first start the extension generates a random key and keeps it in its storage in the Helium profile. Websites cannot read it there. It does appear in the title of the stash tabs, though, and any other installed extension with the `tabs` permission can read that title. So the key protects against websites, not against other extensions. The popup shows it under **Key for install.sh**, and `install.sh` writes it to `kwinrc`. That way every device and every browser profile has its own key. If the key from the popup is not in `kwinrc`, the stash windows stay visible.

Several browsers or profiles with the extension, such as Helium and Chromium or two Helium profiles, each have their own key. Run `install.sh` with the key from each popup. A new key is added to the ones already set up, and `install.sh` then lists all of them. `./install.sh --remove <key>` removes a key that is no longer needed, for example after removing the extension from a profile. The stashes with that key then come back to the taskbar.

To bring workspaces to another device, use the [export](./usage.md#export-and-import). It does not contain the key.

## Google Chrome and Chromium

The extension also runs in Google Chrome and Chromium. It is installed the same way under `chrome://extensions`, and the [startup setting](../README.md#requirements) applies there too. It needs version 102 or newer; older versions refuse to install it. Two parts have to be told apart:

- **Extension:** creating, renaming, switching and deleting workspaces, moving tabs, pinned tabs and the keyboard shortcuts. This works the same as in Helium. Tested with Google Chrome 157.0.8103.78 and Chromium 160.0.8158.0.
- **Desktop integration:** the KWin script only hides stash windows of browsers it knows by their window class (X11) or app ID (Wayland): `helium`, `google-chrome`, `chromium` and `chromium-browser`. Tested with Google Chrome 157.0.8103.78 and Chromium 157.0.8103.38 under KWin 6.8.2, as native Wayland windows and as X11 windows via XWayland. Other browsers such as Brave, Vivaldi or Edge are only recognized once they are added to the list, see below. Until then their stash windows stay visible as minimized windows.

## Other browsers

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
