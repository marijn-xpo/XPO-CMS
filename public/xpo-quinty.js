(function () {
  var cfg = window.__quinty || { name: "Quinty", greeting: "Hoi! Waarmee kan ik je helpen?" };
  var ACC = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5F8D7A";

  var css = ""
    + ".qy-btn{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:" + ACC + ";color:#fff;border:0;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.3);z-index:99998;font-size:24px;display:grid;place-items:center}"
    + ".qy-panel{position:fixed;right:20px;bottom:88px;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#0e1216;border:1px solid rgba(255,255,255,.1);border-radius:16px;display:none;flex-direction:column;overflow:hidden;z-index:99999;box-shadow:0 18px 50px rgba(0,0,0,.5);font-family:inherit}"
    + ".qy-panel.open{display:flex}"
    + ".qy-head{padding:14px 16px;background:" + ACC + ";color:#fff;font-weight:600;display:flex;justify-content:space-between;align-items:center}"
    + ".qy-head button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}"
    + ".qy-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;color:#EAEEF2;font-size:14px}"
    + ".qy-msg{max-width:85%;padding:10px 12px;border-radius:12px;line-height:1.45}"
    + ".qy-bot{background:rgba(255,255,255,.06);align-self:flex-start;border-bottom-left-radius:4px}"
    + ".qy-user{background:" + ACC + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}"
    + ".qy-src{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}"
    + ".qy-src a{font-size:11px;color:" + ACC + ";text-decoration:none;border:1px solid rgba(255,255,255,.15);border-radius:99px;padding:2px 8px}"
    + ".qy-foot{padding:10px;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:8px}"
    + ".qy-foot input{flex:1;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 12px;color:#fff;font:inherit}"
    + ".qy-foot button{background:" + ACC + ";color:#fff;border:0;border-radius:10px;padding:0 14px;cursor:pointer}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  var btn = document.createElement("button"); btn.className = "qy-btn"; btn.setAttribute("aria-label", "Chat"); btn.innerHTML = "&#128172;";
  var panel = document.createElement("div"); panel.className = "qy-panel";
  panel.innerHTML = '<div class="qy-head"><span>' + esc(cfg.name) + '</span><button aria-label="Sluiten">&times;</button></div>'
    + '<div class="qy-body"></div>'
    + '<div class="qy-foot"><input type="text" placeholder="Stel je vraag\u2026"/><button>&#10148;</button></div>';
  document.body.appendChild(btn); document.body.appendChild(panel);

  var body = panel.querySelector(".qy-body");
  var input = panel.querySelector(".qy-foot input");
  var send = panel.querySelector(".qy-foot button");
  var greeted = false;

  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function add(text, who, sources) {
    var m = document.createElement("div"); m.className = "qy-msg " + (who === "user" ? "qy-user" : "qy-bot");
    m.innerHTML = esc(text);
    if (sources && sources.length) {
      var s = document.createElement("div"); s.className = "qy-src";
      sources.forEach(function (src) { if (src.url) { var a = document.createElement("a"); a.href = src.url; a.textContent = src.title; s.appendChild(a); } });
      if (s.children.length) m.appendChild(s);
    }
    body.appendChild(m); body.scrollTop = body.scrollHeight;
  }
  function toggle() {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) { if (!greeted) { add(cfg.greeting, "bot"); greeted = true; } input.focus(); }
  }
  function ask() {
    var q = input.value.trim(); if (!q) return;
    add(q, "user"); input.value = ""; send.disabled = true;
    var typing = document.createElement("div"); typing.className = "qy-msg qy-bot"; typing.textContent = "\u2026"; body.appendChild(typing); body.scrollTop = body.scrollHeight;
    fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: q }) })
      .then(function (r) { return r.json(); })
      .then(function (res) { body.removeChild(typing); add(res.answer || "\u2026", "bot", res.sources); })
      .catch(function () { body.removeChild(typing); add("Er ging iets mis. Probeer later opnieuw.", "bot"); })
      .then(function () { send.disabled = false; });
  }
  btn.addEventListener("click", toggle);
  panel.querySelector(".qy-head button").addEventListener("click", toggle);
  send.addEventListener("click", ask);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });
})();
