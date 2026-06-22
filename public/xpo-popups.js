/* XPO Popups — triggers (load/scroll/exit/click), geen dependencies. */
(function () {
  function show(el) { el.hidden = false; el.classList.add("open"); }
  function close(el) { el.hidden = true; el.classList.remove("open"); try { sessionStorage.setItem("xpop-" + el.id, "1"); } catch (e) {} }
  function dismissed(el) { try { return sessionStorage.getItem("xpop-" + el.id) === "1"; } catch (e) { return false; } }
  function arm(el) {
    if (dismissed(el)) return;
    var trig = el.getAttribute("data-trigger") || "load";
    var delay = parseInt(el.getAttribute("data-delay"), 10) || 0;
    var x = el.querySelector(".xpo-popup__x");
    if (x) x.addEventListener("click", function () { close(el); });
    el.addEventListener("click", function (e) { if (e.target === el) close(el); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !el.hidden) close(el); });
    if (trig === "load") {
      setTimeout(function () { show(el); }, delay * 1000);
    } else if (trig === "scroll") {
      var pct = delay || 40;
      var on = function () {
        var sc = window.scrollY || document.documentElement.scrollTop;
        var h = document.documentElement.scrollHeight - window.innerHeight;
        if (h > 0 && (sc / h) * 100 >= pct) { show(el); window.removeEventListener("scroll", on); }
      };
      window.addEventListener("scroll", on);
    } else if (trig === "exit") {
      var ex = function (e) { if (e.clientY <= 0) { show(el); document.removeEventListener("mouseout", ex); } };
      document.addEventListener("mouseout", ex);
    } else if (trig === "click") {
      document.addEventListener("click", function (e) {
        var t = e.target.closest && e.target.closest("[data-popup='" + el.id + "']");
        if (t) { e.preventDefault(); show(el); }
      });
    }
  }
  function boot() { var ps = document.querySelectorAll(".xpo-popup"); for (var i = 0; i < ps.length; i++) arm(ps[i]); }
  if (document.readyState !== "loading") boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
