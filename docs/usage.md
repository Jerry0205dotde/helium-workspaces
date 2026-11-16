# Usage in detail

**English** · [Deutsch](./usage.de.md) · [Back to the README](../README.md)

The keyboard shortcuts and the most important actions are in the [README](../README.md#usage).

## The workspace list

- The list can be used entirely by keyboard: <kbd>Tab</kbd> to move, <kbd>↑</kbd> / <kbd>↓</kbd> picks a workspace, <kbd>Enter</kbd> switches to it, <kbd>1</kbd>–<kbd>9</kbd> switches directly, <kbd>Esc</kbd> closes the editor. Reordering works in the editor with ↑ / ↓.
- Pinned tabs belong to all workspaces and always stay in the window.
- Tab groups survive switching.
- If you pick a tab from a stash window, for example via the tab search, the last used main window shows its workspace with the selected tab.
- Several windows may show the same workspace, for example after <kbd>Ctrl</kbd>+<kbd>N</kbd>. Clicking a workspace in the list that another window shows brings that window to the front.
- A deleted workspace can be brought back with **Undo** at the top of the list until the browser restarts, tabs included. Its tabs then open again from the backup when you switch to it. The same goes for the workspaces removed by **Replace** on import.

## Unloading stashes

**Unload stashes after** (default: **never**) unloads the tabs in a stash once they have been there for that long. The time counts from switching away from the workspace. Unloaded tabs free their memory and keep their address, title, group and back history. When you switch back they reload; playing videos, scroll position and unsaved input are gone then. Tabs whose sound can be heard, or could be heard within that time, stay loaded, such as a video call in which nobody is talking right now; muted ones are unloaded too.

## Closing the last window

If the last window is closed with the X button, or its last tab is closed, the extension closes the stash windows as well, and the browser quits. On the next start it rebuilds the workspaces from its backup. The pages then reload and have no back history (see [What is preserved](#what-is-preserved)). With "Continue where you left off", Helium brings back the window closed last, including its history. So the extension closes the stash of the workspace shown before the current one last, otherwise the one with the most tabs. If you quit Helium from the menu, the windows come back with their history.

## Export and import

The export is a JSON file with all workspaces including order, colors, emoji, tabs, tab groups and pinned tabs, plus the settings **Mute stashes**, **Unload stashes after** and **Automatic backup**, for example for another device or a new profile. On import the file is first checked and summarized; the summary names the settings that change. Both kinds of import apply them. **Merge** only adds what is missing: a workspace with the same ID or the same name gets the tabs it does not have yet. **Replace** deletes the existing workspaces including their tabs and therefore asks for confirmation. A window whose tabs all belong to a workspace in the file and make up more than half of that workspace's tabs stays open and shows that workspace; if it is minimized, it becomes that workspace's stash. Its tabs keep their history that way.

## Automatic backup

Under **Export / Import → Automatic backup** the extension can save an export to `Downloads/helium-workspaces/` daily or weekly and keeps the last 10: it writes `helium-workspaces-auto-1.json` to `helium-workspaces-auto-10.json` in turn and overwrites the oldest, even if the download history was cleared. The date is in the file and in its modification date. The default is **never**. These files survive removing the extension and a broken profile; the workspaces then come back by importing with **Replace**. If “Ask where to save each file before downloading” is on in Helium, Helium asks for every automatic backup too. If one fails, the popup shows a notice with **Back up now**. While automatic backup is off and there are at least two workspaces, the popup points to it once; ✕ hides that notice for good.

The export and the automatic backup contain the full addresses and titles of all tabs in plain text, including any access tokens or sharing and password reset links in them. Syncing the Downloads folder or passing on a file passes those on too.

## What is preserved

The extension stores permanently in the profile:

- the workspaces with name, color, emoji and order as well as the workspace used last,
- a backup of all tabs with address, title and tab group, plus the pinned tabs,
- the last three states of these (workspaces and backup) from before a browser start. If a start assigns tabs wrongly and so overwrites the backup, **Export / Import → Import** brings one of them back like a file, with **Replace** preselected.

Only within the running browser session:

- which window shows which workspace and which tab was last active in each workspace,
- the state of the loaded pages: playing videos, scroll position, form input and the back history of every tab, as long as it is not created anew.

After a restart with "Continue where you left off", Helium itself restores all windows including the stashes, with history. During the first 20 seconds the extension assigns the windows back to the workspaces based on their addresses. The pages reload as they do after any browser restart.

A workspace is rebuilt from the backup when its window is missing: after a start with a different startup setting, after closing the last window with the X button or closing its last tab, or on import. Then only address, title, group and pinned tabs come back. The pages reload, have no back history, and unsaved input is gone. So that not all of these pages load at once, the extension creates the tabs in batches: at most six load at the same time, and the next one follows as soon as one has finished, at the latest after 15 seconds. So that not all of these pages stay loaded, it unloads every tab created this way as soon as it has finished loading, except the active one. It reloads when you click it. Logins stay, because cookies belong to the profile.

Helium (or rather Chromium) occasionally loses a tab on restart if it was being moved between two windows at the very moment the session file was rewritten. The extension detects this on startup and recreates missing tabs in the same position. Such tabs then reload and no longer have a back history.
