// Übersetzte Texte aus _locales/<Sprache>/messages.json. Chrome wählt die Sprache des
// Browsers und nimmt, wo es sie nicht gibt, default_locale aus dem Manifest. $1 bis $9 in
// einem Text werden durch die weiteren Argumente ersetzt.
const tr = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

// Menge mit passender Form, z. B. plural(n, 'tabs') aus tabs_one oder tabs_other
const plural = (n, key) => tr(`${key}_${n === 1 ? 'one' : 'other'}`, n);

// Setzt die Texte einer Seite (data-i18n den Inhalt, data-i18n-title den Titel) und
// ihre Sprache
function localize() {
  document.documentElement.lang = tr('lang');
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = tr(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = tr(e.dataset.i18nTitle);
}
