/**
 * 前端 UI 设计：背景图、卡片透明度、动态特效画布。
 *
 * 从 theme.js 拆出来的后半部分。这些都不影响首帧，所以用 defer 加载，不再挡住
 * 解析。它自己读 localStorage 并立即 applySettings，不依赖 theme-core.js 的首次
 * theme:change 广播，因此加载顺序靠后也没问题。
 *
 * 暴露 window.UIDesignManager（admin 的 UI 设置面板和 login 的背景加载会用）。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "kvUiDesignSettings";
  var LEGACY_LOGIN_MODE_KEY = "loginBackgroundMode";
  var LEGACY_LOGIN_URL_KEY = "loginBackgroundUrl";
  var API_ENDPOINT = "/api/ui-config";


  var DEFAULTS = {
    version: 1,
    baseColor: "#fafaf8",
    globalBackgroundUrl: "",
    loginBackgroundMode: "follow-global",
    loginBackgroundUrl: "",
    cardOpacity: 86,
    cardBlur: 14,
    wallpaperOpacity: 55,
    wallpaperMask: 30,
    effectStyle: "none",
    effectIntensity: 22,
    optimizeMobile: true,
  };

  var root = document.documentElement;
  var settings = null;
  var layers = { image: null };

  function cloneSettings(input) {
    return Object.assign({}, input || {});
  }

  function clampNumber(value, min, max) {
    var numeric = Number(value);
    if (!isFinite(numeric)) return min;
    return Math.min(max, Math.max(min, numeric));
  }

  function normalizeHexColor(value) {
    var text = String(value || "").trim();
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) {
      return DEFAULTS.baseColor;
    }
    if (text.length === 4) {
      return (
        "#" +
        text[1] +
        text[1] +
        text[2] +
        text[2] +
        text[3] +
        text[3]
      ).toLowerCase();
    }
    return text.toLowerCase();
  }

  function sanitizeUrl(url) {
    var text = String(url || "").trim();
    if (!text) return "";
    if (/^(https?:)?\/\//i.test(text)) return text;
    if (/^\//.test(text)) return text;
    return "";
  }

  function normalizeSettings(raw) {
    var next = Object.assign({}, DEFAULTS, raw || {});
    next.baseColor = normalizeHexColor(next.baseColor);
    next.globalBackgroundUrl = sanitizeUrl(next.globalBackgroundUrl);
    next.loginBackgroundMode =
      next.loginBackgroundMode === "custom" ? "custom" : "follow-global";
    next.loginBackgroundUrl = sanitizeUrl(next.loginBackgroundUrl);
    next.cardOpacity = Math.round(clampNumber(next.cardOpacity, 0, 100));
    next.cardBlur = Math.round(clampNumber(next.cardBlur, 0, 32));
    next.wallpaperOpacity = Math.round(clampNumber(next.wallpaperOpacity, 0, 100));
    next.wallpaperMask = Math.round(clampNumber(next.wallpaperMask, 0, 100));
    next.effectStyle = "none";
    next.effectIntensity = 0;
    next.optimizeMobile = next.optimizeMobile !== false;
    return next;
  }

  function saveLocalSettings(next) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  function readSettings() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return normalizeSettings(DEFAULTS);
      return normalizeSettings(JSON.parse(raw));
    } catch (e) {
      return normalizeSettings(DEFAULTS);
    }
  }

  function extractConfigPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }

    var fromData =
      payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? payload.data
        : null;

    var candidate =
      payload.config ||
      payload.settings ||
      (fromData && (fromData.config || fromData.settings)) ||
      null;

    if (!candidate && !("success" in payload) && !("error" in payload)) {
      candidate = payload;
    }

    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    return candidate;
  }

  function extractErrorMessage(payload, fallback) {
    if (!payload || typeof payload !== "object") return fallback;
    if (typeof payload.error === "string" && payload.error) return payload.error;
    if (payload.error && typeof payload.error === "object") {
      if (typeof payload.error.message === "string" && payload.error.message) {
        return payload.error.message;
      }
      if (typeof payload.error.detail === "string" && payload.error.detail) {
        return payload.error.detail;
      }
    }
    if (typeof payload.message === "string" && payload.message) return payload.message;
    return fallback;
  }

  function requestUiConfig(method, config) {
    if (typeof fetch !== "function") {
      return Promise.reject(new Error("Fetch API is not available"));
    }

    var url =
      method === "GET"
        ? API_ENDPOINT + (API_ENDPOINT.indexOf("?") >= 0 ? "&" : "?") + "_ts=" + Date.now()
        : API_ENDPOINT;

    var init = {
      method: method,
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    };

    if (method !== "GET" && config) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ config: config });
    }

    // A wall-clock cap is safe here because this only ever moves a small JSON
    // document — unlike file uploads, where any fixed cap would abort legitimate
    // large transfers. Without it a stalled request left the save button spinning
    // forever, since the loading flag only resets when the promise settles.
    // The timer is deliberately not cleared: aborting an already-settled request
    // is a no-op, and clearing it would mean restructuring the promise chain below.
    if (typeof AbortController === "function") {
      var uiConfigController = new AbortController();
      init.signal = uiConfigController.signal;
      setTimeout(function () {
        uiConfigController.abort();
      }, 30000);
    }

    return fetch(url, init).then(function (response) {
      return response
        .text()
        .then(function (raw) {
          var payload = {};
          if (raw) {
            try {
              payload = JSON.parse(raw);
            } catch (e) {
              payload = {};
            }
          }

          if (!response.ok) {
            var fallback = "Request failed (" + response.status + ")";
            throw new Error(extractErrorMessage(payload, fallback));
          }

          if (payload && payload.success === false) {
            throw new Error(extractErrorMessage(payload, "Request failed"));
          }

          return payload;
        })
        .catch(function (error) {
          if (error instanceof Error) throw error;
          throw new Error(String(error || "Request failed"));
        });
    });
  }

  function syncFromServer(options) {
    var opts = options || {};
    var silent = opts.silent !== false;
    var applyLocalOnFailure = opts.applyLocalOnFailure === true;

    return requestUiConfig("GET")
      .then(function (payload) {
        var remote = extractConfigPayload(payload);
        if (!remote) {
          return {
            success: false,
            source: "local",
            settings: cloneSettings(settings || readSettings()),
            error: "Server returned invalid ui config payload",
          };
        }

        var normalized = normalizeSettings(remote);
        saveLocalSettings(normalized);
        applySettings(normalized, { persist: false, silent: silent });
        return {
          success: true,
          source: "server",
          binding: payload && payload.binding ? String(payload.binding) : "",
          settings: cloneSettings(normalized),
        };
      })
      .catch(function (error) {
        try {
          console.warn("[ui-config] GET /api/ui-config failed:", error);
        } catch (e) {}
        if (applyLocalOnFailure) {
          var local = readSettings();
          applySettings(local, { persist: false, silent: silent });
        }

        if (opts.throwOnError) {
          throw error;
        }

        return {
          success: false,
          source: "local",
          settings: cloneSettings(settings || readSettings()),
          error: error && error.message ? error.message : String(error),
        };
      });
  }

  function saveToServer(partial, options) {
    var opts = options || {};
    var merged = Object.assign({}, settings || DEFAULTS, partial || {});
    var localApplied = applySettings(merged, {
      persist: true,
      silent: !!opts.silent,
    });

    return requestUiConfig("POST", localApplied)
      .then(function (payload) {
        var remote = extractConfigPayload(payload) || localApplied;
        var normalized = normalizeSettings(remote);
        var binding = payload && payload.binding ? String(payload.binding) : "";
        saveLocalSettings(normalized);
        applySettings(normalized, { persist: false, silent: !!opts.silent });
        return requestUiConfig("GET")
          .then(function (verifyPayload) {
            var verifyRemote = extractConfigPayload(verifyPayload);
            if (!verifyRemote) {
              throw new Error("服务端回读配置格式异常");
            }
            var verified = normalizeSettings(verifyRemote);
            saveLocalSettings(verified);
            applySettings(verified, { persist: false, silent: !!opts.silent });

            var isMatch = JSON.stringify(verified) === JSON.stringify(normalized);
            if (!isMatch) {
              return {
                success: false,
                source: "local",
                binding:
                  binding ||
                  (verifyPayload && verifyPayload.binding
                    ? String(verifyPayload.binding)
                    : ""),
                settings: cloneSettings(verified),
                error: "保存后回读校验未通过，请检查 KV 绑定与 Functions 日志。",
              };
            }

            return {
              success: true,
              source: "server",
              binding:
                binding ||
                (verifyPayload && verifyPayload.binding
                  ? String(verifyPayload.binding)
                  : ""),
              settings: cloneSettings(verified),
            };
          })
          .catch(function (verifyError) {
            return {
              success: false,
              source: "local",
              binding: binding,
              settings: cloneSettings(localApplied),
              error:
                "保存后读取校验失败：" +
                (verifyError && verifyError.message
                  ? verifyError.message
                  : String(verifyError)),
            };
          });
      })
      .catch(function (error) {
        try {
          console.error("[ui-config] POST /api/ui-config failed:", error);
        } catch (e) {}
        if (opts.throwOnError) {
          throw error;
        }
        return {
          success: false,
          source: "local",
          binding: "",
          settings: cloneSettings(localApplied),
          error: error && error.message ? error.message : String(error),
        };
      });
  }

  function migrateLegacySettings() {
    try {
      if (localStorage.getItem(STORAGE_KEY)) return null;
      var legacyMode = String(localStorage.getItem(LEGACY_LOGIN_MODE_KEY) || "")
        .trim()
        .toLowerCase();
      var legacyUrl = sanitizeUrl(localStorage.getItem(LEGACY_LOGIN_URL_KEY));
      if (!legacyMode && !legacyUrl) return null;

      var migrated = normalizeSettings(DEFAULTS);
      if (legacyMode === "image" && legacyUrl) {
        migrated.loginBackgroundMode = "custom";
        migrated.loginBackgroundUrl = legacyUrl;
      }
      saveLocalSettings(migrated);
      return migrated;
    } catch (e) {
      return null;
    }
  }

  function isLoginPage() {
    var pathname = String(window.location.pathname || "").toLowerCase();
    return /(^|\/)login(\.html)?$/.test(pathname);
  }


  function ensureLayer(tagName, className) {
    var node = document.createElement(tagName);
    node.className = className;
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function ensureLayers() {
    if (!document.body) return false;

    if (!layers.image) layers.image = ensureLayer("div", "ui-bg-image-layer");

    if (!document.body.contains(layers.image)) {
      document.body.insertBefore(layers.image, document.body.firstChild);
    }

    return true;
  }

  function applyCompatibilityVars(next, darkMode) {
    var opacity = clampNumber(next.cardOpacity, 0, 100) / 100;
    var blur = Math.round(clampNumber(next.cardBlur, 0, 32));

    // 2026-10-17 用户决策：解除「卡片一律实心」的 1.0 下限，透明度恢复
    // 0-100% 可调（此前 opacity 被钳在 1.0，UI 面板的透明度/模糊滑杆
    // 全成摆设）。壁纸透进卡片多少，由用户自己拿捏。
    var transparentCards = opacity <= 0.001;
    var useBackdropFilter = blur > 0 && !transparentCards;
    // 这些表面色 theme.css 的 --ui-* 权威层已经按主题定义好了。
// 原先这里在 JS 里又算了一遍（深色下算出 rgb(19,24,33)，而权威层是
// #0d1117），然后用内联样式写在 <html> 上 —— 内联优先级高于 :root，
// 于是同一个语义有两套值，且 CSS 那套永远不生效。这正是"样式没有统一
// 管理"的最后一处漏点：改主题.css 改不动这里。
// 现在改为引用权威层，只保留 JS 独有的产物（透明度旋钮本身）。
// 注意取的是上面按 cardOpacity 归一的 opacity（0-1）。transparentCards
// 分支保留：0 透明度时表面色整体撤掉，卡片只剩描边和投影。
var surfaceAlpha = transparentCards ? 0 : opacity;
var cardBg = "var(--ui-surface)";
var surface1 = "var(--ui-surface-sunken)";
var surface2 = "var(--ui-surface)";
var surface3 = "var(--ui-surface-raised)";
var border = "var(--ui-line)";
var inputBorder = "var(--ui-line-strong)";
var shadow = "var(--ui-elev-2)";
var shadowHover = "var(--ui-elev-3)";
var wfShadow = "var(--ui-elev-2)";
var wfShadowSoft = "var(--ui-elev-1)";
var uiShadowSoft = "var(--ui-elev-2)";
var uiShadowSoftDark = "var(--ui-elev-2)";
void darkMode;

    if (transparentCards) {
      root.setAttribute("data-ui-transparent-cards", "true");
    } else {
      root.removeAttribute("data-ui-transparent-cards");
    }

    // 页面底色现在完全由主题层决定：--ui-canvas 从 --ui-canvas-light/-dark
    // 里挑一份，而两份都是 hsl(var(--ui-hue) calc(var(--ui-tint) * k) L%) ——
    // 色相和强度来自壁纸，JS 通过 --ui-hue / --ui-tint 参与，明度配方留在
    // CSS 里。
    //
    // 这里原先写 `--ui-canvas-light = next.baseColor`。那个 baseColor 已经
    // 死了：admin 面板里没有任何控件会改它，读值处永远回 #fafaf8，于是每次
    // applySettings 都把画布钉回白底 —— 内联优先级高于 :root，壁纸取色根本
    // 生效不了。删掉，画布回归 CSS 单一来源。
    // 夜间档不再由 JS 写死：它跟着 --ui-canvas-dark 走。此前这里写
    // #101318，与权威层的 #0d1117 是两个值，内联那份还会把 CSS 覆盖掉。
    root.style.setProperty("--ui-card-opacity", surfaceAlpha.toFixed(2));
    root.style.setProperty("--ui-card-blur", blur + "px");
    root.style.setProperty("--ui-card-backdrop-filter",
      useBackdropFilter ? "blur(" + blur + "px) saturate(115%)" : "none"
    );

    // 壁纸强度旋钮（2026-10-17 开放给用户）：图层不透明度与画布色蒙版
    // 原本钉死在 theme.css（0.55/0.30），用户拉到 100% 也能完整显示壁纸。
    // 内联写在 <html> 上会同时覆盖亮/暗两档 CSS 值 —— DIY 取向下接受
    // 全主题统一：用户要什么强度就是什么强度，不再由设计替他拿主意。
    // CSS 里的默认值仅在 JS 未执行时兜底。
    var wallOpacity = clampNumber(next.wallpaperOpacity, 0, 100) / 100;
    var wallMask = clampNumber(next.wallpaperMask, 0, 100) / 100;
    root.style.setProperty("--ui-wall-opacity", wallOpacity.toFixed(2));
    root.style.setProperty("--ui-wall-mask", wallMask.toFixed(2));

    root.style.setProperty("--ui-shadow-soft", uiShadowSoft);
    root.style.setProperty("--ui-shadow-soft-dark", uiShadowSoftDark);
    root.style.setProperty("--bg-gradient", "none");
    root.style.setProperty("--bg", darkMode ? "var(--ui-page-bg-dark)" : "var(--ui-page-bg)");
    root.style.setProperty("--card-bg", cardBg);
    root.style.setProperty("--surface-1", surface1);
    root.style.setProperty("--surface-2", surface2);
    root.style.setProperty("--surface-3", surface3);
    root.style.setProperty("--surface-border", border);
    root.style.setProperty("--input-border", inputBorder);
    root.style.setProperty("--shadow", shadow);
    root.style.setProperty("--shadow-hover", shadowHover);

    root.style.setProperty("--wf-surface", cardBg);
    root.style.setProperty("--wf-border", border);
    root.style.setProperty("--wf-shadow", wfShadow);
    root.style.setProperty("--wf-shadow-soft", wfShadowSoft);
  }

  function resolveBackgroundUrl(next) {
    var globalUrl = sanitizeUrl(next.globalBackgroundUrl);
    if (isLoginPage() && next.loginBackgroundMode === "custom") {
      return sanitizeUrl(next.loginBackgroundUrl) || globalUrl;
    }
    return globalUrl;
  }

  /* ===== 壁纸取色 ======================================================
     全站没有主题色：强调色与中性面的色相都从壁纸算出来。这里做三件事 ——
     读壁纸像素 → 归纳出一个色相 → 写成 CSS 变量。明度阶梯不在这里定，
     那是 theme.css 的事（每个角色一份亮/暗配方），JS 只给色相和强度。

     没有壁纸、壁纸是灰阶、或跨域读不到像素时，一律走单色回退：
     --ui-tint 停在 0%，CSS 里所有色度项塌成 0，页面就是黑白稿。 */

  var PALETTE_CACHE_KEY = "kvUiWallpaperPalette";
  // 取样尺寸：取色只需要"这张图整体偏什么色"，48×48 足够，
  // 而且与原图大小无关 —— 2K 壁纸和缩略图耗时一样。
  var PALETTE_SAMPLE_SIZE = 48;

  /* 用来把 token 解析成真实 rgb 的探针。把 var(--ui-*-light/-dark) 赋给
     background-color 这类真实属性时，浏览器会替我们完成 var() 替换与 calc()
     求值，拿到的就是屏幕上那个颜色 —— 于是 JS 不必再抄一份明度配方。
     这一点很重要：配方抄到 JS 就又多了一处真值，改 CSS 改不动代码。

     挂在 <html> 上而不是 <body>：本脚本 eval 时 body 未必存在，而
     documentElement 一定在。背景传播只作用于 html/body 自身，挂在 html
     下面的 0×0 隐藏盒什么都不画，因此不会干扰页面。 */
  var probe = null;

  function ensureProbe() {
    if (probe && probe.isConnected) return probe;
    var host = document.documentElement;
    if (!host) return null;
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    // 全部样式内联：这个盒子不进样式表，也就不会变成一条"没有元素匹配"的
    // 死 CSS 规则。
    probe.style.cssText =
      "position:absolute;width:0;height:0;visibility:hidden;pointer-events:none;top:0;left:0";
    host.appendChild(probe);
    return probe;
  }

  function parseCssColor(value) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(String(value || ""));
    if (!m) return null;
    return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
  }

  function resolveTokenColors(names) {
    var el = ensureProbe();
    if (!el) return null;
    var out = [];
    for (var i = 0; i < names.length; i += 1) {
      el.style.backgroundColor = "var(" + names[i] + ")";
      var rgb = parseCssColor(window.getComputedStyle(el).backgroundColor);
      if (rgb) out.push(rgb);
    }
    el.style.backgroundColor = "";
    return out.length ? out : null;
  }

  /* 强调色要压在这些底面上读得清，所以搜索时把它们全部作为约束。
     挑的是每个主题下最不利的那几个，而不是全部六个面：约束越少越容易
     在极端色相上找到解，而搜索一旦失败就得回退单色（整页失色）。
     - active 是该主题下离底最远的一档（亮色最暗 / 暗色最亮），绑定最强
     - sunken 次之
     - ink-inverse 是"压在实心强调色上的那层文字"的反相，等于把
       "强调色当按钮底"这一用途也一并约束进去 */
  var LIGHT_CONSTRAINT_TOKENS = [
    "--ui-surface-active-light",
    "--ui-surface-sunken-light",
    "--ui-ink-inverse-light",
  ];
  var DARK_CONSTRAINT_TOKENS = [
    "--ui-surface-active-dark",
    "--ui-surface-sunken-dark",
    "--ui-ink-inverse-dark",
  ];

  function readPaletteCache() {
    try {
      var raw = localStorage.getItem(PALETTE_CACHE_KEY);
      if (!raw) return null;
      var entry = JSON.parse(raw);
      if (!entry || typeof entry.url !== "string") return null;
      return entry;
    } catch (e) {
      return null;
    }
  }

  function writePaletteCache(entry) {
    try {
      localStorage.setItem(PALETTE_CACHE_KEY, JSON.stringify(entry));
    } catch (e) {}
  }

  /** 把一套调色板写进 CSS。四个变量，两个旋钮 + 两档强调色。 */
  function applyPalette(palette) {
    if (!palette) return;
    root.style.setProperty("--ui-hue", String(palette.hue));
    root.style.setProperty("--ui-tint", palette.tint + "%");
    if (palette.accent) {
      root.style.setProperty("--ui-brand-light", palette.accent.light);
      root.style.setProperty("--ui-brand-dark", palette.accent.dark);
    }
  }

  /** 单色回退：没有可用色相时页面就是黑白稿。 */
  function monoPalette(api) {
    return api.buildPalette(null, {});
  }

  /**
   * 由提取结果构造调色板。
   *
   * 分两步：先把色相/强度写进 CSS，这样下面探针读到的就是**这张壁纸的**
   * 真实底面；再拿这些底面去搜强调色。顺序不能反 —— 底面本身带着壁纸的
   * 色度，用"纯白/纯黑"当底面搜出来的强调色会偏亮/偏暗，实测压在真实
   * 底面上有 294 个色相达不到 4.5:1（最差 3.93）。
   */
  function buildPalette(api, extracted) {
    var hue = extracted && typeof extracted.hue === "number" && isFinite(extracted.hue)
      ? extracted.hue
      : null;
    var tint = extracted ? api.tintForSaturation(extracted.sat) : 0;

    // tint 为 0 就等于没有可用色相：没壁纸，或者是张灰阶图。
    if (hue === null || tint <= 0) return monoPalette(api);

    root.style.setProperty("--ui-hue", String(hue));
    root.style.setProperty("--ui-tint", tint + "%");

    var lightBgs = resolveTokenColors(LIGHT_CONSTRAINT_TOKENS);
    var darkBgs = resolveTokenColors(DARK_CONSTRAINT_TOKENS);

    return api.buildPalette(extracted, {
      backgroundsLight: lightBgs || undefined,
      backgroundsDark: darkBgs || undefined,
    });
  }

  /**
   * 读壁纸像素并归纳色相。
   *
   * 跨域壁纸若没带 CORS 头，画布会被标为 tainted，getImageData 抛异常 ——
   * 那是"读不到"，不是"没颜色"，同样走单色回退（回调 null）。
   */
  function extractFromUrl(url, done) {
    var api = paletteApi();
    if (!api) {
      done(null);
      return;
    }
    var img = new Image();
    if (!/^data:/i.test(url)) img.crossOrigin = "anonymous";
    img.onload = function () {
      var extracted = null;
      try {
        var canvas = document.createElement("canvas");
        canvas.width = PALETTE_SAMPLE_SIZE;
        canvas.height = PALETTE_SAMPLE_SIZE;
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, PALETTE_SAMPLE_SIZE, PALETTE_SAMPLE_SIZE);
        var data = ctx.getImageData(0, 0, PALETTE_SAMPLE_SIZE, PALETTE_SAMPLE_SIZE).data;
        extracted = api.extractHue(data);
      } catch (e) {
        extracted = null;
      }
      done(extracted);
    };
    img.onerror = function () {
      done(null);
    };
    img.src = url;
  }

  /**
   * 应用壁纸调色板。
   *
   * 每次进页面（MPA 切换）壁纸都要重新取色；取色要下载整张图，实测线上
   * 壁纸 514 KB，于是切一次页面就是双份下载（CSS 背景一份 + 取色一份）。
   * 取色结果已按「壁纸 URL」落盘在 localStorage：URL 没变就直接用缓存，
   * 不再下载第二份。只有 URL 变化（换壁纸）才真正重新取色。
   */
  function refreshPalette(url) {
    var api = paletteApi();
    if (!api) return;

    if (paletteState.url === url) return;
    paletteState.url = url;

    if (!url) {
      applyPalette(monoPalette(api));
      writePaletteCache({ url: "" });
      return;
    }

    // 命中同 URL 的取色缓存：直接上色，本轮不再发起任何网络请求。
    var cached = readPaletteCache();
    if (cached && cached.url === url && typeof cached.hue === "number" && cached.brandLight) {
      applyPalette({
        hue: cached.hue,
        tint: cached.tint,
        accent: { light: cached.brandLight, dark: cached.brandDark },
      });
      return;
    }

    extractFromUrl(url, function (extracted) {
      // 下载期间用户又换了壁纸，这次结果已经过期，丢弃。
      if (paletteState.url !== url) return;
      var palette = buildPalette(api, extracted);
      applyPalette(palette);
      writePaletteCache({
        url: url,
        hue: palette.hue,
        tint: palette.tint,
        brandLight: palette.accent ? palette.accent.light : "",
        brandDark: palette.accent ? palette.accent.dark : "",
      });
    });
  }

  /** 首帧之前尽量用上次的结果，避免"先黑白再上色"的闪动。 */
  function applyCachedPalette(url) {
    var api = paletteApi();
    if (!api) return;
    var cached = readPaletteCache();
    if (!cached || cached.url !== url) return;
    if (url && (typeof cached.hue !== "number" || !cached.brandLight)) return;
    applyPalette({
      hue: cached.hue,
      tint: cached.tint,
      accent: { light: cached.brandLight, dark: cached.brandDark },
    });
  }

  function paletteApi() {
    return window.KVAccentColor || null;
  }

  var paletteState = { url: null };

  /**
   * 给站内壁纸 URL 附加 v 指纹，让 /file/ 代理放行长缓存。
   *
   * 服务端对 /file/ 默认 no-store（文件撤下后不能再从缓存读到），只有带 v
   * 参数的请求才给 immutable —— v 就是调用方「这个 URL 的内容不变」的声明。
   * 指纹从 URL 自身派生：同一张壁纸每次进页面得到同一个 v，浏览器直接拿缓存；
   * 管理员换了壁纸，URL 变了、指纹也变，自然拉新图。
   * 外部图床（https://其他域名）不归本站代理，原样返回不加参数。
   */
  function withWallpaperCacheKey(url) {
    if (!url) return url;
    try {
      var parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) return url;
      // 简易稳定哈希（djb2）：只需要同串同值、不同串大概率不同值。
      var hash = 5381;
      for (var i = 0; i < url.length; i++) {
        hash = ((hash << 5) + hash + url.charCodeAt(i)) >>> 0;
      }
      parsed.searchParams.set("v", hash.toString(36));
      return parsed.pathname + "?" + parsed.searchParams.toString();
    } catch (e) {
      return url;
    }
  }

  function applyBackgroundLayers(next) {
    if (!ensureLayers()) return;
    var url = resolveBackgroundUrl(next);
    if (url) {
      var cachedUrl = withWallpaperCacheKey(url);
      layers.image.style.display = "block";
      layers.image.style.backgroundImage = 'url("' + cachedUrl.replace(/"/g, '\\"') + '")';
    } else {
      layers.image.style.display = "none";
      layers.image.style.backgroundImage = "none";
    }
    // 取色与壁纸本身同一个来源：换了壁纸才算，没壁纸就退回黑白。
    refreshPalette(url);
  }

  /* 纸纹特效（texture）已整体下线（2026-10-17 用户决策）。
     再往前 math（数学符号）与 particle（粒子网格）两档 canvas 动画也移除过：
     画布挂在 body 的不透明背景之下，画出来的东西 100% 看不见，却要每秒
     数百次 fillText。特效这一族至此全部退役，配置字段（effectStyle /
     effectIntensity / optimizeMobile）保留在结构里，normalizeSettings
     会把存量值归零，旧 KV 数据读回来不会缺键。 */


  function hideLegacyLoginLayers() {
    if (!document.body) return;
    document.body.classList.remove("has-bg-image");
    var legacyImageLayer = document.getElementById("bgImageLayer");
    var legacyOverlay = document.getElementById("bgOverlay");
    if (legacyImageLayer) legacyImageLayer.style.display = "none";
    if (legacyOverlay) legacyOverlay.style.display = "none";
  }

  function dispatchDesignChange(next, persisted) {
    try {
      window.dispatchEvent(
        new CustomEvent("ui:design-change", {
          detail: { settings: cloneSettings(next), persisted: !!persisted },
        })
      );
    } catch (e) {}
  }

  function applySettings(next, options) {
    var opts = options || {};
    var normalized = normalizeSettings(next || settings || DEFAULTS);
    var darkMode = root.getAttribute("data-theme") === "dark";
    settings = normalized;
    applyCompatibilityVars(settings, darkMode);

    if (document.body) {
      if (isLoginPage()) document.body.classList.add("login-page");
      hideLegacyLoginLayers();
      applyBackgroundLayers(settings);

    }

    if (opts.persist) {
      saveLocalSettings(settings);
    }
    if (!opts.silent) {
      dispatchDesignChange(settings, opts.persist);
    }
    return cloneSettings(settings);
  }

  function setSettings(partial, options) {
    var opts = options || {};
    var merged = Object.assign({}, settings || DEFAULTS, partial || {});
    return applySettings(merged, {
      persist: opts.persist !== false,
      silent: !!opts.silent,
    });
  }

  function previewSettings(partial) {
    var merged = Object.assign({}, settings || DEFAULTS, partial || {});
    return applySettings(merged, { persist: false, silent: true });
  }

  function resetSettings() {
    var fresh = normalizeSettings(DEFAULTS);
    saveLocalSettings(fresh);
    return applySettings(fresh, { persist: false, silent: false });
  }

  function restorePersisted() {
    var persisted = readSettings();
    return applySettings(persisted, { persist: false, silent: true });
  }

  function clearBackgrounds(options) {
    return setSettings(
      {
        globalBackgroundUrl: "",
        loginBackgroundMode: "follow-global",
        loginBackgroundUrl: "",
      },
      options
    );
  }

  function bindGlobalListeners() {
    window.addEventListener("theme:change", function () {
      applySettings(settings, { persist: false, silent: true });
    });

    window.addEventListener("storage", function (event) {
      if (event.key !== STORAGE_KEY) return;
      settings = readSettings();
      applySettings(settings, { persist: false, silent: true });
    });

    // 以前这里有 resize 与 visibilitychange 两个监听：resize 要重算画布尺寸
    // 并重启动画循环，visibilitychange 要在切回标签页时把动画重新跑起来。
    // 画布动画已经删除，两者都随之失去意义 —— 壁纸层是 CSS
    // background-size: cover，纸纹是静态 background-image，两者都会随视口
    // 自己重排，不需要 JS 介入。拖动窗口时的卡顿正是 resize 那个监听造成的，
    // 所以这里直接删掉而不是留一个空壳。
    // 纸纹下线后，下面那个 768px 断点监听（唯一调用方是 applyEffect）也
    // 一并删除：留着会在跨断点时调用不存在的函数。
  }

  function init() {
    if (!document.body) return;
    if (isLoginPage()) document.body.classList.add("login-page");
    ensureLayers();
    applySettings(settings, { persist: false, silent: true });
  }

  var manager = {
    getSettings: function () {
      return cloneSettings(settings);
    },
    getDefaults: function () {
      return cloneSettings(DEFAULTS);
    },
    setSettings: setSettings,
    syncFromServer: syncFromServer,
    saveToServer: saveToServer,
    previewSettings: previewSettings,
    restorePersisted: restorePersisted,
    resetSettings: resetSettings,
    clearBackgrounds: clearBackgrounds,
    applySettings: function (next, options) {
      return applySettings(next, options || {});
    },
  };

  window.UIDesignManager = manager;

  settings = migrateLegacySettings() || readSettings();
  applySettings(settings, { persist: false, silent: true });
  bindGlobalListeners();
  syncFromServer({ silent: true, applyLocalOnFailure: false });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
