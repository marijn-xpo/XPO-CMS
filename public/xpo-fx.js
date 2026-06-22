/* XPO FX — lichte particles-achtergrond, geen dependencies. Activeert op [data-particles]. */
(function () {
  function init(sec) {
    var color = sec.getAttribute("data-pcolor") || "#5F8D7A";
    var canvas = document.createElement("canvas");
    canvas.className = "xpo-particles";
    sec.insertBefore(canvas, sec.firstChild);
    var ctx = canvas.getContext("2d");
    var dots = [], raf = 0;
    function size() { canvas.width = sec.clientWidth; canvas.height = sec.clientHeight; }
    function make() {
      dots = [];
      var n = Math.max(12, Math.min(80, Math.round((canvas.width * canvas.height) / 16000)));
      for (var i = 0; i < n; i++) dots.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, r: Math.random() * 1.8 + 0.6 });
    }
    function step() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0 || d.x > canvas.width) d.vx *= -1;
        if (d.y < 0 || d.y > canvas.height) d.vy *= -1;
        ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 0.1; ctx.strokeStyle = color;
      for (var a = 0; a < dots.length; a++) for (var b = a + 1; b < dots.length; b++) {
        var dx = dots[a].x - dots[b].x, dy = dots[a].y - dots[b].y;
        if (dx * dx + dy * dy < 9000) { ctx.beginPath(); ctx.moveTo(dots[a].x, dots[a].y); ctx.lineTo(dots[b].x, dots[b].y); ctx.stroke(); }
      }
      raf = requestAnimationFrame(step);
    }
    function start() { size(); make(); cancelAnimationFrame(raf); step(); }
    start();
    var t; window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(start, 150); });
  }
  function initCountdowns() {
    var els = document.querySelectorAll("[data-countdown]");
    for (var i = 0; i < els.length; i++) (function (el) {
      var target = Date.parse(el.getAttribute("data-countdown"));
      if (!target) return;
      var set = function (u, v) { var b = el.querySelector('b[data-u="' + u + '"]'); if (b) b.textContent = v < 10 ? "0" + v : String(v); };
      var tick = function () {
        var diff = Math.max(0, target - Date.now());
        var s = Math.floor(diff / 1000);
        set("d", Math.floor(s / 86400)); set("h", Math.floor((s % 86400) / 3600)); set("m", Math.floor((s % 3600) / 60)); set("s", s % 60);
        if (diff <= 0 && el._t) clearInterval(el._t);
      };
      tick(); el._t = setInterval(tick, 1000);
    })(els[i]);
  }
  function initSliders() {
    var els = document.querySelectorAll(".xpo-slider");
    for (var i = 0; i < els.length; i++) (function (el) {
      var track = el.querySelector(".xsl-track"); if (!track) return;
      var n = track.children.length; if (!n) return;
      var dots = el.querySelectorAll(".xsl-dot"); var idx = 0; var timer = null;
      function go(k) { idx = (k + n) % n; track.style.transform = "translateX(" + (-idx * 100) + "%)"; for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("on", d === idx); }
      function stop() { if (timer) { clearInterval(timer); timer = null; } }
      var prev = el.querySelector(".xsl-prev"), next = el.querySelector(".xsl-next");
      if (prev) prev.addEventListener("click", function () { stop(); go(idx - 1); });
      if (next) next.addEventListener("click", function () { stop(); go(idx + 1); });
      for (var d = 0; d < dots.length; d++) (function (j) { dots[j].addEventListener("click", function () { stop(); go(j); }); })(d);
      var iv = parseInt(el.getAttribute("data-autoplay"), 10) || 0;
      go(0); if (iv > 0) timer = setInterval(function () { go(idx + 1); }, iv * 1000);
    })(els[i]);
  }
  function initAnimatedHeads() {
    var els = document.querySelectorAll(".xah-rot");
    for (var i = 0; i < els.length; i++) (function (el) {
      var words; try { words = JSON.parse(el.getAttribute("data-words") || "[]"); } catch (e) { words = []; }
      if (words.length < 2) return;
      var idx = 0;
      setInterval(function () { el.style.opacity = "0"; setTimeout(function () { idx = (idx + 1) % words.length; el.textContent = words[idx]; el.style.opacity = "1"; }, 300); }, 2400);
    })(els[i]);
  }
  function slugifyTxt(t) { return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60); }
  function initToc() {
    var tocs = document.querySelectorAll("[data-toc]");
    if (!tocs.length) return;
    var heads = document.querySelectorAll("h2.xpo-h, h3.xpo-h");
    var collected = [];
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i]; if (h.closest("[data-toc]")) continue;
      if (!h.id) h.id = slugifyTxt(h.textContent) || ("sec-" + i);
      collected.push({ id: h.id, text: h.textContent, lvl: h.tagName === "H3" ? 3 : 2 });
    }
    for (var t = 0; t < tocs.length; t++) {
      var ul = tocs[t].querySelector(".xtoc-list"); if (!ul) continue;
      if (!collected.length) { tocs[t].style.display = "none"; continue; }
      ul.innerHTML = collected.map(function (c) { return '<li class="' + (c.lvl === 3 ? "lvl3" : "") + '"><a href="#' + c.id + '">' + c.text + "</a></li>"; }).join("");
    }
  }
  function initShare() {
    var groups = document.querySelectorAll("[data-share]");
    for (var g = 0; g < groups.length; g++) {
      var btns = groups[g].querySelectorAll(".xsh-btn");
      for (var b = 0; b < btns.length; b++) (function (btn) {
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          var url = encodeURIComponent(location.href), title = encodeURIComponent(document.title);
          var net = btn.getAttribute("data-net"); var dest = "";
          if (net === "twitter") dest = "https://twitter.com/intent/tweet?url=" + url + "&text=" + title;
          else if (net === "linkedin") dest = "https://www.linkedin.com/sharing/share-offsite/?url=" + url;
          else if (net === "facebook") dest = "https://www.facebook.com/sharer/sharer.php?u=" + url;
          else if (net === "whatsapp") dest = "https://wa.me/?text=" + title + "%20" + url;
          else if (net === "mail") dest = "mailto:?subject=" + title + "&body=" + url;
          if (dest) window.open(dest, "_blank", "noopener");
        });
      })(btns[b]);
    }
  }
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    if (!("IntersectionObserver" in window)) { for (var i = 0; i < els.length; i++) els[i].classList.add("in"); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    for (var j = 0; j < els.length; j++) io.observe(els[j]);
  }
  function initCounters() {
    var els = document.querySelectorAll(".xct-num[data-to]");
    if (!els.length) return;
    function run(el) {
      var to = parseFloat(el.getAttribute("data-to")) || 0, dur = parseInt(el.getAttribute("data-dur")) || 1600;
      var pre = el.getAttribute("data-prefix") || "", suf = el.getAttribute("data-suffix") || "", t0 = 0;
      function step(ts) { if (!t0) t0 = ts; var p = Math.min(1, (ts - t0) / dur); var v = Math.floor((1 - Math.pow(1 - p, 3)) * to); el.textContent = pre + v.toLocaleString("nl-NL") + suf; if (p < 1) requestAnimationFrame(step); else el.textContent = pre + to.toLocaleString("nl-NL") + suf; }
      requestAnimationFrame(step);
    }
    if (!("IntersectionObserver" in window)) { els.forEach(run); return; }
    var io = new IntersectionObserver(function (en) { en.forEach(function (e) { if (e.isIntersecting) { run(e.target); io.unobserve(e.target); } }); }, { threshold: .4 });
    els.forEach(function (el) { io.observe(el); });
  }
  function initAlerts() {
    document.querySelectorAll(".xpo-alert .xal-x").forEach(function (b) { b.addEventListener("click", function () { var a = b.closest(".xpo-alert"); if (a) a.style.display = "none"; }); });
  }
  function initLottie() {
    var els = document.querySelectorAll(".xpo-lottie[data-lottie]");
    if (!els.length) return;
    var s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js";
    s.onload = function () {
      els.forEach(function (el) {
        try { window.lottie.loadAnimation({ container: el, renderer: "svg", loop: el.getAttribute("data-loop") !== "0", autoplay: el.getAttribute("data-autoplay") !== "0", path: el.getAttribute("data-lottie") }); } catch (e) {}
      });
    };
    document.head.appendChild(s);
  }
  function initLogin() {
    document.querySelectorAll("[data-login] .xlg-form").forEach(function (f) {
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var d = {}; new FormData(f).forEach(function (v, k) { d[k] = v; });
        var msg = f.querySelector(".xlg-msg");
        fetch("/api/public/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })
          .then(function (r) { return r.json(); }).then(function (res) {
            if (res && res.ok) { location.href = "/account"; }
            else if (msg) { msg.hidden = false; msg.textContent = (res && res.error) || "Inloggen mislukt."; }
          }).catch(function () { if (msg) { msg.hidden = false; msg.textContent = "Inloggen mislukt."; } });
      });
    });
  }
  function initThemeToggle() {
    function set(t) { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("xpo-theme", t); } catch (e) {} }
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () { set(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"); });
    });
  }
  function boot() {
    var secs = document.querySelectorAll("[data-particles]");
    for (var i = 0; i < secs.length; i++) init(secs[i]);
    initCountdowns();
    initSliders();
    initAnimatedHeads();
    initToc();
    initShare();
    initReveal();
    initCounters();
    initAlerts();
    initLottie();
    initLogin();
    initThemeToggle();
  }
  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
