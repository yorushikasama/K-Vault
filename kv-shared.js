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
   * opts.largeInteger 让 ≥100 的值回到整数（上传队列用 "150 KB"）。
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
   * 调用方需要区分成败时（如上传页的状态提示）读返回值。
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

  /* 各格式按文件类型套不同外壳。
   *
   * 此前无论什么类型都套 <img>：复制一个 mp4 选 MD，粘出去是
   * ![旅行 vlog.mp4](…mp4)，Markdown 会去渲染成**一张图片**，然后裂开；
   * HTML 是 <img src="…mp4">，BBCode 是 [img]…[/img]，三个都产出坏标记。
   * 这个函数原本只给图库用（那里全是图片，碰巧成立），视频页沿用之后就
   * 露馅了 —— 同一件事在图床上是特性，扩到别的类型就成了 bug。
   *
   * 现在标签由类型决定：
   *   图片  ![](…)  / <img>              / [img]
   *   视频  [](…)   / <video controls>   / [video]
   *   音频  [](…)   / <audio controls>   / [audio]
   *   其它  [](…)   / <a>（下载链接）    / [url]
   * 音频和文档没有专属的「内联」标记可套，退回普通链接 —— 那才是真的能用的
   * 产物：一个能点开的链接，而不是一段渲染不出来的东西。 */
  var EMBED_TAGS = {
    image: {
      markdown: function (n, u) { return `![${n}](${u})`; },
      html: function (n, u) { return `<img src="${u}" alt="${n}">`; },
      bbcode: function (u) { return `[img]${u}[/img]`; },
      ubb: function (u) { return `[IMG]${u}[/IMG]`; }
    },
    video: {
      markdown: function (n, u) { return `[${n}](${u})`; },
      html: function (u) { return `<video src="${u}" controls></video>`; },
      bbcode: function (u) { return `[video]${u}[/video]`; },
      ubb: function (u) { return `[VIDEO]${u}[/VIDEO]`; }
    },
    audio: {
      markdown: function (n, u) { return `[${n}](${u})`; },
      html: function (u) { return `<audio src="${u}" controls></audio>`; },
      bbcode: function (u) { return `[audio]${u}[/audio]`; },
      ubb: function (u) { return `[AUDIO]${u}[/AUDIO]`; }
    },
    document: {
      // 文档没有「内联显示」这个概念，套 <img> 只会裂。给下载链接。
      markdown: function (n, u) { return `[${n}](${u})`; },
      html: function (n, u) { return `<a href="${u}">${n}</a>`; },
      bbcode: function (u) { return `[url]${u}[/url]`; },
      ubb: function (u) { return `[URL]${u}[/URL]`; }
    }
  };

  /** 由文件名判断该用哪套标签。
   *
   * 图片走的是**可渲染子集**而不是归类清单：RAW / PSD / tiff / heic / jxl
   * 是货真价实的图片，但 <img> 解不了码 —— 套 ![](…) 粘到任何地方都是一张
   * 裂图。给人一张裂图不如给他一个能点开的下载链接。这与图库卡片、preview
   * 页用的是同一个判断，三处口径必须一致。
   *
   * 取不到扩展名时退回 document 而不是 image：文件没扩展名的话，多半不是
   * 浏览器能画的东西，给下载链接更可能有用。
   */
  function linkEmbedKind(fileName) {
    var ext = extOf(fileName);
    if (VIDEO_EXTS.indexOf(ext) !== -1) return "video";
    if (AUDIO_EXTS.indexOf(ext) !== -1) return "audio";
    if (VIEWABLE_IMAGE_EXTS.indexOf(ext) !== -1) return "image";
    return "document";
  }

  /**
   * 直链 → 各种论坛/编辑器格式。upload、gallery、video 与 admin 的快捷
   * 复制原本各有一份 switch，这里统一；ubb 只有上传页的格式选择器暴露。
   *
   * name 决定标签里的显示文字，所以调用方必须传**文件名**而不是 key ——
   * key 是 telegram_1791733102845_n2f75p.mp4 这种内部标识，贴到论坛里没人
   * 看得懂。三个调用方都传 metadata.fileName。
   */
  function formatLink(url, name, format) {
    var kind = EMBED_TAGS[linkEmbedKind(name)];
    var fn = kind && kind[format];
    // 直链与未知格式一律返回裸链接：多套一层壳对用户没有价值，
    // 只有他明确选了某种格式时才该包。
    if (!fn) return url;
    // bbcode/ubb 的模板只需要 url；markdown/html 需要 name。
    return fn.length >= 2 ? fn(name, url) : fn(url);
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
    "mp4,avi,mov,wmv,flv,mkv,webm,m4v,m3u8,3gp,ts,mts,m2ts,ogv,f4v,rm,rmvb,vob,asf,divx,mxf": "file-video-camera",
    "mp3,mpeg,wav,ogg,oga,flac,aac,m4a,wma,ape,opus,weba,midi,mid,aif,aiff,alac,dsf,dff,amr,ac3,caf,mka": "audio-lines",
    "jpg,jpeg,jfif,pjpeg,pjp,png,apng,gif,bmp,webp,svg,ico": "file-image",
    "tif,tiff,heic,heif,heifs,avci,jxl,raw,cr2,cr3,nef,arw,dng,orf,raf,rw2,pef,srw,sr2,erf,mrw,x3f,kdc,3fr,psd,psb,ai": "file-image",
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

/* 图片扩展名的**唯一**清单（归类口径，宽）。
   *
   * 此前全站有五份互不相同的清单（preview-app / upload-app / 本文件 /
   * functions/api/manage/list / server 的 ytdlp-options），并集 18 个扩展名，
   * 而没有任何一份是完整的：avif（本站自己的壁纸就是 avif）、heic、tiff
   * 在图库那份里就不存在 —— 于是这些图片存了却永远不会出现在图库里。
   * 同一件事被抄五遍、抄出五个答案，这类 bug 就会反复长出来。
   *
   * 服务端（functions/api/manage/list.js）无法 import 本文件，那份靠
   * gallery-list-contract 测试对齐；前端这几处一律用下面的 isImageName()。
   *
   * ── 归类宽 ≠ 能渲染 ──────────────────────────────────────────────
   * 这份清单回答的是「这**是不是一张图片**」，所以必须收 RAW / PSD / AI：
   * 它们是货真价实的图片文件，只是浏览器画不出来。
   * 「能不能用 <img src> 直接显示」是另一件事，由下面的
   * VIEWABLE_IMAGE_EXTS 回答。把两个问题合成一个，是图库碎图的根源 ——
   * 曾经把 heic/jxl 混进来当"可显示图片"，结果图库里出现一批打不开的图。 */
  var IMAGE_EXTS = [
    // 浏览器可渲染
    "jpg", "jpeg", "jfif", "pjpeg", "pjp",
    "png", "apng",
    "gif", "webp", "avif",
    "bmp",
    "svg", "ico",
    // 浏览器不能（或基本不能）渲染，但确实是图片文件
    "tif", "tiff",
    "heic", "heif", "heifs", "heifs2", "avci",
    "jxl",
    "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "raf", "rw2",
    "pef", "srw", "sr2", "erf", "mrw", "x3f", "kdc", "3fr",
    "psd", "psb",
    "ai",
  ];

  /* 可渲染子集：浏览器能用 <img src="/file/xxx"> 直接显示的。
   * 图库网格、admin 的缩略图单元格、上传页的即时预览都只认这份。
   * 其余 IMAGE_EXTS 成员（RAW / PSD / tiff / heic / jxl）在图库里
   * 仍会出现，但显示为占位卡而不是碎图。 */
  var VIEWABLE_IMAGE_EXTS = [
    "jpg", "jpeg", "jfif", "pjpeg", "pjp",
    "png", "apng",
    "gif", "webp", "avif",
    "bmp",
    "svg", "ico",
  ];

  function extOf(name) {
    return String(name == null ? "" : name).split(".").pop().toLowerCase();
  }

  /** 按扩展名判定「这是不是一张图片」。取最后一段，所以 a.tar.gz 会看 gz。 */
  function isImageName(name) {
    return IMAGE_EXTS.indexOf(extOf(name)) !== -1;
  }

  /** 按扩展名判定「能不能用 <img> 直接显示」。是 isImageName 的真子集。 */
  function isViewableImage(name) {
    return VIEWABLE_IMAGE_EXTS.indexOf(extOf(name)) !== -1;
  }

  /* 预览分支沿用可渲染子集：不可渲染的格式走 preview.html 的 iframe
   * 由服务端转码，或直接落回下载，都比给用户一张碎图好。 */
  var PREVIEW_IMAGE_EXTS = VIEWABLE_IMAGE_EXTS;
  var PREVIEW_VIDEO_EXTS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v"];
  var PREVIEW_AUDIO_EXTS = ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus"];
  var PREVIEW_DOC_EXTS = ["pdf", "txt", "md", "json", "xml", "csv", "docx", "xlsx", "pptx"];

  /* 视频扩展名，与 functions/api/manage/list.js 的 VIDEO_EXTS 同一份内容
   * （那边跑在 Workers 上 import 不了本文件，一致性由测试钉住）。
   *
   * 与图片清单的差别：视频**没有**"归类宽 / 渲染窄"这个分层。
   * mkv / rmvb / vob 是货真价实的视频，但浏览器一个都放不了；
   * 而 <video> 打不开时页面会自己显示浏览器的解码失败占位，
   * 不会像 <img> 那样留一张碎图 —— 所以视频页不需要区分这两层。
   * 真要区分，也应该由播放失败回调单独处理，不该改归类口径。 */
  var VIDEO_EXTS = [
    "mp4", "webm", "ogg", "ogv", "avi", "mov", "wmv", "flv", "mkv",
    "m4v", "m3u8", "3gp", "ts", "mts", "m2ts", "f4v", "rm", "rmvb",
    "vob", "asf", "divx", "mxf",
  ];

  var AUDIO_EXTS = [
    "mp3", "mpeg", "wav", "ogg", "oga", "flac", "aac", "m4a", "wma",
    "ape", "opus", "weba", "midi", "mid", "aif", "aiff", "alac", "dsf",
    "dff", "amr", "ac3", "caf", "mka",
  ];

  function isVideoName(name) {
    return VIDEO_EXTS.indexOf(extOf(name)) !== -1;
  }

  function isAudioName(name) {
    return AUDIO_EXTS.indexOf(extOf(name)) !== -1;
  }

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
      github: "GitHub",
  };

  /** 面向用户的完整目标名（index 的目标切换与提示文案）。 */
  var STORAGE_TARGETS = {
    telegram: "Telegram 频道",
    r2: "R2 存储桶",
    s3: "S3 存储",
    discord: "Discord 频道",
    huggingface: "HuggingFace 仓库",
    github: "GitHub 仓库",
  };

  /** 文件键前缀 → 存储类型；无前缀视为 telegram。 */
  function storageTypeOf(name) {
    var key = String(name || "");
    if (key.startsWith("r2:")) return "r2";
    if (key.startsWith("s3:")) return "s3";
    if (key.startsWith("discord:")) return "discord";
    if (key.startsWith("hf:")) return "huggingface";
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
    isImageName: isImageName,
    isViewableImage: isViewableImage,
    isVideoName: isVideoName,
    isAudioName: isAudioName,
    IMAGE_EXTS: IMAGE_EXTS,
    VIEWABLE_IMAGE_EXTS: VIEWABLE_IMAGE_EXTS,
    VIDEO_EXTS: VIDEO_EXTS,
    AUDIO_EXTS: AUDIO_EXTS,
    PREVIEW_PAGE: PREVIEW_PAGE,
    formatLink: formatLink,
    fileIconOf: fileIconOf,
    STORAGE_LABELS: STORAGE_LABELS,
    STORAGE_TARGETS: STORAGE_TARGETS,
    storageTypeOf: storageTypeOf,
    toast: toast,
  };
})();
