// Progressive enhancement: debounced (300 ms) live search; the plain form works without JS.
(function () {
  var input = document.getElementById("q"), out = document.getElementById("results");
  if (!input || !out) return;
  var timer, seq = 0;
  input.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      var q = input.value.trim(), mine = ++seq;
      if (!q) { out.innerHTML = ""; return; }
      fetch("/search/results?q=" + encodeURIComponent(q))
        .then(function (r) { return r.text(); })
        .then(function (html) { if (mine === seq) { out.innerHTML = html; history.replaceState(null, "", "/search?q=" + encodeURIComponent(q)); } })
        .catch(function () { out.textContent = "Search failed."; });
    }, 300);
  });
})();
