(function () {
  // sterren-picker + review plaatsen
  document.querySelectorAll(".xpo-reviews[data-reviews]").forEach(function (box) {
    var pid = box.getAttribute("data-reviews");
    var starsEl = box.querySelector(".xrv-stars");
    var rating = 5;
    if (starsEl) {
      function paint() { starsEl.querySelectorAll("span").forEach(function (s) { s.classList.toggle("on", (parseInt(s.getAttribute("data-v"), 10) || 0) <= rating); }); }
      starsEl.querySelectorAll("span").forEach(function (s) { s.addEventListener("click", function () { rating = parseInt(s.getAttribute("data-v"), 10) || 5; starsEl.setAttribute("data-rating", rating); paint(); }); });
      paint();
    }
    var form = box.querySelector(".xrv-form");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      var d = {}; new FormData(form).forEach(function (v, k) { d[k] = v; });
      d.rating = rating;
      var msg = form.querySelector(".xrv-msg");
      fetch("/api/products/" + encodeURIComponent(pid) + "/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })
        .then(function (r) { return r.json(); }).then(function (res) {
          if (res && res.id) { form.reset(); if (msg) { msg.hidden = false; msg.textContent = "Bedankt! Je review wordt na goedkeuring geplaatst."; } }
          else if (msg) { msg.hidden = false; msg.textContent = (res && res.error) || "Plaatsen mislukt."; }
        }).catch(function () { if (msg) { msg.hidden = false; msg.textContent = "Plaatsen mislukt."; } });
    });
  });
})();
