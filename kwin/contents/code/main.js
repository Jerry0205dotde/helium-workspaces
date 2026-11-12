// Versteckt die Ablage-Fenster der Workspaces-Erweiterung in Helium, Google Chrome
// und Chromium: nicht in Taskleiste, Alt+Tab, Übersicht oder Pager und immer
// minimiert. Erkannt werden sie am Titel "HWS-Ablage <Schlüssel>"; der geräteeigene
// Schlüssel steht in kwinrc (von install.sh gesetzt), damit Webseiten sich nicht als
// Ablage ausgeben können. Verliert ein Fenster die Markierung (z. B. Erweiterung
// deaktiviert), taucht es wieder in der Taskleiste auf, damit keine Tabs unsichtbar
// verloren gehen.
const TOKEN = String(readConfig("token", ""));
const MARK = "HWS-Ablage " + TOKEN + " ";
const hidden = {};
// Fensterklasse (X11) bzw. App-ID (Wayland) der unterstützten Browser, kleingeschrieben
const BROWSERS = ["helium", "google-chrome", "chromium", "chromium-browser"];

function isBrowser(w) {
    return BROWSERS.indexOf((w.resourceClass || "").toLowerCase()) !== -1;
}

function check(w) {
    if (!TOKEN || !w || !w.normalWindow || !isBrowser(w)) return;
    const id = String(w.internalId);
    if ((w.caption || "").indexOf(MARK) !== -1) {
        hidden[id] = true;
        if (!w.skipTaskbar) w.skipTaskbar = true;
        if (!w.skipSwitcher) w.skipSwitcher = true;
        if (!w.skipPager) w.skipPager = true;
        if (!w.minimized) w.minimized = true;
    } else if (hidden[id]) {
        delete hidden[id];
        w.skipTaskbar = false;
        w.skipSwitcher = false;
        w.skipPager = false;
    }
}

function watch(w) {
    check(w);
    w.captionChanged.connect(function () { check(w); });
    w.minimizedChanged.connect(function () { check(w); });
    w.closed.connect(function () { delete hidden[String(w.internalId)]; });
}

workspace.windowList().forEach(watch);
workspace.windowAdded.connect(watch);
