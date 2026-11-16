# Contributing

**English** · [Deutsch](./CONTRIBUTING.de.md) · [Back to the README](./README.md)

## Testing

```bash
node --test test/*.test.js
```

This only needs Node.js 22 or later, no browser and no KWin. The tests load `background.js` and the files it loads unchanged into a replica of the Chrome APIs and use it to run through switches with groups and pinned tabs, several windows, restarts with and without session restore, reloading the extension, deliberately failing API calls, changes in quick succession, and export and import including merging and replacing. On top of that come syntax, manifest and KWin metadata, and the KWin script runs against a replica of the KWin API to check which windows it hides. `install.sh` runs against stand-ins for the KDE commands: installing including the hint about the startup setting, the check for missing programs, several keys, `--help`, `--remove`, `--uninstall`, and `--update`, which pulls with real `git` from a test repository. The messages of `install.sh` are checked in German and English. The same checks run in CI on every pull request.

ESLint checks that every name used in the extension and the KWin script is defined, including in branches no test takes. The scripts that share a global scope (the service worker with everything `background.js` loads, each page with its `<script>` tags) are checked together, see [`eslint.config.js`](./eslint.config.js). CI runs it, locally it needs network access for `npx`:

```bash
npx eslint@10.14.0 extension kwin
```

If anything in `extension/` changes, the version in [`manifest.json`](./extension/manifest.json) must be higher than on `main`, otherwise `static.test.js` fails. The version is shown in the bottom right of the popup, so after an update you can see whether the new code is running. The KWin script carries the same version in [`metadata.json`](./kwin/metadata.json), `static.test.js` checks that too, and `install.sh` names it at the end. The comparison is against `origin/main`; `VERSION_BASE` selects a different ref. If the ref is missing, the check is skipped.

When a higher version lands on `main`, [`tag.yml`](./.github/workflows/tag.yml) tags that commit as `v<version>`, for example `v0.2.0`, and creates a [release](https://github.com/Jerry0205dotde/helium-workspaces/releases) listing the PRs since the previous version.

With a Chromium-based browser, the most important flows also run in a real browser:

```bash
CHROME=/usr/bin/chromium node --test test/chromium.test.js
```

[`chromium.test.js`](./test/chromium.test.js) installs the extension into a fresh profile and runs through: switching with a tab group and a pinned tab without reloading any page, reloading the extension, quitting and restarting with "Continue where you left off" and with "Open the New Tab page", and closing with the X button and restarting. A second test runs through switching to the fixed extension ID: installing without `key`, exporting, reloading with `key` and importing with **Replace**, without any page reloading. Without `CHROME` the tests are skipped, and without a display the browser stays invisible. In CI they run with Chrome for Testing.

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
    [`workspaces.js`](./extension/workspaces.js), [`export-import.js`](./extension/export-import.js), [`autobackup.js`](./extension/autobackup.js) (automatic backup to a file), [`unload.js`](./extension/unload.js) (unloading),
    [`sound.js`](./extension/sound.js) (sound), [`icons.js`](./extension/icons.js) (icons) and [`menus.js`](./extension/menus.js) (context menu)
  - [`popup.html`](./extension/popup.html) / [`popup.js`](./extension/popup.js): the workspace list
  - [`transfer.html`](./extension/transfer.html) / [`transfer.js`](./extension/transfer.js): export and import, [`exchange.js`](./extension/exchange.js): the file format and its validation
  - [`stash.html`](./extension/stash.html) / [`stash.js`](./extension/stash.js): the page that marks a window as a stash
  - [`label.js`](./extension/label.js): the character shown in a workspace's icon
- [`kwin/`](./kwin): KWin script that hides the stash windows
- [`docs/`](./docs): the detailed documentation and the pictures in the README
- [`install.sh`](./install.sh): set up the KWin script and write the key, remove a key with `--remove`, update with `--update`, remove it again with `--uninstall`
- [`test/`](./test): automated tests, [`fake-browser.js`](./test/fake-browser.js) replicates the Chrome APIs, [`page.js`](./test/page.js) drives the popup and the import page in Chromium, [`chromium.js`](./test/chromium.js) drives a real Chromium
