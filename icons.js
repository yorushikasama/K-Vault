/** 共享图标：新版由 Vue 渲染 SVG，旧页面继续支持 data-lucide。 */
(function () {
  "use strict";

  /**
   * 品牌图标内联。全站只用到这五个品牌，为此拉 22.7 KB gzip 的 FontAwesome CSS
   * 外加一个字体文件不值得，直接内联路径（来自 Simple Icons，CC0）。
   *
   * 和 Lucide 的描边图标不同，品牌图标是填充图形，所以 fill/stroke 要反过来设。
   * 键名同时覆盖 `fab fa-x` 与 `fa-brands fa-x` 两种历史写法。
   */
  var BRAND_PATHS = {
    github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    telegram: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
    discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
    android: "M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z",
    markdown: "M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z"
  };

  var BRAND_CLASS_RE = /^(?:fab|fas|far|fa-brands|fa-solid|fa-regular)\s+fa-([a-z0-9-]+)$/;

  /** 从 `fab fa-github` 这类类名串里取出品牌名；不是品牌图标则返回 null。 */
  function brandNameFrom(value) {
    var match = BRAND_CLASS_RE.exec(String(value || "").trim());
    return match && BRAND_PATHS[match[1]] ? match[1] : null;
  }

  function brandSvgMarkup(brand, extraClasses) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20"' +
      ' fill="currentColor" stroke="none" aria-hidden="true" focusable="false"' +
      ' class="kv-icon kv-brand kv-brand-' + brand + (extraClasses ? " " + extraClasses : "") + '">' +
      '<path d="' + BRAND_PATHS[brand] + '"></path></svg>';
  }

  /**
   * 把静态写死的 `<i class="fab fa-github">` 换成内联 SVG。
   * 和 Lucide 的 createIcons 一样是一次性 DOM 替换，替换后类名里不再有 fa-，
   * 所以重复调用是幂等的。
   */
  function renderBrandIcons(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll('i[class*="fa-"]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var brand = brandNameFrom(node.getAttribute("class"));
      if (!brand || !node.parentNode) continue;
      var holder = document.createElement("span");
      holder.innerHTML = brandSvgMarkup(brand, node.getAttribute("data-icon-class") || "");
      var svg = holder.firstChild;
      // 保留行内样式（部分页面用它设宽度和品牌色）。
      var style = node.getAttribute("style");
      if (style) svg.setAttribute("style", style);
      node.parentNode.replaceChild(svg, node);
    }
  }

  function applyIconClasses(root) {
    var nodes = (root || document).querySelectorAll("svg.lucide[data-icon-class]");
    for (var i = 0; i < nodes.length; i++) {
      var parts = (nodes[i].getAttribute("data-icon-class") || "").split(/\s+/);
      for (var j = 0; j < parts.length; j++) {
        if (parts[j]) nodes[i].classList.add(parts[j]);
      }
    }
  }

  function renderIcons(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    try {
      renderBrandIcons(scope);
    } catch (e) {
      // 品牌图标失败不该连带阻断 Lucide 渲染。
    }
    if (!window.lucide || typeof window.lucide.createIcons !== "function") return;
    if (!scope.querySelector("[data-lucide]")) return;
    try {
      window.lucide.createIcons(root ? { root: root } : {});
      applyIconClasses(scope);
    } catch (e) {
      // 图标脚本不可用时保留带文字的操作，不中断页面。
    }
  }

  function escapeAttribute(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function iconMarkup(name, extraClasses) {
    var safeName = /^[a-z0-9-]+$/.test(String(name)) ? name : "file";
    return '<i data-lucide="' + safeName + '" aria-hidden="true"' +
      (extraClasses ? ' data-icon-class="' + escapeAttribute(extraClasses) + '"' : "") + '></i>';
  }

  function registerVue() {
    var Vue = window.Vue;
    if (!Vue) return;
    if (!Vue.options.components["kv-icon"] && !Vue.options.components.KvIcon) {
      Vue.component("kv-icon", {
        props: { name: { type: String, default: "file" } },
        render: function (h) {
          var name = String(this.name || "file").trim();
          var brand = brandNameFrom(name);
          if (brand) {
            // 品牌图标是填充图形，和下面描边的 Lucide 图标走不同的 fill/stroke。
            return h("svg", {
              class: ["kv-icon", "kv-brand", "kv-brand-" + brand],
              attrs: {
                xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 20, height: 20,
                fill: "currentColor", stroke: "none", "aria-hidden": "true", focusable: "false"
              }
            }, [h("path", { attrs: { d: BRAND_PATHS[brand] } })]);
          }
          if (!/^[a-z0-9-]+$/.test(name)) name = "file";
          var key = name.replace(/(^|-)([a-z0-9])/g, function (_, dash, letter) { return letter.toUpperCase(); });
          var library = window.lucide || {};
          var definition = (library.icons || {})[key] || library[key];
          var nodes = Array.isArray(definition) ? (definition[0] === "svg" ? definition[2] : definition) : null;
          if (!nodes) nodes = [["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" }], ["path", { d: "M14 2v6h6M8 13h8M8 17h5" }]];
          function draw(node, index) {
            return h(node[0], { key: index, attrs: node[1] || {} }, (node[2] || []).map(draw));
          }
          return h("svg", {
            class: ["kv-icon", "lucide", "lucide-" + name],
            attrs: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 20, height: 20, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" }
          }, nodes.map(draw));
        }
      });
    }
    if (window.__kvLucideDirective) return;
    window.__kvLucideDirective = true;
    function hasLegacyIcons(el) {
      if (!el || el.nodeType !== 1 || !el.querySelector) return false;
      // 品牌 <i> 也要算进来，否则模板里写死的 `fab fa-github` 永远不会被替换。
      return Boolean(el.querySelector('[data-lucide], i[class*="fa-"]'));
    }
    function refresh(el) {
      // 绝大多数组件（kv-icon 直渲染 SVG）不含 data-lucide，先同步判空，避免每次更新都排一个无效 nextTick 任务
      if (!hasLegacyIcons(el)) return;
      Vue.nextTick(function () { renderIcons(el); });
    }
    Vue.directive("lucide", { inserted: refresh, componentUpdated: refresh });
    Vue.mixin({
      mounted: function () { refresh(this.$el); },
      updated: function () { refresh(this.$el); }
    });
  }

  window.KVIcons = { render: renderIcons, markup: iconMarkup, applyClasses: applyIconClasses, registerVue: registerVue };
  registerVue();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { registerVue(); renderIcons(document); });
  } else {
    renderIcons(document);
  }
})();
