// Versteckt die Ablage-Fenster der Workspaces-Erweiterung in Helium, Google Chrome,
// Chromium und weiteren Browsern aus kwinrc: nicht in Taskleiste, Alt+Tab, Übersicht
// oder Pager und immer minimiert. Erkannt werden sie am Titel "HWS-Ablage <Schlüssel>"; der geräteeigene
// Schlüssel steht in kwinrc (von install.sh gesetzt), damit Webseiten sich nicht als
// Ablage ausgeben können. Verliert ein Fenster die Markierung (z. B. Erweiterung
// deaktiviert), taucht es wieder in der Taskleiste auf, damit keine Tabs unsichtbar
// verloren gehen.
const TOKEN = String(readConfig("token", ""));
const MARK = "HWS-Ablage " + TOKEN + " ";
const hidden = {};
// Fensterklasse (X11) bzw. App-ID (Wayland) der Browser, deren Ablagen versteckt werden.
// install.sh --browsers setzt die Liste in kwinrc, kommagetrennt; ohne Eintrag gilt die
// Standardliste. Groß-/Kleinschreibung zählt nicht.
const BROWSERS = String(readConfig("browsers", "") || "helium,google-chrome,chromium,chromium-browser")
    .toLowerCase().split(",").map(function (s) { return s.trim(); }).filter(Boolean);

function isBrowser(w) {
    return BROWSERS.indexOf((w.resourceClass || "").toLowerCase()) !== -1;
}

function check(w) {
    if (!TOKEN || !w || !w.normalWindow) return;
    const id = String(w.internalId);
    const marked = (w.caption || "").indexOf(MARK) !== -1;
    if (marked && isBrowser(w)) {
        hidden[id] = true;
        if (!w.skipTaskbar) w.skipTaskbar = true;
        if (!w.skipSwitcher) w.skipSwitcher = true;
        if (!w.skipPager) w.skipPager = true;
        if (!w.minimized) w.minimized = true;
    } else if (hidden[id] || (marked && w.skipTaskbar)) {
        // Auch Ablagen eines Browsers, der nicht mehr in der Liste steht, kommen zurück
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
