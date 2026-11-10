// Versteckt Helium-Fenster, deren Titel "HWS-Ablage" enthält (die Ablage-Fenster der
// Workspaces-Erweiterung): nicht in Taskleiste, Alt+Tab, Übersicht oder Pager und
// immer minimiert. Verliert ein Fenster die Markierung (z. B. Erweiterung deaktiviert),
// taucht es wieder in der Taskleiste auf, damit keine Tabs unsichtbar verloren gehen.
const MARK = "HWS-Ablage";
const hidden = {};

function isHelium(w) {
    const c = (w.resourceClass || "").toLowerCase();
    return c.indexOf("helium") !== -1 || c.indexOf("chrom") !== -1;
}

function check(w) {
    if (!w || !w.normalWindow || !isHelium(w)) return;
    const stash = (w.caption || "").indexOf(MARK) !== -1;
    if (stash) {
        hidden[String(w.internalId)] = true;
        if (!w.skipTaskbar) w.skipTaskbar = true;
        if (!w.skipSwitcher) w.skipSwitcher = true;
        if (!w.skipPager) w.skipPager = true;
        if (!w.minimized) w.minimized = true;
    } else if (hidden[String(w.internalId)]) {
        delete hidden[String(w.internalId)];
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
