// Runs before the page paints, so a reload doesn't flash the wrong theme or the wrong font.
(function () {
  var root = document.documentElement;
  try {
    var theme = window.localStorage.getItem("theme");
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  } catch (e) { /* storage can be blocked */ }

  if (!document.fonts || !document.fonts.load) return;
  root.classList.add("fonts-loading");
  var done = function () { root.classList.remove("fonts-loading"); };
  var wait = Promise.all([
    document.fonts.load('400 1rem "IBM Plex Sans"'),
    document.fonts.load('500 1rem "IBM Plex Sans"'),
    document.fonts.load('400 1rem "IBM Plex Mono"')
  ]);
  wait.then(done, done);
  setTimeout(done, 900); // never hold the page back for long on a slow connection
})();
