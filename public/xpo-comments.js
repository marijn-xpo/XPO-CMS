(function () {
  var forms = document.querySelectorAll(".xcm-form[data-post]");
  if (!forms.length) return;
  forms.forEach(function (f) {
    var parentField = f.querySelector(".xcm-parent");
    var replyTo = f.querySelector(".xcm-replyto");
    var replyName = f.querySelector(".xcm-replyname");
    var box = f.closest(".xpo-comments") || document;
    // antwoordknoppen
    box.querySelectorAll(".xcm-reply").forEach(function (b) {
      b.addEventListener("click", function () {
        if (parentField) parentField.value = b.getAttribute("data-parent") || "";
        if (replyName) replyName.textContent = b.getAttribute("data-name") || "reactie";
        if (replyTo) replyTo.hidden = false;
        f.scrollIntoView({ behavior: "smooth", block: "center" });
        var ta = f.querySelector("textarea"); if (ta) ta.focus();
      });
    });
    var cancel = f.querySelector(".xcm-cancel");
    if (cancel) cancel.addEventListener("click", function () { if (parentField) parentField.value = ""; if (replyTo) replyTo.hidden = true; });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var id = f.getAttribute("data-post"); if (!id) return;
      var data = {}; new FormData(f).forEach(function (v, k) { data[k] = v; });
      var msg = f.querySelector(".xcm-msg");
      fetch("/api/posts/" + encodeURIComponent(id) + "/comments", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data)
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.id) {
          f.reset(); if (parentField) parentField.value = ""; if (replyTo) replyTo.hidden = true;
          if (msg) { msg.hidden = false; msg.textContent = "Bedankt! Je reactie wordt na goedkeuring geplaatst."; }
        } else if (msg) { msg.hidden = false; msg.textContent = (res && res.error) || "Plaatsen mislukt."; }
      }).catch(function () { if (msg) { msg.hidden = false; msg.textContent = "Plaatsen mislukt."; } });
    });
  });
})();
