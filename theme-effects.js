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
  var EFFECT_STYLES = { none: true, math: true, particle: true, texture: true };

  var DEFAULTS = {
    version: 1,
    baseColor: "#fafaf8",
    globalBackgroundUrl: "",
    loginBackgroundMode: "follow-global",
    loginBackgroundUrl: "",
    cardOpacity: 86,
    cardBlur: 14,
    effectStyle: "math",
    effectIntensity: 22,
    optimizeMobile: true,
  };

  var root = document.documentElement;
  var settings = null;
  var layers = { image: null, canvas: null, noise: null };
  var render = {
    ctx: null,
    rafId: 0,
    width: 0,
    height: 0,
    lastTs: 0,
    style: "none",
    intensity: 0,
    mobile: false,
    maxFps: 30,
    symbols: [],
    particles: [],
  };

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
    next.effectStyle = EFFECT_STYLES[next.effectStyle]
      ? next.effectStyle
      : DEFAULTS.effectStyle;
    next.effectIntensity = Math.round(clampNumber(next.effectIntensity, 0, 100));
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

  function isMobileDevice() {
    var byWidth =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(max-width: 768px)").matches
        : window.innerWidth <= 768;
    var byTouch = Number(navigator.maxTouchPoints || 0) > 0;
    return byWidth || byTouch;
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
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
    if (!layers.canvas) layers.canvas = ensureLayer("canvas", "ui-bg-canvas-layer");
    if (!layers.noise) layers.noise = ensureLayer("div", "ui-bg-noise-layer");

    if (!document.body.contains(layers.image)) {
      document.body.insertBefore(layers.image, document.body.firstChild);
    }
    if (!document.body.contains(layers.canvas)) {
      document.body.insertBefore(layers.canvas, layers.image.nextSibling);
    }
    if (!document.body.contains(layers.noise)) {
      document.body.insertBefore(layers.noise, layers.canvas.nextSibling);
    }

    if (!render.ctx) {
      render.ctx = layers.canvas.getContext("2d", { alpha: true });
    }

    ensureCanvasSize();
    return true;
  }

  function ensureCanvasSize() {
    if (!layers.canvas || !render.ctx) return;
    var width = Math.max(window.innerWidth || 0, 1);
    var height = Math.max(window.innerHeight || 0, 1);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pixelWidth = Math.max(1, Math.floor(width * dpr));
    var pixelHeight = Math.max(1, Math.floor(height * dpr));

    if (layers.canvas.width !== pixelWidth || layers.canvas.height !== pixelHeight) {
      layers.canvas.width = pixelWidth;
      layers.canvas.height = pixelHeight;
      layers.canvas.style.width = width + "px";
      layers.canvas.style.height = height + "px";
      render.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    render.width = width;
    render.height = height;
  }

  function clearCanvas() {
    if (!render.ctx) return;
    render.ctx.clearRect(0, 0, render.width || 0, render.height || 0);
  }

  function stopRender(shouldClear) {
    if (render.rafId) {
      cancelAnimationFrame(render.rafId);
      render.rafId = 0;
    }
    render.lastTs = 0;
    if (shouldClear) clearCanvas();
  }

  function getEffectNodeCount(intensity, mobile) {
    var count = Math.round(8 + intensity * 0.32);
    if (mobile) count = Math.max(5, Math.round(count * 0.35));
    return Math.min(40, Math.max(4, count));
  }

  function buildMathSymbols(count, mobile) {
    var chars = ["∑", "∫", "π", "√", "∞", "∆", "∂", "λ", "θ", "∇", "⊕", "≈", "µ"];
    var symbols = [];
    var i = 0;
    for (i = 0; i < count; i += 1) {
      symbols.push({
        text: chars[Math.floor(Math.random() * chars.length)],
        x: Math.random() * render.width,
        y: Math.random() * render.height,
        vx: (Math.random() - 0.5) * (mobile ? 7 : 11),
        vy: (mobile ? 4 : 7) + Math.random() * (mobile ? 6 : 10),
        size: (mobile ? 10 : 11) + Math.random() * (mobile ? 7 : 12),
        alpha: (mobile ? 0.06 : 0.05) + Math.random() * (mobile ? 0.08 : 0.11),
      });
    }
    render.symbols = symbols;
  }

  function buildParticles(count, mobile) {
    var nodes = [];
    var speed = mobile ? 11 : 16;
    var i = 0;
    for (i = 0; i < count; i += 1) {
      nodes.push({
        x: Math.random() * render.width,
        y: Math.random() * render.height,
        vx: (Math.random() - 0.5) * speed,
        vy: (Math.random() - 0.5) * speed,
        r: (mobile ? 0.75 : 0.9) + Math.random() * (mobile ? 1.2 : 1.5),
      });
    }
    render.particles = nodes;
  }

  function updateMathSymbols(deltaSec) {
    var i = 0;
    var item = null;
    var width = render.width;
    var height = render.height;
    for (i = 0; i < render.symbols.length; i += 1) {
      item = render.symbols[i];
      item.y -= item.vy * deltaSec;
      item.x += item.vx * deltaSec;

      if (item.y < -40) item.y = height + 40;
      if (item.x < -40) item.x = width + 40;
      if (item.x > width + 40) item.x = -40;
    }
  }

  function drawMathSymbols() {
    var ctx = render.ctx;
    var dark = root.getAttribute("data-theme") === "dark";
    var rgb = dark ? "201, 214, 237" : "102, 113, 132";
    var i = 0;
    var item = null;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (i = 0; i < render.symbols.length; i += 1) {
      item = render.symbols[i];
      ctx.font =
        Math.round(item.size) +
        'px "Cambria Math", "Times New Roman", "Noto Sans SC", serif';
      ctx.fillStyle = "rgba(" + rgb + ", " + item.alpha.toFixed(3) + ")";
      ctx.fillText(item.text, item.x, item.y);
    }
  }

  function updateParticles(deltaSec) {
    var i = 0;
    var point = null;
    var width = render.width;
    var height = render.height;
    for (i = 0; i < render.particles.length; i += 1) {
      point = render.particles[i];
      point.x += point.vx * deltaSec;
      point.y += point.vy * deltaSec;

      if (point.x <= 0 || point.x >= width) point.vx *= -1;
      if (point.y <= 0 || point.y >= height) point.vy *= -1;
    }
  }

  function drawParticles() {
    var ctx = render.ctx;
    var dark = root.getAttribute("data-theme") === "dark";
    var rgb = dark ? "184, 198, 225" : "119, 131, 150";
    var dotAlphaBase = dark ? 0.23 : 0.18;
    var lineAlphaBase = dark ? 0.16 : 0.12;
    var intensityFactor = Math.max(0.2, render.intensity / 100);
    var distanceLimit = render.mobile ? 110 : 145;
    var i = 0;
    var j = 0;
    var a = null;
    var b = null;
    var dx = 0;
    var dy = 0;
    var distance = 0;
    var alpha = 0;

    for (i = 0; i < render.particles.length; i += 1) {
      a = render.particles[i];
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle =
        "rgba(" + rgb + ", " + (dotAlphaBase * intensityFactor).toFixed(3) + ")";
      ctx.fill();

      for (j = i + 1; j < render.particles.length; j += 1) {
        b = render.particles[j];
        dx = a.x - b.x;
        dy = a.y - b.y;
        distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > distanceLimit) continue;
        alpha =
          ((1 - distance / distanceLimit) * lineAlphaBase * intensityFactor).toFixed(
            3
          );
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = "rgba(" + rgb + ", " + alpha + ")";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function startRender(style, intensity, mobile) {
    stopRender(true);
    render.style = style;
    render.intensity = intensity;
    render.mobile = mobile;
    render.maxFps = mobile ? 14 : 30;

    if (!render.ctx || style === "none" || style === "texture" || prefersReducedMotion()) {
      return;
    }

    var nodeCount = getEffectNodeCount(intensity, mobile);
    if (style === "math") buildMathSymbols(nodeCount, mobile);
    if (style === "particle") buildParticles(nodeCount, mobile);

    render.rafId = requestAnimationFrame(function frame(ts) {
      render.rafId = requestAnimationFrame(frame);
      if (document.hidden) return;

      var minDelta = 1000 / render.maxFps;
      if (render.lastTs && ts - render.lastTs < minDelta) return;
      var deltaSec = render.lastTs ? (ts - render.lastTs) / 1000 : minDelta / 1000;
      render.lastTs = ts;
      if (deltaSec > 0.08) deltaSec = 0.08;

      clearCanvas();

      if (render.style === "math") {
        updateMathSymbols(deltaSec);
        drawMathSymbols();
      } else if (render.style === "particle") {
        updateParticles(deltaSec);
        drawParticles();
      }
    });
  }

  function applyCompatibilityVars(next, darkMode) {
    var opacity = clampNumber(next.cardOpacity, 0, 100) / 100;
    var blur = Math.round(clampNumber(next.cardBlur, 0, 32));

    // 壁纸已经退到背景里（.ui-bg-image-layer 被压到 12% 可见度），
    // 卡片就不该再透——壁纸透进卡片等于回到磨砂玻璃的老路：
    // 每块玻璃是一堵信息墙，深色壁纸上投影又消失，层级全靠色彩撑。
    // 所以把下限提到 1.0：卡片一律实心，壁纸只在卡片之间的空隙里露面。
    opacity = Math.max(1.0, opacity);

    var transparentCards = opacity <= 0.001;
    var useBackdropFilter = blur > 0 && !transparentCards;
    // 这些表面色 theme.css 的 --ui-* 权威层已经按主题定义好了。
// 原先这里在 JS 里又算了一遍（深色下算出 rgb(19,24,33)，而权威层是
// #0d1117），然后用内联样式写在 <html> 上 —— 内联优先级高于 :root，
// 于是同一个语义有两套值，且 CSS 那套永远不生效。这正是"样式没有统一
// 管理"的最后一处漏点：改主题.css 改不动这里。
// 现在改为引用权威层，只保留 JS 独有的产物（透明度旋钮本身）。
var transparentCards = opacity <= 0.001;
var useBackdropFilter = blur > 0 && !transparentCards;
var surfaceAlpha = transparentCards ? 0 : clampNumber(next.cardOpacity, 0, 100) / 100;
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

// 页面底色只有一个概念、一个名字。原先这里只写 --ui-page-bg，而壁纸蒙版
// 读的是 --ui-canvas：管理员在 UI 面板里改了 baseColor，body 会变，
// 蒙版却不跟着变，最后蒙版用浅色压住一张已经偏色的背景 —— 全局看着发灰。
// 两个名字并存是"样式没有统一管理"的根源，这里收敛到 --ui-canvas。
root.style.setProperty("--ui-canvas", next.baseColor);
root.style.setProperty("--ui-page-bg", next.baseColor);
root.style.setProperty("--ui-page-bg-dark", "#101318");
    root.style.setProperty("--ui-card-opacity", surfaceAlpha.toFixed(2));
    root.style.setProperty("--ui-card-blur", blur + "px");
    root.style.setProperty(
      "--ui-card-backdrop-filter",
      useBackdropFilter ? "blur(" + blur + "px) saturate(115%)" : "none"
    );
    root.style.setProperty("--ui-noise-opacity", "0");
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

  function applyBackgroundLayers(next) {
    if (!ensureLayers()) return;
    var url = resolveBackgroundUrl(next);
    if (url) {
      layers.image.style.display = "block";
      layers.image.style.backgroundImage = 'url("' + url.replace(/"/g, '\\"') + '")';
    } else {
      layers.image.style.display = "none";
      layers.image.style.backgroundImage = "none";
    }
  }

  function applyEffect(next) {
    if (!ensureLayers()) return;

    var style = next.effectStyle;
    var intensity = clampNumber(next.effectIntensity, 0, 100);
    var mobile = isMobileDevice();
    var optimizedMobile = next.optimizeMobile && mobile;

    if (style === "texture") {
      var noiseBase = 0.06 + intensity / 100 * 0.16;
      root.style.setProperty("--ui-noise-opacity", noiseBase.toFixed(3));
    } else {
      root.style.setProperty("--ui-noise-opacity", "0");
    }

    if (optimizedMobile && (style === "math" || style === "particle")) {
      intensity = Math.max(6, Math.round(intensity * 0.45));
      root.setAttribute("data-ui-mobile-optimized", "true");
    } else {
      root.removeAttribute("data-ui-mobile-optimized");
    }

    startRender(style, intensity, optimizedMobile);
  }

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
      applyEffect(settings);
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

    window.addEventListener("resize", function () {
      if (!ensureLayers()) return;
      ensureCanvasSize();
      if (render.style === "math" || render.style === "particle") {
        startRender(render.style, render.intensity, render.mobile);
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopRender(false);
      } else {
        applyEffect(settings);
      }
    });

    if (typeof window.matchMedia === "function") {
      var media = window.matchMedia("(max-width: 768px)");
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", function () {
          applyEffect(settings);
        });
      } else if (typeof media.addListener === "function") {
        media.addListener(function () {
          applyEffect(settings);
        });
      }
    }
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
