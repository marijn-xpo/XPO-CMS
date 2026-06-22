/* XPO Menus — gedrag. Geen afhankelijkheden.
   Verrijkt elke <header class="xpo-bar" data-xpo-nav> : desktop mega/dropdown + mobiele
   offcanvas met drilldown (opgebouwd uit dezelfde <ul class="xpo-menu">). */
(function () {
  "use strict";
  var RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var DESK = "(hover: hover) and (min-width: 921px)";
  var CHEV = '<svg class="xpo-drill__chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  var BACK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>';

  function isDesktop() { return window.matchMedia(DESK).matches; }

  /* ---- nav-DOM → boomstructuur (voor de drilldown) ---- */
  function parseMenu(menu) {
    return toArray(menu.children).filter(function (li) { return li.tagName === "LI"; }).map(parseItem);
  }
  function parseItem(li) {
    var top = li.querySelector(":scope > .xpo-top");
    var node = {
      label: top ? top.textContent.trim() : "",
      href: top && top.tagName === "A" ? top.getAttribute("href") : null,
      children: [],
    };
    var mega = li.querySelector(":scope > .xpo-mega");
    if (mega) {
      node.children = toArray(mega.querySelectorAll(".xpo-col")).map(function (col) {
        var h = col.querySelector(".xpo-col__h");
        return {
          label: h ? h.textContent.trim() : "",
          href: null,
          children: toArray(col.querySelectorAll("li > a")).map(linkToNode),
        };
      });
      var feat = mega.querySelector(".xpo-feat");
      if (feat) {
        var ft = feat.querySelector(".xpo-feat__t");
        node.children.push({ label: ft ? ft.textContent.trim() : "Uitgelicht", href: feat.getAttribute("href"), children: [] });
      }
    } else {
      var sub = li.querySelector(":scope > .xpo-sub");
      if (sub) node.children = toArray(sub.children).filter(function (x) { return x.tagName === "LI"; }).map(parseItem);
    }
    return node;
  }
  function linkToNode(a) {
    var t = a.querySelector(".xpo-i__t");
    return { label: (t ? t.textContent : a.textContent).trim(), href: a.getAttribute("href"), children: [] };
  }
  function toArray(x) { return Array.prototype.slice.call(x); }

  /* ---- desktop: mega + dropdown ---- */
  function wireDesktop(bar, menu) {
    var lis = toArray(menu.children).filter(function (li) { return li.tagName === "LI"; });
    var open = null;
    function closeOpen() {
      if (!open) return;
      open.classList.remove("open");
      var b = open.querySelector(":scope > .xpo-top");
      if (b) b.setAttribute("aria-expanded", "false");
      open = null;
    }
    bar._closeMega = closeOpen;

    lis.forEach(function (li) {
      var trigger = li.querySelector(":scope > .xpo-top");
      var panel = li.classList.contains("xpo-has-mega") || li.classList.contains("xpo-has-sub");
      if (!trigger || !panel || trigger.tagName !== "BUTTON") return;
      trigger.setAttribute("aria-haspopup", "true");
      trigger.setAttribute("aria-expanded", "false");

      trigger.addEventListener("click", function (e) {
        e.preventDefault();
        var wasOpen = li.classList.contains("open");
        closeOpen();
        if (!wasOpen) { li.classList.add("open"); trigger.setAttribute("aria-expanded", "true"); open = li; }
      });
      li.addEventListener("mouseenter", function () {
        if (!isDesktop()) return;
        closeOpen(); li.classList.add("open"); trigger.setAttribute("aria-expanded", "true"); open = li;
      });
      li.addEventListener("mouseleave", function () {
        if (!isDesktop()) return;
        li.classList.remove("open"); trigger.setAttribute("aria-expanded", "false"); if (open === li) open = null;
      });
    });

    document.addEventListener("click", function (e) { if (!menu.contains(e.target)) closeOpen(); });

    // toetsenbord langs de topniveau-items
    menu.addEventListener("keydown", function (e) {
      var t = e.target.closest(".xpo-top");
      if (!t) return;
      var tops = lis.map(function (li) { return li.querySelector(":scope > .xpo-top"); }).filter(Boolean);
      var i = tops.indexOf(t);
      if (e.key === "ArrowRight") { e.preventDefault(); tops[(i + 1) % tops.length].focus(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); tops[(i - 1 + tops.length) % tops.length].focus(); }
      else if (e.key === "ArrowDown") {
        var li = t.closest("li");
        if (li.classList.contains("xpo-has-mega") || li.classList.contains("xpo-has-sub")) {
          e.preventDefault(); closeOpen(); li.classList.add("open"); t.setAttribute("aria-expanded", "true"); open = li;
          var first = li.querySelector(".xpo-mega a, .xpo-sub a"); if (first) first.focus();
        }
      }
    });
  }

  /* ---- mobiel: offcanvas + drilldown ---- */
  function buildDrawer(bar, tree) {
    var id = bar.getAttribute("data-xpo-drawer") || "xpo-drawer";
    var drawer = document.getElementById(id);
    if (!drawer) {
      drawer = document.createElement("div");
      drawer.id = id; drawer.className = "xpo-drawer"; drawer.hidden = true;
      drawer.innerHTML =
        '<div class="xpo-drawer__scrim"></div>' +
        '<aside class="xpo-drawer__panel" role="dialog" aria-modal="true" aria-label="Menu">' +
          '<div class="xpo-drawer__head"><span>Menu</span><button class="xpo-drawer__close" aria-label="Menu sluiten">\u2715</button></div>' +
          '<div class="xpo-drill"><div class="xpo-drill__track"></div></div>' +
        "</aside>";
      document.body.appendChild(drawer);
    }
    var viewport = drawer.querySelector(".xpo-drill");
    var track = drawer.querySelector(".xpo-drill__track");
    var depth = 0;

    function makeLevel(nodes, title) {
      var lvl = document.createElement("div");
      lvl.className = "xpo-drill__level";
      if (title) {
        var back = document.createElement("button");
        back.className = "xpo-drill__back"; back.type = "button";
        back.innerHTML = BACK + "<span>Terug</span>";
        back.addEventListener("click", pop);
        lvl.appendChild(back);
        var head = document.createElement("div");
        head.className = "xpo-drill__lvlhead"; head.textContent = title;
        lvl.appendChild(head);
      }
      nodes.forEach(function (n) {
        var row = document.createElement("div");
        row.className = "xpo-drill__row";
        if (n.children && n.children.length) {
          var btn = document.createElement("button");
          btn.type = "button"; btn.className = "xpo-drill__exp";
          btn.innerHTML = "<span>" + escapeHtml(n.label) + "</span>" + CHEV;
          btn.addEventListener("click", function () { push(n.children, n.label); });
          row.appendChild(btn);
        } else {
          var a = document.createElement("a");
          a.className = "xpo-drill__link"; a.href = n.href || "#";
          a.textContent = n.label;
          row.appendChild(a);
        }
        lvl.appendChild(row);
      });
      return lvl;
    }
    function setHeight() {
      var active = track.children[depth];
      if (active) viewport.style.height = active.scrollHeight + "px";
    }
    function transform() { track.style.transform = "translateX(" + (-depth * 100) + "%)"; }
    function push(nodes, title) {
      var lvl = makeLevel(nodes, title);
      track.appendChild(lvl);
      depth = track.children.length - 1;
      requestAnimationFrame(function () { transform(); setHeight(); });
      var f = lvl.querySelector("a, button"); if (f) f.focus();
    }
    function pop() {
      if (depth === 0) return;
      var leaving = track.children[depth];
      depth -= 1; transform(); setHeight();
      var done = function () { if (leaving && leaving.parentNode) leaving.parentNode.removeChild(leaving); };
      if (RM) done(); else setTimeout(done, 320);
      var f = track.children[depth] && track.children[depth].querySelector("a, button"); if (f) f.focus();
    }
    function reset() {
      while (track.children.length > 1) track.removeChild(track.lastChild);
      depth = 0; transform();
    }

    track.appendChild(makeLevel(tree, null)); // root
    drawer._setHeight = setHeight;
    drawer._reset = reset;
    return drawer;
  }

  function wireDrawer(bar, drawer) {
    var burger = bar.querySelector(".xpo-burger");
    var panel = drawer.querySelector(".xpo-drawer__panel");
    var closeBtn = drawer.querySelector(".xpo-drawer__close");
    var scrim = drawer.querySelector(".xpo-drawer__scrim");
    var isOpen = false, lastFocus = null;

    function open() {
      isOpen = true; drawer.hidden = false;
      requestAnimationFrame(function () { drawer.classList.add("open"); if (drawer._setHeight) drawer._setHeight(); });
      document.documentElement.style.overflow = "hidden";
      burger.setAttribute("aria-expanded", "true");
      lastFocus = document.activeElement;
      (panel.querySelector("a, button") || panel).focus();
    }
    function close() {
      isOpen = false; drawer.classList.remove("open");
      document.documentElement.style.overflow = "";
      burger.setAttribute("aria-expanded", "false");
      var fin = function () { drawer.hidden = true; if (drawer._reset) drawer._reset(); };
      if (RM) fin(); else setTimeout(fin, 320);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    bar._closeDrawer = function () { if (isOpen) close(); };

    burger.setAttribute("aria-expanded", "false");
    burger.setAttribute("aria-controls", drawer.id);
    burger.addEventListener("click", function () { isOpen ? close() : open(); });
    closeBtn.addEventListener("click", close);
    scrim.addEventListener("click", close);

    // focus-trap binnen het paneel
    panel.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var f = toArray(panel.querySelectorAll('a[href], button:not([disabled])')).filter(function (el) { return el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---- init ---- */
  function init(bar) {
    if (bar._xpoInit) return; bar._xpoInit = true;
    var menu = bar.querySelector(".xpo-menu");
    if (menu) {
      wireDesktop(bar, menu);
      var drawer = buildDrawer(bar, parseMenu(menu));
      if (bar.querySelector(".xpo-burger")) wireDrawer(bar, drawer);
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { if (bar._closeMega) bar._closeMega(); if (bar._closeDrawer) bar._closeDrawer(); }
    });
  }
  function initAll(root) {
    (root || document).querySelectorAll(".xpo-bar[data-xpo-nav]").forEach(init);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { initAll(); });
  else initAll();

  window.XpoMenus = { init: init, initAll: initAll };
})();
