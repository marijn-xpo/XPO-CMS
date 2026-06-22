(function () {
  if (!document.querySelector(".xpo-shop") && !document.querySelector(".xsh-add")) return;
  var ACC = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5F8D7A";

  function getCartId() { var m = document.cookie.match(/(?:^|;\s*)xpocart=([^;]+)/); return m ? decodeURIComponent(m[1]) : null; }
  function setCartId(id) { document.cookie = "xpocart=" + encodeURIComponent(id) + ";path=/;max-age=2592000"; }

  var btn = document.createElement("button"); btn.className = "xsh-cartbtn"; btn.innerHTML = "&#128722; <span class='xsh-count'>0</span>";
  var drawer = document.createElement("div"); drawer.className = "xsh-drawer";
  drawer.innerHTML = '<h3><span>Winkelwagen</span><button class="xsh-x" style="background:none;border:0;color:#fff;font-size:20px;cursor:pointer">&times;</button></h3>'
    + '<div class="xsh-items"></div>'
    + '<div class="xsh-foot"><div class="xsh-total" style="font-weight:600;display:flex;justify-content:space-between"><span>Totaal</span><span class="xsh-totval">€0,00</span></div>'
    + '<input class="xsh-name" placeholder="Naam"/><input class="xsh-email" type="email" placeholder="E-mail"/>'
    + '<button class="xsh-checkout" style="background:' + ACC + ';color:#fff;border:0;border-radius:10px;padding:11px;cursor:pointer;font:inherit">Afrekenen</button>'
    + '<p class="xsh-msg" style="margin:0;color:' + ACC + '" hidden></p></div>';
  document.body.appendChild(btn); document.body.appendChild(drawer);

  var itemsEl = drawer.querySelector(".xsh-items");
  var countEl = btn.querySelector(".xsh-count");
  var totEl = drawer.querySelector(".xsh-totval");
  var msg = drawer.querySelector(".xsh-msg");

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function render(cart) {
    if (!cart) return;
    countEl.textContent = cart.count; totEl.textContent = cart.total;
    itemsEl.innerHTML = cart.items.length ? cart.items.map(function (l) {
      return '<div class="xsh-row" data-pid="' + esc(l.productId) + '"><div style="flex:1"><div>' + esc((l.name + (l.variant?(' · '+l.variant):''))) + '</div><div style="opacity:.6;font-size:12px">' + esc(l.price) + '</div></div>'
        + '<button class="xsh-dec" style="background:rgba(255,255,255,.08);border:0;color:#fff;width:26px;height:26px;border-radius:6px;cursor:pointer">-</button>'
        + '<span style="min-width:20px;text-align:center">' + l.qty + '</span>'
        + '<button class="xsh-inc" style="background:rgba(255,255,255,.08);border:0;color:#fff;width:26px;height:26px;border-radius:6px;cursor:pointer">+</button></div>';
    }).join("") : '<p style="opacity:.5">Je winkelwagen is leeg.</p>';
  }
  function api(path, opts) { return fetch(path, opts).then(function (r) { return r.json(); }); }
  function ensureCart() {
    var id = getCartId();
    if (id) return Promise.resolve(id);
    return api("/api/cart", { method: "POST" }).then(function (c) { setCartId(c.id); return c.id; });
  }
  function refresh() { var id = getCartId(); if (!id) return; api("/api/cart/" + id).then(render); }
  function setQty(pid, qty) { var id = getCartId(); if (!id) return; api("/api/cart/" + id + "/items/" + pid, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: qty }) }).then(render); }

  document.querySelectorAll(".xsh-add").forEach(function (b) {
    b.addEventListener("click", function () {
      ensureCart().then(function (id) {
        api("/api/cart/" + id + "/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: b.getAttribute("data-product"), qty: 1, variant: (function(){var sels=document.querySelectorAll(".xpo-product .xpr-attr");if(!sels.length)return "";return Array.prototype.map.call(sels,function(se){return se.getAttribute("data-attr")+": "+se.value;}).join(", ");})() }) })
          .then(function (cart) { render(cart); drawer.classList.add("open"); });
      });
    });
  });
  itemsEl.addEventListener("click", function (e) {
    var row = e.target.closest(".xsh-row"); if (!row) return; var pid = row.getAttribute("data-pid");
    var qtyEl = row.querySelector("span"); var qty = parseInt(qtyEl.textContent, 10) || 0;
    if (e.target.classList.contains("xsh-inc")) setQty(pid, qty + 1);
    if (e.target.classList.contains("xsh-dec")) setQty(pid, qty - 1);
  });
  btn.addEventListener("click", function () { drawer.classList.add("open"); refresh(); });
  drawer.querySelector(".xsh-x").addEventListener("click", function () { drawer.classList.remove("open"); });
  drawer.querySelector(".xsh-checkout").addEventListener("click", function () {
    var id = getCartId(); if (!id) return;
    var name = drawer.querySelector(".xsh-name").value, email = drawer.querySelector(".xsh-email").value;
    api("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartId: id, customer: { name: name, email: email } }) })
      .then(function (res) {
        if (res.checkoutUrl) { document.cookie = "xpocart=;path=/;max-age=0"; location.href = res.checkoutUrl; }
        else if (msg) { msg.hidden = false; msg.textContent = res.error || "Afrekenen mislukt."; }
      });
  });
  refresh();
})();
