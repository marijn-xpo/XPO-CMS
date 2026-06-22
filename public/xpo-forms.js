(function () {
  var forms = document.querySelectorAll(".xpo-form[data-form]");
  if (!forms.length) return;
  forms.forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var id = f.getAttribute("data-form"); if (!id) return;
      var data = {};
      new FormData(f).forEach(function (v, k) { data[k] = v; });
      var btn = f.querySelector(".xfm-submit"); if (btn) btn.disabled = true;
      var msg = f.querySelector(".xfm-msg");
      fetch("/api/public/forms/" + encodeURIComponent(id) + "/submit", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: data })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (btn) btn.disabled = false;
        if (res && res.id) { f.reset(); if (msg) { msg.hidden = false; msg.textContent = "Bedankt! Je bericht is verzonden."; } }
        else if (msg) { msg.hidden = false; msg.textContent = (res && res.error) || "Versturen mislukt."; }
      }).catch(function () { if (btn) btn.disabled = false; if (msg) { msg.hidden = false; msg.textContent = "Versturen mislukt."; } });
    });
  });
})();
