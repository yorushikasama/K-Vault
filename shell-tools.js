/**
 * 应用外壳的共享工具面板：系统连接、UI 设计。四个分区页（上传 / 文件 /
 * 图库 / 视频）共用。
 *
 * ── 为什么是原生 DOM，不是组件 ──────────────────────────────────────
 * 这两个面板原先长在文件页里，用的是 <el-popover> 和 this.$alert()。
 * 把它们提上来放进顶栏，就得让另外三页也能用 —— 而只有文件页加载了
 * Element UI（183 KB gzip，test/frontend-assets-contract.test.js 明确断言
 * 其余页面不得引入）。所以这里用原生 DOM 重写：四页都只需要
 * kv-shared.js + theme-effects.js，两样本来就在。
 *
 * 功能与面板字段与原实现一致，底层仍走 window.UIDesignManager
 * （theme-effects.js 定义，四个分区页都加载）。
 *
 * ── 为什么不写在页面标记里 ──────────────────────────────────────────
 * 页面里只留 <button data-shell-tool="connection"> 这样的占位，行为一律
 * 在这里绑定。这样页面不出现 @click="openXxx"，test/dead-methods-contract
 * 的「引用的方法必须有定义」也就不会误报；同时四个页面的工具区标记可以
 * 保持逐字一致，app-shell-contract 的核对才立得住。
 */
