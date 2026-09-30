/**
 * Shared icon runtime (K-Vault).
 *
 * Lucide replaces <i class="fas fa-x"> with <i data-lucide="x">, converted at
 * runtime by lucide.createIcons(). Three things need handling that createIcons
 * does not do on its own:
 *
 *  1. Class passthrough. createIcons replaces the whole element, so any extra
 *     classes (upload-icon, stats-icon, liked, selected, theme-icon...) would
 *     be lost. The migration records them in data-icon-class; we re-apply them
 *     to the generated <svg> here.
 *
 *  2. Vue 2 re-renders. Vue patches its own virtual DOM for an <i> that the
 *     browser has replaced with an <svg>. Re-running createIcons after each
 *     component update keeps icons correct; the v-lucide directive below wires
 *     that up per component.
 *
 *  3. Focus/selection state. Outline-only Lucide needs a `.filled` class where
 *     FontAwesome previously used a solid glyph.
 *
 * Loaded after lucide.min.js and after Vue (when present).
 */
(function () {
  "use strict";

  function applyIconClasses(root) {
    var nodes = (root || document).querySelectorAll("svg.lucide[data-icon-class]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var extra = el.getAttribute("data-icon-class");
      if (!extra) continue;
      var parts = extra.split(/\s+/);
      for (var j = 0; j < parts.length; j++) {
        if (parts[j] && !el.classList.contains(parts[j])) el.classList.add(parts[j]);
      }
    }
  }

  /**
   * Convert any pending data-lucide placeholders under `root`, then restore
   * the classes the migration recorded.
   */
  function renderIcons(root) {
    if (!window.lucide || typeof window.lucide.createIcons !== "function") return;
    try {
      window.lucide.createIcons(root ? { root: root } : {});
    } catch (e) {
      // createIcons throws if it finds no icons map in some builds; the UMD
      // ships a default map, so this only guards against a failed CDN load.
      return;
    }
    applyIconClasses(root);
  }

  /** Build icon markup for runtime-generated HTML (innerHTML / template strings). */
  function iconMarkup(lucideName, extraClasses) {
    var cls = extraClasses ? ' data-icon-class="' + extraClasses + '"' : "";
    return '<i data-lucide="' + lucideName + '"' + cls + "></i>";
  }

  window.KVIcons = {
    render: renderIcons,
    markup: iconMarkup,
    applyClasses: applyIconClasses,
  };

  // Vue 2: re-render icons after any component update. Registered here so every
  // page that loads this file and Vue gets the behaviour without extra wiring.
  if (window.Vue && !window.__kvLucideDirective) {
    window.__kvLucideDirective = true;
    window.Vue.directive("lucide", {
      inserted: function (el) {
        window.Vue.nextTick(function () { renderIcons(el); });
      },
      componentUpdated: function (el) {
        window.Vue.nextTick(function () { renderIcons(el); });
      },
    });
    // Fallback for markup that is not inside a v-lucide container.
    window.Vue.mixin({
      mounted: function () {
        var self = this;
        window.Vue.nextTick(function () { renderIcons(self.$el); });
      },
      updated: function () {
        var self = this;
        window.Vue.nextTick(function () { renderIcons(self.$el); });
      },
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { renderIcons(document); });
  } else {
    renderIcons(document);
  }
})();
