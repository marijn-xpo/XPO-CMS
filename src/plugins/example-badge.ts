import { registerPlugin, registerWidget } from "../core/plugins.js";
import { esc } from "../engine/engine.js";

// Voorbeeldplugin die laat zien hoe een externe widget wordt toegevoegd zonder kernwijziging.
registerPlugin({
  name: "example-badge",
  setup() {
    registerWidget("xpo/badge", (s) => `<span class="xpo-badge-ext" style="display:inline-block;padding:6px 14px;border-radius:999px;background:var(--accent);color:#04110d;font-weight:600">${esc(s.text || "Nieuw")}</span>`);
  },
});