(function () {
  "use strict";

  var ICONS = {
    connection: "activity",
    design: "palette",
  };

  /** 后端 → 展示名。与 admin-app.js 的 connectionLabel 同一张表。 */
  var CONNECTION_LABELS = {
    telegram: "Telegram",
    kv: "KV 存储",
    r2: "R2 存储",
    s3: "S3 存储",
    discord: "Discord",
    huggingface: "HuggingFace",
    github: "GitHub",
    auth: "身份验证",
  };

  /**
   * 展示哪些后端，按这个顺序。
   *
   * 刻意写成白名单而不是遍历响应：Node / Docker 后端比 Pages 多返回
   * uploadConcurrency、settings、diagnostics 等字段，遍历的话它们会变成
   * 三行没人认得的裸 key。服务端另有的 guestUpload、uploadLimits、
   * capabilities 同理——它们是给上传页和存储选择器用的，不是「连接状态」。
   */
  var CONNECTION_KEYS = [
    "telegram",
    "kv",
    "r2",
    "s3",
    "discord",
    "huggingface",
    "github",
    "auth",
  ];

  var openPanel = null; // 当前打开的面板，null 表示没打开
  var ignoreNextOutsideClick = false; // 忽略「打开面板的那一下」的关闭请求

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function icons(root) {
    if (window.KVIcons && typeof window.KVIcons.render === "function") {
      window.KVIcons.render(root);
    } else if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons({ root: root });
    }
  }

  function toast(message, type) {
    if (window.KVShared && typeof window.KVShared.toast === "function") {
      window.KVShared.toast(message, type);
    }
  }

  // ---------- 浮层 ----------

  function closePanel() {
    if (!openPanel) return;
    var node = openPanel;
    openPanel = null;
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    window.removeEventListener("resize", closePanel);
    if (node.anchor) node.anchor.setAttribute("aria-expanded", "false");
    if (node.node && node.node.parentNode) node.node.parentNode.removeChild(node.node);
  }

  function onDocumentClick(event) {
    if (!openPanel) return;
    // 打开面板的那一下点击本身不算「点外面」，否则浮层会开出来又被自己关掉。
    if (ignoreNextOutsideClick) return;
    if (openPanel.node.contains(event.target)) return;
    // 触发按钮交给 showPanel 的 toggle 处理，这里不关。
    if (openPanel.anchor && openPanel.anchor.contains(event.target)) return;
    closePanel();
  }

  function onDocumentKeydown(event) {
    if (event.key === "Escape") closePanel();
  }

  /**
   * 把浮层贴到锚点下方；装不下就翻到上方，再装不下就限高让它内部滚动。
   *
   * 单独抽出来是因为 UI 设计面板要重排一次：它先渲染一个「正在读取」占位，
   * 拿到设置后才填表单，高度变了得再定位一次——那段逻辑曾经是复制粘贴的
   * 第二份，两份各自漂移过一次（其中一份还在用 innerWidth）。
   */
  function position(node, anchor) {
    node.style.visibility = "hidden";
    node.style.top = "0px";
    node.style.left = "0px";

    var rect = anchor.getBoundingClientRect();
    var size = node.getBoundingClientRect();
    var margin = 8;
    var gap = 8;

    // 用 documentElement.clientWidth 而不是 window.innerWidth：后者**含滚动条
    // 沟槽**（根元素上写了 overflow-y:scroll），比实际可布局宽度宽出 10~15px。
    // 拿它算边界，浮层右侧就会压到沟槽里 —— 窄屏上实测正好溢出 2px。
    var viewW = document.documentElement.clientWidth;
    var viewH = document.documentElement.clientHeight;

    var left = rect.left + rect.width / 2 - size.width / 2;
    left = Math.max(margin, Math.min(left, viewW - size.width - margin));

    // CSS 里的 max-width:100% 量的是 body 的宽度，而 fixed 元素是按 left 定位的：
    // body 满宽时（370px）+ left:8px，右边缘就落在 378px 而视口可用宽度只有
    // 370px，差的就是那个 margin。所以宽度也得按同一个 margin 收一刀，
    // 只夹 left 不够 —— 窄屏上这里正好溢出 8px。
    var maxW = viewW - margin * 2;
    if (size.width > maxW) {
      node.style.width = maxW + "px";
      size = node.getBoundingClientRect();
      left = Math.max(margin, Math.min(left, viewW - size.width - margin));
    }

    var roomBelow = viewH - rect.bottom - gap - margin;
    var roomAbove = rect.top - gap - margin;
    var flips = size.height > roomBelow && roomAbove > roomBelow;
    var top = flips ? Math.max(margin, rect.top - gap - size.height) : rect.bottom + gap;

    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
    node.style.maxHeight = Math.round(Math.max(120, flips ? roomAbove : roomBelow)) + "px";
    node.style.visibility = "";
  }

  /**
   * 弹一个浮层。
   *
   * 用手写定位而不是 CSS anchor：anchor positioning 还没普及，而这一层
   * 需要「贴在按钮下方、超出视口时翻到上方、窄屏时贴边」三件事。
   */
  function showPanel(anchor, contentClass, html) {
    var wasSame = openPanel && openPanel.anchor === anchor;
    closePanel();
    if (wasSame) return null;

    var node = document.createElement("div");
    node.className = "shell-popover " + contentClass;
    node.setAttribute("role", "dialog");
    node.innerHTML = html;
    document.body.appendChild(node);

    // 先摆到屏幕外量一次真实尺寸再定位：直接算会在有滚动条 / 被 transform
    // 影响时偏。
    position(node, anchor);

    openPanel = { node: node, anchor: anchor };
    anchor.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    window.addEventListener("resize", closePanel);

    // 同一次点击会接着冒泡到 document，而上面的「点外面就关」是**捕获**阶段
    // 监听，此时 openPanel 刚赋值，面板会被自己打开的这一次点击立刻关掉。
    // 把这一轮点击标记掉：从这里开始的这一下，document 收到时不再关闭。
    ignoreNextOutsideClick = true;
    setTimeout(function () { ignoreNextOutsideClick = false; }, 0);

    icons(node);
    return node;
  }

  // ---------- 系统连接 ----------

  function connectionRowHtml(key, item) {
    item = item || {};
    // auth 用 enabled 而不是 connected：认证没有「连上了」这回事，只有
    // 开没开。这条特判原先写在 admin-app.js 里。
    var ok = key === "auth" ? Boolean(item.enabled) : Boolean(item.connected);
    var message = item.message || (item.configured ? "未配置" : "不可用");
    return (
      "<li><span>" + escapeHtml(CONNECTION_LABELS[key]) + "</span>" +
      '<span class="shell-connection-state' + (ok ? " is-connected" : "") + '">' +
      escapeHtml(message) + "</span></li>"
    );
  }

  function openConnectionPanel(anchor) {
    var node = showPanel(
      anchor,
      "shell-connection-panel",
      '<h2 class="shell-panel-title">系统连接</h2>' +
        '<ul class="shell-connection-list">' +
        CONNECTION_KEYS.map(function (key) {
          return connectionRowHtml(key, { message: "检查中..." });
        }).join("") +
        "</ul>"
    );
    if (!node) return; // 刚点的那次是「切回关闭」

    var list = node.querySelector(".shell-connection-list");
    var refresh = node.querySelector("[data-shell-refresh]");
    if (refresh) {
      refresh.addEventListener("click", function () { load(); });
    }

    // 按需探测：这个端点会同时打 7 个后端（Telegram / GitHub / HuggingFace
    // 都是跨境请求），延迟取最慢的那个。原先文件页在 mounted() 里无条件
    // 触发，于是每次进页面都付一次全站最慢的那个延迟。现在点开才查。
    var token = 0;
    function load() {
      var mine = ++token;
      list.setAttribute("aria-busy", "true");
      if (refresh) refresh.disabled = true;
      fetch("/api/status", { credentials: "include" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (status) {
          if (mine !== token || !openPanel || openPanel.node !== node) return;
          list.innerHTML = CONNECTION_KEYS.map(function (key) {
            return connectionRowHtml(key, status[key]);
          }).join("");
        })
        .catch(function (error) {
          if (mine !== token || !openPanel || openPanel.node !== node) return;
          list.innerHTML =
            '<li class="shell-connection-error"><span>读取失败</span><span>' +
            escapeHtml(error.message || String(error)) + "</span></li>";
        })
        .then(function () {
          if (mine !== token || !openPanel || openPanel.node !== node) return;
          list.removeAttribute("aria-busy");
          if (refresh) refresh.disabled = false;
        });
    }
    load();
  }

  // ---------- UI 设计 ----------

  function designFormHtml(snapshot, defaults) {
    var checked = function (condition) { return condition ? "checked" : ""; };
    return (
      '<h2 class="shell-panel-title">前端 UI 设计</h2>' +
      '<p class="shell-panel-sub">当前改动实时预览，保存后同步到所有设备。</p>' +

      '<section class="shell-panel-section">' +
      '<div class="shell-panel-section-title">背景图设置（全站）</div>' +
      '<input id="uiGlobalBgUrl" class="shell-panel-input" type="text" value="' +
      escapeHtml(snapshot.globalBackgroundUrl) +
      '" placeholder="图片链接（https://example.com/bg.jpg）">' +
      '<div class="shell-panel-inline">' +
      '<button type="button" id="uiUploadGlobalBtn" class="shell-panel-btn">上传图片</button>' +
      '<input id="uiUploadGlobalInput" type="file" accept="image/*" class="shell-hidden-input">' +
      '<button type="button" id="uiClearGlobalBg" class="shell-panel-btn">清除</button>' +
      "</div>" +
      '<p class="shell-panel-tip">将应用到首页、图库、视频库、后台及其他所有可见页面。</p>' +
      "</section>" +

      '<section class="shell-panel-section">' +
      '<div class="shell-panel-section-title">登录页背景图</div>' +
      '<div class="shell-segmented">' +
      '<label class="shell-segment"><input type="radio" name="uiLoginMode" value="follow-global" ' +
      checked(snapshot.loginBackgroundMode !== "custom") + "><span>与全站一致</span></label>" +
      '<label class="shell-segment"><input type="radio" name="uiLoginMode" value="custom" ' +
      checked(snapshot.loginBackgroundMode === "custom") + "><span>仅登录页单独设置</span></label>" +
      "</div>" +
      '<div id="uiLoginCustomRow" class="shell-panel-inline">' +
      '<input id="uiLoginBgUrl" class="shell-panel-input" type="text" value="' +
      escapeHtml(snapshot.loginBackgroundUrl) + '" placeholder="登录页背景图链接">' +
      '<button type="button" id="uiUploadLoginBtn" class="shell-panel-btn">上传图片</button>' +
      '<input id="uiUploadLoginInput" type="file" accept="image/*" class="shell-hidden-input">' +
      '<button type="button" id="uiClearLoginBg" class="shell-panel-btn">清除</button>' +
      "</div>" +
      "</section>" +

      '<section class="shell-panel-section">' +
      '<div class="shell-panel-section-title">界面透明度</div>' +
      rangeHtml("uiCardOpacity", "卡片透明度", snapshot.cardOpacity, 0, 100, "%") +
      rangeHtml("uiCardBlur", "模糊强度", snapshot.cardBlur, 0, 32, "px") +
      "</section>" +

      '<section class="shell-panel-section">' +
      '<div class="shell-panel-section-title">动态背景特效</div>' +
      '<div class="shell-segmented">' +
      '<label class="shell-segment"><input type="radio" name="uiEffectStyle" value="none" ' +
      checked(snapshot.effectStyle !== "texture") + "><span>无特效</span></label>" +
      '<label class="shell-segment"><input type="radio" name="uiEffectStyle" value="texture" ' +
      checked(snapshot.effectStyle === "texture") + "><span>纸纹叠加</span></label>" +
      "</div>" +
      rangeHtml("uiEffectIntensity", "特效强度", snapshot.effectIntensity, 0, 100, "%") +
      '<label class="shell-panel-check">' +
      '<input id="uiOptimizeMobile" type="checkbox" ' + checked(snapshot.optimizeMobile !== false) + ">" +
      "<span>移动端自动优化特效性能</span></label>" +
      '<p class="shell-panel-tip">移动端会自动降低特效密度，减少 CPU 占用。</p>' +
      "</section>" +

      '<div class="shell-panel-foot">' +
      '<button type="button" id="uiResetDefaults" class="shell-panel-btn">恢复默认</button>' +
      '<span id="uiSaveStatus" class="shell-panel-status"></span>' +
      '<span class="shell-panel-spacer"></span>' +
      '<button type="button" id="uiCancelDesign" class="shell-panel-btn">取消</button>' +
      '<button type="button" id="uiSaveDesign" class="shell-panel-btn is-primary">保存设置</button>' +
      "</div>"
    );
  }

  function rangeHtml(id, label, value, min, max, unit) {
    return (
      '<div class="shell-panel-range">' +
      '<div class="shell-panel-range-head"><span>' + escapeHtml(label) + "</span>" +
      '<span class="shell-panel-value" data-for="' + id + '"></span></div>' +
      '<input id="' + id + '" class="shell-panel-slider" type="range" min="' + min +
      '" max="' + max + '" value="' + clamp(value, min, max) + '">' +
      "</div>"
    );
  }

  /**
   * 直接读接口的兜底实现。
   *
   * 正常路径走 manager.syncFromServer / saveToServer（theme-effects.js）。
   * 这两条是为 UIDesignManager 单独存在时准备的：manager 在 script 上是
   * defer 加载的，而面板是用户点出来的，那一刻一般已经就绪；但脚本被
   * CSP / 缓存挡住时按钮不能变成死的那一个。
   */
  function requestUiConfig(method, config) {
    var init = { method: method, credentials: "include", headers: { Accept: "application/json" } };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ config: config });
    }
    return fetch(
      method === "GET" ? "/api/ui-config?_ts=" + Date.now() : "/api/ui-config",
      init
    ).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        if (!res.ok || payload.success === false) {
          var detail = (payload.error && payload.error.message) || payload.error || "请求失败 (" + res.status + ")";
          throw new Error(detail);
        }
        return payload;
      });
    });
  }

  function openDesignPanel(anchor) {
    var manager = window.UIDesignManager;
    if (!manager || typeof manager.getSettings !== "function") {
      toast("当前版本暂不支持前端 UI 设置。", "error");
      return;
    }

    var node = showPanel(anchor, "shell-design-panel", '<p class="shell-panel-loading">正在读取当前设置…</p>');
    if (!node) return;

    var defaults = typeof manager.getDefaults === "function" ? manager.getDefaults() : manager.getSettings();
    var cancelled = false;

    // 保存失败要能把预览退回去，所以整个生命周期只认这一个 Promise。
    var settle = function () {
      cancelled = true;
      if (typeof manager.restorePersisted === "function") manager.restorePersisted();
    };
    window.addEventListener("pagehide", settle, { once: true });

    function render() {
      var snapshot = manager.getSettings();
      node.innerHTML = designFormHtml(snapshot, defaults);
      node.style.maxHeight = ""; // 内容换行后高度变了，重新量一遍再定位
      icons(node);
      position(node, anchor);
      wire();
    }

    function setStatus(state, text) {
      var el = node.querySelector("#uiSaveStatus");
      if (!el) return;
      el.setAttribute("data-state", state || "");
      el.textContent = text || "";
    }

    function updateLabels() {
      [["uiCardOpacity", "%", 0, 100], ["uiCardBlur", "px", 0, 32], ["uiEffectIntensity", "%", 0, 100]]
        .forEach(function (row) {
          var label = node.querySelector('[data-for="' + row[0] + '"]');
          if (label) {
            label.textContent =
              Math.round(clamp(node.querySelector("#" + row[0])?.value, row[2], row[3])) + row[1];
          }
        });
    }

    function checkedValue(name, fallback) {
      var hit = node.querySelector('input[name="' + name + '"]:checked');
      return hit ? hit.value : fallback;
    }

    function readValues() {
      var value = function (id) {
        var el = node.querySelector("#" + id);
        return el ? el.value : "";
      };
      return {
        baseColor: defaults.baseColor,
        globalBackgroundUrl: value("uiGlobalBgUrl").trim(),
        loginBackgroundMode: checkedValue("uiLoginMode", "follow-global"),
        loginBackgroundUrl: value("uiLoginBgUrl").trim(),
        cardOpacity: clamp(value("uiCardOpacity"), 0, 100),
        cardBlur: clamp(value("uiCardBlur"), 0, 32),
        effectStyle: checkedValue("uiEffectStyle", "none"),
        effectIntensity: clamp(value("uiEffectIntensity"), 0, 100),
        optimizeMobile: Boolean(node.querySelector("#uiOptimizeMobile")?.checked),
      };
    }

    function toggleLoginRow() {
      var row = node.querySelector("#uiLoginCustomRow");
      if (row) row.classList.toggle("is-disabled", checkedValue("uiLoginMode", "follow-global") !== "custom");
    }

    function applyPreview() {
      updateLabels();
      toggleLoginRow();
      var values = readValues();
      if (typeof manager.previewSettings === "function") manager.previewSettings(values);
      else if (typeof manager.setSettings === "function") manager.setSettings(values, { persist: false, silent: true });
      setStatus("", "预览中：仅本地生效，保存后全站同步。");
    }

    function applyValuesToForm(values) {
      var state = Object.assign({}, defaults, values || {});
      var setValue = function (id, v) {
        var el = node.querySelector("#" + id);
        if (el) el.value = v;
      };
      setValue("uiGlobalBgUrl", state.globalBackgroundUrl || "");
      setValue("uiLoginBgUrl", state.loginBackgroundUrl || "");
      setValue("uiCardOpacity", clamp(state.cardOpacity, 0, 100));
      setValue("uiCardBlur", clamp(state.cardBlur, 0, 32));
      setValue("uiEffectIntensity", clamp(state.effectIntensity, 0, 100));
      var mobile = node.querySelector("#uiOptimizeMobile");
      if (mobile) mobile.checked = state.optimizeMobile !== false;
      var checkRadio = function (name, value) {
        var radio = node.querySelector('input[name="' + name + '"][value="' + value + '"]');
        if (radio) radio.checked = true;
      };
      checkRadio("uiLoginMode", state.loginBackgroundMode === "custom" ? "custom" : "follow-global");
      // 旧配置里存过的 math / particle 两档已经被删掉，必须显式归到「无特效」，
      // 否则三个 radio 一个都没选中，面板是一片空白。
      checkRadio("uiEffectStyle", state.effectStyle === "texture" ? "texture" : "none");
    }

    function uploadBackgroundFile(file) {
      var form = new FormData();
      form.append("file", file);
      form.append("folderPath", "");
      return fetch("/upload", { method: "POST", body: form, credentials: "include" })
        .then(function (res) {
          return res.json().catch(function () { return []; }).then(function (payload) {
            if (!res.ok || !Array.isArray(payload) || !payload[0] || !payload[0].src) {
              throw new Error((payload && payload[0] && payload[0].error) || payload.error || "上传失败");
            }
            return payload[0].src;
          });
        });
    }

    function bindUpload(triggerId, inputId, targetId) {
      var trigger = node.querySelector("#" + triggerId);
      var input = node.querySelector("#" + inputId);
      if (!trigger || !input) return;
      trigger.addEventListener("click", function () { input.click(); });
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var startedAt = Date.now();
        // 没有设超时：这一台上传大背景图确实要几分钟，任何固定上限都会把
        // 合法上传掐断。改用逐秒刷新的提示，让「还在传」和「卡住了」可区分，
        // 再给一个可关闭的退出。
        var ticker = setInterval(function () {
          var seconds = Math.round((Date.now() - startedAt) / 1000);
          setStatus("", "正在上传背景图… 已等待 " + seconds + " 秒（大文件较慢，可关闭此面板）");
        }, 1000);
        uploadBackgroundFile(file)
          .then(function (src) {
            var target = node.querySelector("#" + targetId);
            if (target) target.value = src;
            applyPreview();
            toast("背景图上传成功。", "success");
          })
          .catch(function (error) {
            toast("上传失败：" + (error.message || error), "error");
          })
          .then(function () {
            clearInterval(ticker);
            input.value = "";
            if (!cancelled) setStatus("", "预览中：仅本地生效，保存后全站同步。");
          });
      });
    }

    function wire() {
      var watched = [
        "uiGlobalBgUrl", "uiLoginBgUrl", "uiCardOpacity",
        "uiCardBlur", "uiEffectIntensity", "uiOptimizeMobile",
      ];
      watched.forEach(function (id) {
        var el = node.querySelector("#" + id);
        if (!el) return;
        el.addEventListener("input", applyPreview);
        el.addEventListener("change", applyPreview);
      });
      node.querySelectorAll('input[name="uiLoginMode"], input[name="uiEffectStyle"]')
        .forEach(function (el) { el.addEventListener("change", applyPreview); });

      var clearTo = function (btnId, inputId) {
        var btn = node.querySelector("#" + btnId);
        if (!btn) return;
        btn.addEventListener("click", function () {
          var input = node.querySelector("#" + inputId);
          if (input) input.value = "";
          applyPreview();
        });
      };
      clearTo("uiClearGlobalBg", "uiGlobalBgUrl");
      clearTo("uiClearLoginBg", "uiLoginBgUrl");

      var reset = node.querySelector("#uiResetDefaults");
      if (reset) {
        reset.addEventListener("click", function () {
          applyValuesToForm(defaults);
          applyPreview();
          setStatus("", "已恢复默认预览，点击保存后全站生效。");
        });
      }

      bindUpload("uiUploadGlobalBtn", "uiUploadGlobalInput", "uiGlobalBgUrl");
      bindUpload("uiUploadLoginBtn", "uiUploadLoginInput", "uiLoginBgUrl");

      node.querySelector("#uiCancelDesign").addEventListener("click", function () {
        settle();
        closePanel();
      });

      var save = node.querySelector("#uiSaveDesign");
      save.addEventListener("click", function () {
        var values = readValues();
        save.disabled = true;
        save.textContent = "保存中…";
        setStatus("saving", "保存中…");

        var request = typeof manager.saveToServer === "function"
          ? manager.saveToServer(values)
          : requestUiConfig("POST", values).then(function (payload) {
              var config = payload.config || payload.settings || values;
              return requestUiConfig("GET").then(function (verify) {
                var verified = verify.config || verify.settings || {};
                if (JSON.stringify(verified) !== JSON.stringify(config)) {
                  throw new Error("保存后回读校验失败，请检查 KV 绑定与 Functions 日志。");
                }
                manager.setSettings(verified, { persist: true, silent: true });
                return { success: true, settings: verified, binding: verify.binding || payload.binding || "" };
              });
            }).catch(function (error) {
              manager.setSettings(values, { persist: true, silent: true });
              return { success: false, settings: values, error: error.message };
            });

        request
          .then(function (result) {
            save.disabled = false;
            if (result && result.success) {
              var binding = result.binding ? "（KV: " + result.binding + "）" : "";
              save.textContent = "已保存";
              setStatus("success", "已保存并同步到服务端" + binding + "。");
              toast("前端 UI 设置已保存并同步" + binding, "success");
            } else {
              save.textContent = "已本地保存";
              setStatus("warning", "服务端不可用，已保存到本地缓存。");
              toast(result && result.error ? "已本地保存，服务端同步失败：" + result.error : "已本地保存，服务端同步失败。", "warning");
            }
            window.setTimeout(function () { closePanel(); }, 600);
          })
          .catch(function (error) {
            save.disabled = false;
            save.textContent = "保存设置";
            setStatus("warning", "保存失败，请重试。");
            toast("保存失败：" + (error.message || error), "error");
          });
      });

      applyValuesToForm(manager.getSettings());
      updateLabels();
      toggleLoginRow();
      applyPreview();
    }

    var sync = typeof manager.syncFromServer === "function"
      ? manager.syncFromServer({ silent: true, applyLocalOnFailure: true })
      : requestUiConfig("GET")
          .then(function (payload) {
            var config = payload.config || payload.settings || {};
            manager.setSettings(config, { persist: true, silent: true });
            return { success: true };
          })
          .catch(function (error) { return { success: false, error: error.message }; });

    sync
      .then(function (result) {
        if (result && result.success === false && result.error) {
          toast("读取服务端配置失败，已使用本地缓存：" + result.error, "warning");
        }
      })
      .catch(function () {})
      .then(function () {
        if (cancelled || !openPanel || openPanel.node !== node) return;
        render();
      });
  }

  // ---------- 接线 ----------

  /**
   * 接上退出按钮。
   *
   * 外壳只写 <button data-shell-logout>，标记在四个分区页逐字相同；各页
   * 留在 localStorage 里的东西不一样，由页面自己通过 setLogoutKeys 注册：
   * 文件页有目录列表缓存（按登录身份存），上传页有记住的存储目的地，
   * 而图库 / 视频页留下的只是视图模式——那属于偏好，跟着账号走是想要的，
   * 不该被一次退出顺手抹掉。
   */
  var logoutKeys = [];
  var beforeLogout = null;

  function setLogoutKeys(keys) {
    logoutKeys = Array.isArray(keys) ? keys.slice() : [];
  }

  function setBeforeLogout(fn) {
    beforeLogout = typeof fn === "function" ? fn : null;
  }

  function bindLogout(button) {
    if (button.dataset.shellBound === "1") return;
    button.dataset.shellBound = "1";
    button.addEventListener("click", function () {
      if (window.KVShared && typeof window.KVShared.logout === "function") {
        window.KVShared.logout({
          loginPath: "./login.html",
          message: "已退出登录",
          clearKeys: logoutKeys,
          onBeforeLogout: beforeLogout,
        });
      }
    });
  }

  function bindTrigger(button) {
    if (button.dataset.shellBound === "1") return;
    button.dataset.shellBound = "1";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", function () {
      var kind = button.dataset.shellTool;
      if (kind === "connection") openConnectionPanel(button);
      else if (kind === "design") openDesignPanel(button);
    });
  }

  function init() {
    document.querySelectorAll("[data-shell-tool]").forEach(bindTrigger);
    document.querySelectorAll("[data-shell-logout]").forEach(bindLogout);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.KVShellTools = {
    init: init,
    closePanel: closePanel,
    openConnectionPanel: openConnectionPanel,
    openDesignPanel: openDesignPanel,
    setLogoutKeys: setLogoutKeys,
    setBeforeLogout: setBeforeLogout,
    ICONS: ICONS,
  };
})();