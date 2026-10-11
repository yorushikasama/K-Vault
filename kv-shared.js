/**
 * 全站共享的工具与 UI 组件（无构建步骤，直接 <script> 引入）。
 *
 * 收拢的是「在多个页面逐字或近似重复」的逻辑：剪贴板、文件大小格式化、
 * 下载、HTML 转义、目录路径规范化、登录守卫、预览目标判定、toast 通知、
 * 存储后端命名。每个函数的语义以原页面实现为准，分歧点通过参数表达
 * （如 formatSize 的小数位），不让任何页面为收口改变可见行为。
 *
 * 暴露 window.KVShared。不依赖 Vue / Element；toast 渲染图标时会用到
 * window.KVIcons（存在才调用，缺失时只少图标不报错）。
 */
(function () {
  "use strict";

  // ---------- 文本 ----------

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- 数值 ----------

  /**
   * 字节数 → 可读大小。bytes 一律取整（"512 B"），KB 起按 decimals 展示。
   * opts.trim 去掉尾随零（admin 列表用 "1.5 MB"）；
   * opts.largeInteger 让 ≥100 的值回到整数（webdav 队列用 "150 KB"）。
   */
  function formatSize(bytes, opts) {
    var options = opts || {};
    var decimals = options.decimals === undefined ? 2 : options.decimals;
    var value = Number(bytes) || 0;
    if (!isFinite(value) || value <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    var text = unit === 0 ? String(Math.round(value)) : value.toFixed(decimals);
    if (options.largeInteger && value >= 100) text = String(Math.round(value));
    if (options.trim) text = String(parseFloat(text));
    return text + " " + units[unit];
  }

  // ---------- 剪贴板 / 下载 ----------

  /**
   * 复制文本。优先 Clipboard API，失败回退隐藏 textarea。
   * 永不 reject：resolve(true/false) 表示 execCommand 是否成功，
   * 调用方需要区分成败时（如 webdav 的状态提示）读返回值。
   */
  function copyToClipboard(text) {
    var value = String(text == null ? "" : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(
        function () { return true; },
        function () { return execCommandCopy(value); }
      );
    }
    return Promise.resolve(execCommandCopy(value));
  }

  function execCommandCopy(value) {
    var textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(textarea);
    return ok;
  }

  /** 触发浏览器下载；页面里的几十处 <a download> 点击都是这一个形状。 */
  function downloadFile(url, filename) {
    var link = document.createElement("a");
    link.href = url;
    if (filename) link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // ---------- 链接格式化 ----------

  /**
   * 直链 → 各种论坛/编辑器格式。upload、gallery 与 admin 的快捷复制
   * 原本各有一份 switch，这里统一；ubb 只有上传页的格式选择器暴露。
   */
  function formatLink(url, name, format) {
    switch (format) {
      case "markdown": return `![${name}](${url})`;
      case "html": return `<img src="${url}" alt="${name}">`;
      case "bbcode": return `[img]${url}[/img]`;
      case "ubb": return `[IMG]${url}[/IMG]`;
      default: return url;
    }
  }

  // ---------- 文件类型图标 ----------

  /**
   * 扩展名 → 图标名（Lucide kebab-case，品牌图标为 `fab fa-*`）。
   * 收拢自 upload / admin / admin-imgtc 三份各自漂移的映射表，以 admin 的
   * 最全版本为准。若新增扩展名，改这里一处即可全站生效。
   */
  var FILE_ICON_ENTRIES = Object.entries({
    "pdf": "file-text",
    "ofd,typ,typst": "file-text",
    "doc,dot,docx,docm,dotx,dotm,rtf,odt": "file-text",
    "xls,xlsb,xlsx,xlsm,xlt,xltx,xltm,ods,fods,numbers,csv,tsv": "file-spreadsheet",
    "ppt,pptx,pptm,ppsx,ppsm,potx,potm,odp": "presentation",
    "txt,md,markdown,log,patch,diff,bundle,bdl": "file-text",
    "zip,zipx,jar,war,ear,rar,7z,tar,tgz,gz,gzip,bz2,bzip2,tbz,tbz2,xz,txz,lzma,zst,cab": "file-archive",
    "iso,img,mds,mdf,nrg": "disc",
    "html,htm,css,js,ts,jsx,tsx,vue,php,py,java,c,cpp,h,hpp,cs,go,rs,rb,pl,sh,sql,bash,cc": "file-code",
    "json,jsonc,json5,xml,yaml,yml,toml,proto,hcl,graphql,gv": "file-code",
    "eml,msg,mbox": "mail",
    "mp4,avi,mov,wmv,flv,mkv,webm,m4v,m3u8,3gp,ts,mts,m2ts": "file-video-camera",
    "mp3,mpeg,wav,ogg,oga,flac,aac,m4a,wma,ape,opus,weba,midi,mid,aif,aiff": "audio-lines",
    "jpg,jpeg,jfif,png,apng,gif,bmp,webp,svg,ico,tif,tiff,heic,heif,avif,jxl": "file-image",
    "psd,ai,eps,cdr": "file-image",
    "ttf,otf,woff,woff2": "type",
    "sqlite,sqlite3,db,parquet,avro,wasm,webarchive": "database",
    "dwg,dxf,dwf,dwfx,xps": "compass",
    "glb,gltf,obj,stl,ply,fbx,dae,3ds,3mf,usd,usdz,kmz,step,stp,iges,igs,ifc": "box",
    "xmind,drawio,dio,excalidraw,mermaid,mmd,plantuml,puml,epub,umd,geojson,kml,gpx,shp,olb,dra,gds,oas,oasis": "network",
    "exe,msi,app,dmg,deb,rpm": "file-down",
    "apk": "fab fa-android",
  }).map(function (entry) { return [entry[0].split(","), entry[1]]; });

  function fileIconOf(filename) {
    var ext = String(filename || "").split(".").pop().toLowerCase();
    for (var i = 0; i < FILE_ICON_ENTRIES.length; i++) {
      if (FILE_ICON_ENTRIES[i][0].indexOf(ext) !== -1) return FILE_ICON_ENTRIES[i][1];
    }
    return "file";
  }

  // ---------- 路径 ----------

  /** 目录路径规范化：反斜杠转正斜杠，逐段去掉空白/./..，首尾斜杠丢弃。 */
  function normalizeFolderPath(value) {
    var raw = String(value || "").replace(/\\/g, "/").trim();
    var output = [];
    raw.split("/").forEach(function (part) {
      var piece = part.trim();
      if (!piece || piece === ".") return;
      if (piece === "..") { output.pop(); return; }
      output.push(piece);
    });
    return output.join("/");
  }

  // ---------- 登录守卫 ----------

  /**
   * 简单页面的认证守卫：未登录时带 redirect 跳登录页。
   * 返回 Promise<boolean>；接口异常时按已认证处理（页面自身随后的请求会
   * 以更具体的错误提示失败，与各页原行为一致）。
   */
  function ensureAuth(options) {
    var opts = options || {};
    var loginPath = opts.loginPath || "./login.html";
    return fetch("/api/auth/check", { credentials: "include" })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.authRequired && !data.authenticated) {
          var redirect = encodeURIComponent(
            window.location.pathname + window.location.search
          );
          window.location.href = loginPath + "?redirect=" + redirect;
          return false;
        }
        return true;
      })
      .catch(function () { return true; });
  }

  // ---------- 预览目标判定 ----------

  var PREVIEW_PAGE = "/preview.html";
  var PREVIEW_IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico"];
  var PREVIEW_VIDEO_EXTS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v"];
  var PREVIEW_AUDIO_EXTS = ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus"];
  var PREVIEW_DOC_EXTS = ["pdf", "txt", "md", "json", "xml", "csv", "docx", "xlsx", "pptx"];

  /**
   * 上传首页与图库的预览分支完全一致：图片走原生 Lightbox，
   * 音视频/文档走 preview.html 的 iframe，其余类型只能下载。
   * opts.autoplay 传 false 时 iframe 参数为 autoplay=0。
   */
  function buildPreviewTarget(fileName, fileUrl, opts) {
    var options = opts || {};
    var ext = String(fileName || "").split(".").pop().toLowerCase();
    if (PREVIEW_IMAGE_EXTS.indexOf(ext) !== -1) {
      return { type: "native-image", url: fileUrl, fileName: fileName };
    }
    var playable = PREVIEW_VIDEO_EXTS.concat(PREVIEW_AUDIO_EXTS, PREVIEW_DOC_EXTS);
    if (playable.indexOf(ext) !== -1) {
      var params = new URLSearchParams({
        url: fileUrl,
        title: fileName,
        autoplay: options.autoplay === false ? "0" : "1",
        embed: "1",
      });
      return {
        type: "iframe",
        iframeUrl: PREVIEW_PAGE + "?" + params.toString(),
        url: fileUrl,
        fileName: fileName,
      };
    }
    return { type: "download", url: fileUrl, fileName: fileName };
  }

  // ---------- 存储后端命名 ----------

  /** 文件列表用的短名（admin 表格"存储"列）。 */
  var STORAGE_LABELS = {
    telegram: "Telegram",
    r2: "R2",
    s3: "S3",
    discord: "Discord",
    huggingface: "HuggingFace",
    webdav: "WebDAV",
    github: "GitHub",
  };

  /** 面向用户的完整目标名（index 的目标切换与提示文案）。 */
  var STORAGE_TARGETS = {
    telegram: "Telegram 频道",
    r2: "R2 存储桶",
    s3: "S3 存储",
    discord: "Discord 频道",
    huggingface: "HuggingFace 仓库",
    webdav: "WebDAV 存储",
    github: "GitHub 仓库",
  };

  /** 文件键前缀 → 存储类型；无前缀视为 telegram。 */
  function storageTypeOf(name) {
    var key = String(name || "");
    if (key.startsWith("r2:")) return "r2";
    if (key.startsWith("s3:")) return "s3";
    if (key.startsWith("discord:")) return "discord";
    if (key.startsWith("hf:")) return "huggingface";
    if (key.startsWith("webdav:")) return "webdav";
    if (key.startsWith("github:")) return "github";
    return "telegram";
  }

  // ---------- Toast 通知 ----------

  var TOAST_ICONS = { success: "circle-check", error: "circle-x", info: "info" };

  /**
   * 右上角 toast，3 秒自动消失（原 index / gallery 各自的实现合并；
   * 样式在 theme.css，两页不再各带一份）。需要区分成败的调用读 resolve 值
   * 没有意义——这里恒等 fire-and-forget。
   */
  function toast(message, type) {
    var kind = TOAST_ICONS[type] ? type : "info";
    var container = document.querySelector(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    var node = document.createElement("div");
    node.className = "toast " + kind;
    node.setAttribute("role", "status");
    node.innerHTML =
      '<i data-lucide="' + TOAST_ICONS[kind] + '" aria-hidden="true"></i><span></span>';
    node.lastElementChild.textContent = String(message == null ? "" : message);
    container.appendChild(node);
    if (window.KVIcons && typeof window.KVIcons.render === "function") {
      window.KVIcons.render(node);
    }
    setTimeout(function () { node.remove(); }, 3000);
  }

  window.KVShared = {
    escapeHtml: escapeHtml,
    formatSize: formatSize,
    copyToClipboard: copyToClipboard,
    downloadFile: downloadFile,
    normalizeFolderPath: normalizeFolderPath,
    ensureAuth: ensureAuth,
    buildPreviewTarget: buildPreviewTarget,
    PREVIEW_PAGE: PREVIEW_PAGE,
    formatLink: formatLink,
    fileIconOf: fileIconOf,
    STORAGE_LABELS: STORAGE_LABELS,
    STORAGE_TARGETS: STORAGE_TARGETS,
    storageTypeOf: storageTypeOf,
    toast: toast,
  };
})();
