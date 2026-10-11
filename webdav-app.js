/** WebDAV 上传中心脚本（自 webdav.html 内联脚本拆出；含顶栏退出接线）。 */
      (function () {
        "use strict";

        var statusPill = document.getElementById("statusPill");
        var statusText = document.getElementById("statusText");
        var statusDetailText = document.getElementById("statusDetailText");
        var folderPathPreview = document.getElementById("folderPathPreview");
        var folderPathInput = document.getElementById("folderPathInput");
        var filePickerBox = document.getElementById("filePickerBox");
        var chooseFileBtn = document.getElementById("chooseFileBtn");
        var filePickerTitle = document.getElementById("filePickerTitle");
        var filePickerHint = document.getElementById("filePickerHint");
        var fileCountBadge = document.getElementById("fileCountBadge");
        var fileQueueWrap = document.getElementById("fileQueueWrap");
        var fileQueueList = document.getElementById("fileQueueList");
        var clearQueueBtn = document.getElementById("clearQueueBtn");
        var fileInput = document.getElementById("fileInput");
        var uploadFilesBtn = document.getElementById("uploadFilesBtn");
        var urlInput = document.getElementById("urlInput");
        var uploadUrlBtn = document.getElementById("uploadUrlBtn");
        var resultList = document.getElementById("resultList");
        var resultEmpty = document.getElementById("resultEmpty");
        var resultCount = document.getElementById("resultCount");
        var refreshStatusBtn = document.getElementById("refreshStatusBtn");
        var clearResultBtn = document.getElementById("clearResultBtn");
        var copyAllBtn = document.getElementById("copyAllBtn");
        var logoutBtn = document.getElementById("logoutBtn");
        var resultLinks = [];
        var fallbackSelectedFiles = [];

        function normalizeFolderPath(value) {
          // 收口到 kv-shared：分段清洗（去空白/./..）比正则去首尾斜杠更严，
          // 顺带折叠路径中的重复斜杠。
          return KVShared.normalizeFolderPath(value);
        }

        function updateFolderPreview() {
          var folderPath = normalizeFolderPath(folderPathInput.value);
          folderPathPreview.textContent = "当前目录：" + (folderPath || "根目录");
          try {
            localStorage.setItem("webdavFolderPath", folderPath);
          } catch {
            // ignore
          }
        }

        function ensureArray(value) {
          if (Array.isArray(value)) return value;
          if (value == null) return [];
          if (typeof value.length === "number") return Array.prototype.slice.call(value);
          return [value];
        }

        function formatFileSize(bytes) {
          return KVShared.formatSize(bytes, { decimals: 1, largeInteger: true });
        }

        function resolveFileIconClass(file) {
          var name = String((file && file.name) || "").toLowerCase();
          var mime = String((file && file.type) || "").toLowerCase();
          if (mime.startsWith("image/")) return "image";
          if (mime.startsWith("video/")) return "film";
          if (mime.startsWith("audio/")) return "music";
          if (mime.includes("zip") || mime.includes("rar") || mime.includes("7z") || /\.zip$|\.rar$|\.7z$|\.tar$|\.gz$/i.test(name)) return "file-archive";
          if (mime.includes("pdf") || /\.pdf$/i.test(name)) return "file-text";
          if (mime.includes("word") || /\.docx?$|\.odt$/i.test(name)) return "file-text";
          if (mime.includes("excel") || /\.xlsx?$|\.csv$/i.test(name)) return "file-spreadsheet";
          if (mime.includes("text") || /\.txt$|\.md$/i.test(name)) return "file-text";
          return "file";
        }

        function renderFileQueue(files) {
          var list = ensureArray(files);
          if (!list.length) {
            fileQueueWrap.style.display = "none";
            fileQueueList.innerHTML = "";
            return;
          }
          fileQueueWrap.style.display = "block";
          fileQueueList.innerHTML = "";
          var maxVisible = 6;
          list.slice(0, maxVisible).forEach(function (file) {
            var item = document.createElement("li");
            item.className = "file-queue-item";
            var icon = document.createElement("span");
            icon.className = "file-queue-icon";
            var iconNode = document.createElement("i");
            // 必须用 data-lucide 标记：icons.js 只转换 [data-lucide] 元素，
            // 把图标名写进 class 的话 <i> 里什么都不会渲染出来。
            iconNode.setAttribute("data-lucide", resolveFileIconClass(file));
            icon.appendChild(iconNode);
            var meta = document.createElement("div");
            meta.className = "file-queue-meta";
            var name = document.createElement("div");
            name.className = "file-queue-name";
            name.textContent = String(file.name || "未命名文件");
            var size = document.createElement("div");
            size.className = "file-queue-size";
            size.textContent = formatFileSize(file.size || 0);
            meta.appendChild(name);
            meta.appendChild(size);
            item.appendChild(icon);
            item.appendChild(meta);
            fileQueueList.appendChild(item);
          });

          if (list.length > maxVisible) {
            var more = document.createElement("li");
            more.className = "file-queue-more";
            more.textContent = "还有 " + (list.length - maxVisible) + " 个文件未展开";
            fileQueueList.appendChild(more);
          }

          if (window.KVIcons) window.KVIcons.render(fileQueueList);
        }

        function getSelectedFiles() {
          var chosen = ensureArray(fileInput.files);
          if (chosen.length) return chosen;
          return ensureArray(fallbackSelectedFiles);
        }

        function updateFilePickerState(files) {
          var picked = ensureArray(files);
          var count = picked.length;
          if (!count) {
            filePickerBox.classList.remove("has-files");
            filePickerTitle.textContent = "未选择任何文件";
            filePickerHint.textContent = "支持多选、拖拽到此区域，上传后自动记录直链";
            fileCountBadge.textContent = "0 个";
            renderFileQueue([]);
            return;
          }

          var totalBytes = picked.reduce(function (sum, file) {
            return sum + Number((file && file.size) || 0);
          }, 0);
          var firstName = (picked[0] && picked[0].name) ? picked[0].name : "文件";
          filePickerBox.classList.add("has-files");
          fileCountBadge.textContent = count + " 个";
          if (count === 1) {
            filePickerTitle.textContent = firstName;
            filePickerHint.textContent = "大小：" + formatFileSize(totalBytes) + "，点击“开始上传”继续";
            renderFileQueue(picked);
            return;
          }
          filePickerTitle.textContent = "已选择 " + count + " 个文件";
          filePickerHint.textContent = "总大小：" + formatFileSize(totalBytes) + "，首个文件：" + firstName;
          renderFileQueue(picked);
        }

        function syncFilesFromDrop(files) {
          var dropped = ensureArray(files).filter(Boolean);
          if (!dropped.length) return;
          fallbackSelectedFiles = dropped;
          try {
            if (typeof DataTransfer !== "undefined") {
              var dt = new DataTransfer();
              dropped.forEach(function (file) {
                dt.items.add(file);
              });
              fileInput.files = dt.files;
              fallbackSelectedFiles = [];
            }
          } catch {
            // keep fallbackSelectedFiles for browsers that block assignment
          }
          updateFilePickerState(getSelectedFiles());
        }

        function clearSelectedFiles() {
          fileInput.value = "";
          fallbackSelectedFiles = [];
          updateFilePickerState([]);
        }

        function toAbsoluteUrl(value) {
          var raw = String(value || "").trim();
          if (!raw) return "";
          try {
            return new URL(raw, window.location.origin).toString();
          } catch {
            return raw;
          }
        }

        function renderResultState() {
          resultCount.textContent = resultList.children.length + " 条";
          resultEmpty.style.display = resultList.children.length > 0 ? "none" : "block";
        }

        function pushResult(message, kind, link) {
          var item = document.createElement("li");
          item.className = "result-item";

          var title = document.createElement("div");
          title.className = "result-title";
          title.textContent = message;

          var meta = document.createElement("div");
          meta.className = "result-meta";
          meta.textContent = new Date().toLocaleString("zh-CN", { hour12: false }) + " · " + (normalizeFolderPath(folderPathInput.value) || "根目录");

          item.appendChild(title);
          item.appendChild(meta);

          if (kind === "error") {
            title.classList.add("error");
          }

          if (link) {
            var absoluteLink = toAbsoluteUrl(link);
            var anchor = document.createElement("a");
            anchor.href = absoluteLink;
            anchor.target = "_blank";
            anchor.rel = "noopener";
            anchor.textContent = absoluteLink;
            item.appendChild(anchor);
            resultLinks.unshift(absoluteLink);
          }

          resultList.prepend(item);
          if (resultList.children.length > 120) {
            resultList.removeChild(resultList.lastChild);
          }
          if (resultLinks.length > 120) {
            resultLinks = resultLinks.slice(0, 120);
          }
          renderResultState();
        }

        async function request(url, options) {
          var response = await fetch(url, Object.assign({ credentials: "include" }, options || {}));
          var data = await response.json().catch(function () {
            return null;
          });

          if (!response.ok) {
            var message = data && (data.error || data.message || data.errorDetail);
            if (!message) {
              message = "请求失败（" + response.status + "）";
            }
            throw new Error(message);
          }
          return data;
        }

        function setStatus(message, ok) {
          statusPill.classList.remove("ok", "bad");
          if (ok === true) statusPill.classList.add("ok");
          if (ok === false) statusPill.classList.add("bad");
          statusText.textContent = message;
          statusDetailText.textContent = message;
        }

        async function checkStatus() {
          setStatus("正在检测 WebDAV 状态...", null);
          var data = await request("./api/status");
          var webdav = data.webdav || {};
          var ok = Boolean(webdav.connected && webdav.enabled);
          if (ok) {
            setStatus("WebDAV 已连接并启用，可正常上传。", true);
          } else {
            var detail = webdav.message || "未配置";
            setStatus("WebDAV 当前不可用：" + detail, false);
          }
        }

        async function uploadFiles() {
          var files = getSelectedFiles();
          if (!files.length) {
            setStatus("请先选择要上传的文件。", false);
            return;
          }

          uploadFilesBtn.disabled = true;
          try {
            var folderPath = normalizeFolderPath(folderPathInput.value);
            for (var i = 0; i < files.length; i += 1) {
              setStatus("正在上传第 " + (i + 1) + " / " + files.length + " 个文件...", null);
              var form = new FormData();
              form.append("file", files[i]);
              form.append("storageMode", "webdav");
              form.append("folderPath", folderPath);
              var payload = await request("./upload", { method: "POST", body: form });
              var first = Array.isArray(payload) ? payload[0] : payload;
              var src = first && first.src ? String(first.src) : "";
              if (src) {
                pushResult("文件上传成功", "ok", toAbsoluteUrl(src));
              } else {
                pushResult("文件上传成功，但未返回直链。", "ok");
              }
            }
            clearSelectedFiles();
            setStatus("全部文件上传完成。", true);
          } finally {
            uploadFilesBtn.disabled = false;
          }
        }

        async function uploadFromUrl() {
          var sourceUrl = String(urlInput.value || "").trim();
          if (!sourceUrl) {
            setStatus("请先输入 URL 地址。", false);
            return;
          }

          uploadUrlBtn.disabled = true;
          try {
            var folderPath = normalizeFolderPath(folderPathInput.value);
            setStatus("正在拉取远程地址并上传...", null);
            var payload = await request("./api/upload-from-url", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: sourceUrl,
                storageMode: "webdav",
                folderPath: folderPath,
              }),
            });
            var first = Array.isArray(payload) ? payload[0] : payload;
            var src = first && (first.src || first.url || (first.file && first.file.src));
            if (src) {
              pushResult("URL 上传成功", "ok", toAbsoluteUrl(String(src)));
            } else {
              pushResult("URL 上传完成。", "ok");
            }
            setStatus("URL 上传完成。", true);
          } finally {
            uploadUrlBtn.disabled = false;
          }
        }

        async function ensureAuth() {
          var auth = await request("./api/auth/check");
          if (auth.authRequired && !auth.authenticated) {
            var redirect = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = "./login.html?redirect=" + redirect;
            return false;
          }
          return true;
        }

        function onError(prefix, error) {
          var message = prefix + "：" + ((error && error.message) || "未知错误");
          pushResult(message, "error");
          setStatus(message, false);
        }

        folderPathInput.addEventListener("input", updateFolderPreview);

        // 退出登录：与其它三个分区一致。即使请求失败也放行，避免把用户困在
        // 已登出的页面上。
        if (logoutBtn) {
          logoutBtn.addEventListener("click", function () {
            fetch("./api/auth/logout", { method: "POST", credentials: "include" })
              .catch(function () { /* 忽略：下面照样跳转 */ })
              .then(function () { window.location.href = "./login.html"; });
          });
        }

        clearQueueBtn.addEventListener("click", function (event) {
          event.preventDefault();
          clearSelectedFiles();
          setStatus("已清空待上传队列。", null);
        });

        chooseFileBtn.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          fileInput.click();
        });

        filePickerBox.addEventListener("click", function (event) {
          var target = event.target;
          if (target && target.id === "chooseFileBtn") return;
          fileInput.click();
        });

        filePickerBox.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInput.click();
          }
        });

        filePickerBox.addEventListener("dragover", function (event) {
          event.preventDefault();
          filePickerBox.classList.add("is-dragover");
        });

        filePickerBox.addEventListener("dragenter", function (event) {
          event.preventDefault();
          filePickerBox.classList.add("is-dragover");
        });

        filePickerBox.addEventListener("dragleave", function (event) {
          var next = event.relatedTarget;
          if (next && filePickerBox.contains(next)) return;
          filePickerBox.classList.remove("is-dragover");
        });

        filePickerBox.addEventListener("drop", function (event) {
          event.preventDefault();
          filePickerBox.classList.remove("is-dragover");
          var dropped = event.dataTransfer ? ensureArray(event.dataTransfer.files) : [];
          if (!dropped.length) return;
          syncFilesFromDrop(dropped);
          setStatus("已拖入 " + dropped.length + " 个文件，点击“开始上传”即可。", null);
        });

        fileInput.addEventListener("change", function () {
          fallbackSelectedFiles = [];
          var files = getSelectedFiles();
          updateFilePickerState(files);
          if (!files.length) {
            setStatus("请选择要上传的文件。", null);
            return;
          }
          setStatus("已选择 " + files.length + " 个文件，点击“开始上传”即可。", null);
        });

        refreshStatusBtn.addEventListener("click", function () {
          checkStatus().catch(function (error) {
            setStatus(error.message || "状态检测失败。", false);
          });
        });

        uploadFilesBtn.addEventListener("click", function () {
          uploadFiles().catch(function (error) {
            onError("文件上传失败", error);
          });
        });

        uploadUrlBtn.addEventListener("click", function () {
          uploadFromUrl().catch(function (error) {
            onError("URL 上传失败", error);
          });
        });

        urlInput.addEventListener("keydown", function (event) {
          if (event.key === "Enter") {
            event.preventDefault();
            uploadUrlBtn.click();
          }
        });

        clearResultBtn.addEventListener("click", function () {
          resultList.innerHTML = "";
          resultLinks = [];
          renderResultState();
          setStatus("已清空上传记录。", null);
        });

        copyAllBtn.addEventListener("click", function () {
          var links = resultLinks.filter(Boolean);
          if (!links.length) {
            setStatus("当前没有可复制的链接。", false);
            return;
          }
          var text = links.join("\n");
          // KVShared.copyToClipboard 永不 reject，resolve 值表示最终是否复制成功
          KVShared.copyToClipboard(text).then(function (copied) {
            setStatus(copied ? ("已复制 " + links.length + " 条链接。") : "复制失败。", copied);
          });
        });

        (async function init() {
          var cachedFolderPath = "";
          try {
            cachedFolderPath = localStorage.getItem("webdavFolderPath") || "";
          } catch {
            cachedFolderPath = "";
          }
          folderPathInput.value = normalizeFolderPath(cachedFolderPath);
          updateFolderPreview();
          renderResultState();
          updateFilePickerState([]);

          var authenticated = await ensureAuth();
          if (!authenticated) return;
          await checkStatus();
        })().catch(function (error) {
          setStatus(error.message || "页面初始化失败。", false);
        });
      })();
