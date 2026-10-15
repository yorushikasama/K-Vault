/** 视频/URL 转存管线的方法集（自 upload-app.js 拆出）。只被 index.html 加载。
 *
 * 覆盖分享链接判定、服务端解析、清晰度选择、等待计时与转存提交；
 * 方法通过 this 访问页面状态（qualityPicker、clockNow 等 data 字段
 * 仍在 upload-app.js），由 upload-app.js 以 Object.assign 并入 methods。 */
(function () {
  "use strict";

  var methods = {
          // URL上传 - 通过服务器端代理获取外部URL，解决CORS限制
          // 分享链接（抖音/B站等）由服务端 yt-dlp 解析；普通直链仍走原有代理上传
          //
          // 判定必须与服务端的 isHostAllowed() 保持一致，否则会出现「服务端明明
          // 能解析，前端却按普通直链上传」——URL 上传看起来没走解析就是这个原因。
          // 服务端的规则是：
          //   1. host 命中 allowedHosts（含子域）-> 允许
          //   2. 否则若 allowUnknownHosts 为真 -> 只要不是内网地址就允许
          //   3. 否则拒绝
          // 注意第 2 条：allowUnknownHosts 为真时服务端会把 allowedHosts 返回成
          // **空数组**（表示「不限域名」），所以只做 allowedHosts.some(...) 会恒为
          // false，把抖音/B站链接全判成普通直链，解析入口等于是死的。
          //
          // 另外要排除「URL 本身就是流文件」的情况：服务端的 STREAM_PATH_RE
          // 对 .mp4/.m3u8/.mp3 这类路径不做页面嗅探，直接当流处理。这类直链走
          // /api/upload-from-url 更直接（不必先解析再转存，也少一次服务端往返）。
          // 两边边界保持一致，才不会出现「前端送去做解析、服务端却当直链」的错配。
          isMediaShareLink(rawUrl) {
            if (!this.mediaResolve.loaded || !this.mediaResolve.available) {
              return false;
            }
            let parsed;
            try {
              parsed = new URL(rawUrl);
            } catch {
              return false;
            }
            // 本身就是流文件（含 m3u8/mpd 清单）-> 走直链上传
            if (/\.(m3u8|mpd|mp4|m4a|mp3|flv|ts|webm|mkv)$/i.test(parsed.pathname)) {
              return false;
            }
            const host = parsed.hostname.toLowerCase();
            const listed = this.mediaResolve.allowedHosts.some(
              (allowed) => host === allowed || host.endsWith("." + allowed),
            );
            if (listed) return true;
            if (!this.mediaResolve.allowUnknownHosts) return false;
            // 服务端在 allowUnknownHosts 下只拒绝内网地址。这里刻意**不做**
            // 完整的内网判定：那套逻辑包含 IPv6 字面量、十进制/八进制/十六进制
            // 伪装等分支，前端复刻一遍必然漏，而漏判的后果只是把本该被服务端
            // 拒绝的地址发过去、拿回一个明确错误（openQualityPicker 会提示
            // 解析失败），不会造成安全问题——真正的拦截在服务端。
            // 前端这里只需要排除最明显的本地名字，避免把 http://localhost
            // 这类显然不是视频分享的链接送去做无谓解析。
            return !/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(host);
          },
          // 能力探测失败时保持关闭：普通 URL 上传不受影响
          async loadMediaResolveStatus() {
            // 存下这次探测的 promise：提交 URL 时要等它落地（见
            // ensureMediaResolveStatus），而 mounted 里已经发起过一次，
            // 这里不共享的话会再打一个请求。
            if (this._mediaResolveStatusPromise) return this._mediaResolveStatusPromise;
            const pending = (async () => {
              try {
                const response = await fetch(
                  `${this.baseURL}/api/resolve-url/status`,
                  { credentials: "include" },
                );
                if (response.ok) {
                  const data = await response.json();
                  this.mediaResolve.available = data.available === true;
                  this.mediaResolve.allowedHosts = Array.isArray(
                    data.allowedHosts,
                  )
                    ? data.allowedHosts
                    : [];
                  // 必须一并读回：服务端在不限域名时把 allowedHosts 返回成空数组，
                  // 只看那个字段会把所有分享链接判成普通直链。
                  this.mediaResolve.allowUnknownHosts = data.allowUnknownHosts === true;
                }
              } catch {
                this.mediaResolve.available = false;
              }
              this.mediaResolve.loaded = true;
            })();
            this._mediaResolveStatusPromise = pending;
            return pending;
          },
          // 等能力探测落地，最多 timeoutMs 毫秒。
          //
          // 为什么提交前必须等：isMediaShareLink() 的第一条判据就是
          // mediaResolve.loaded，探测没回来时它对任何链接都返回 false，
          // 分享链接于是被判成普通直链。服务端拿到的就是这个页面的 HTML。
          //
          // 2026-10-14 线上实例（tg.yorushika.cyou）：18:32:19 打开页面发起
          // 探测，探测要跑 yt-dlp --version 等子进程（服务端实测 3.3s），
          // 18:32:27 提交链接时探测还在路上 —— 库里多出一个 72KB 的
          // 7696026443508451931.html，正是抖音那支视频的网页快照。
          //
          // 超时后不等：探测真挂了也不能把输入框永远卡住，服务端那道
          // REMOTE_CONTENT_HTML 闸门会接住误判并回退到解析。
          async ensureMediaResolveStatus(timeoutMs = 6000) {
            if (this.mediaResolve.loaded) return;
            await Promise.race([
              this.loadMediaResolveStatus(),
              new Promise((resolve) => setTimeout(resolve, timeoutMs)),
            ]);
          },
          // 仅解析：拿元数据与可选清晰度，不落库
          async fetchMediaInfo(rawUrl, signal) {
            const response = await fetch(`${this.baseURL}/api/resolve-url`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: rawUrl,
                storageMode: this.storageMode,
              }),
              credentials: "include",
              // 队列路径要能真的中断请求，否则「取消」只是关掉弹窗，
              // 后端仍在解析，任务也就一直占着并发槽。
              signal,
            });

            const data = await response.json();
            if (!response.ok) {
              // 401 = 会话过期。原文案是访客策略的话术（"Guest upload
              // disabled. Please login first."），用户看不出该重新登录，
              // 只会反复重试同一件必然失败的事。
              if (response.status === 401) {
                const expired = new Error("登录状态已过期，请重新登录后再转存。");
                expired.status = 401;
                expired.unauthorized = true;
                throw expired;
              }
              throw new Error(data.errorDetail || data.error || "视频解析失败");
            }
            return data;
          },
          // 解析并入库；variant 为空时由服务端取最佳清晰度
          async submitMediaUpload(rawUrl, variant) {
            const response = await fetch(`${this.baseURL}/api/resolve-url`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: rawUrl,
                upload: true,
                storageMode: this.storageMode,
                folderPath: this.normalizeFolderPath(this.folderPath),
                formatId: variant ? variant.formatId : "",
                needsAudio: variant ? variant.needsAudio === true : false,
              }),
              credentials: "include",
            });

            const data = await response.json();
            if (!response.ok) {
              throw new Error(data.errorDetail || data.error || "视频转存失败");
            }
            return data;
          },
          // 已知体积且超过上限的档位不可选；体积未知时放行，交给服务端判定
          isVariantDisabled(variant) {
            const maxBytes = Number(this.qualityPicker.maxBytes) || 0;
            const size = Number(variant && variant.filesize) || 0;
            return Boolean(maxBytes && size && size > maxBytes);
          },
          // 打开清晰度选择；只剩一个可用档位时直接转存，省掉多余点击
          // 入参有两种形态，必须都支持，否则队列路径（runUploadTask 传 item+signal）
          // 和直连路径（uploadFromUrl 传 url）会互相把对方的参数当成另一种：
          //   openQualityPicker(url)            —— 直连，没有队列项
          //   openQualityPicker(item, signal)   —— 队列项，需要登记 task 才能取消
          // 判据是第一个参数是不是字符串。
          async openQualityPicker(rawUrl, signal) {
            const item = typeof rawUrl === "string" ? null : rawUrl;
            const url = typeof rawUrl === "string" ? rawUrl : rawUrl?.sourceUrl;
            if (!url) return;

            this.startUrlTicker();
            this.qualityPicker.visible = true;
            this.qualityPicker.loading = true;
            this.qualityPicker.title = "";
            this.qualityPicker.variants = [];
            this.qualityPicker.selected = "";
            this.qualityPicker.maxBytes = 0;
            this.qualityPicker.sourceUrl = url;
            this.qualityPicker.task = item;
            this.qualityPicker.error = "";
            if (item) item.status = "resolving";

            let info;
            try {
              info = await this.fetchMediaInfo(url, signal);
            } catch (err) {
              this.stopUrlTicker();
              this.qualityPicker.visible = false;
              this.qualityPicker.loading = false;
              // 会话过期：光弹一句 toast 不够，用户不知道下一步该做什么，
              // 只会继续重试同一件必然失败的事（实测 2026-10-15 连点 4 次
              // 全部 401）。直接把人送去登录页，登录完再回来。
              if (err && err.unauthorized) {
                this.showToast(err.message, "error");
                this.redirectToLogin();
                return;
              }
              this.showToast("解析失败：" + err.message, "error");
              return;
            }

            this.stopUrlTicker();
            // 用户关闭解析窗口后，不自动发起转存。
            if (!this.qualityPicker.visible) {
              this.qualityPicker.loading = false;
              return;
            }
            const maxBytes = Number(info.maxImportBytes) || 0;
            const variants = (info.variants || []).filter((item) => item.formatId);
            const usable = variants.filter(
              (item) => !maxBytes || !item.filesize || item.filesize <= maxBytes,
            );

            this.qualityPicker.loading = false;
            this.qualityPicker.title = info.title || "";
            this.qualityPicker.maxBytes = maxBytes;
            this.qualityPicker.variants = variants;

            if (usable.length <= 1) {
              this.qualityPicker.visible = false;
              await this.runMediaUpload(rawUrl, usable[0] || null);
              return;
            }

            this.stopUrlTicker();
            this.qualityPicker.selected = usable[0].formatId;
          },
          // 服务端没有传输进度事件；只显示实测等待时长，不推算百分比或完成时间。
          // urlStage 是 computed，只由 uploadingFiles 推导。原来这段在写
          // this.urlStage（一个根本不存在的字段），等于什么都没做：等待秒数
          // 永远停在 data() 初始化时的 clockNow，界面就一直显示「已等待 0 秒」，
          // 看上去像冻住了。正确做法是推动 clockNow，让 computed 自己重算。
          startUrlTicker() {
            this.stopUrlTicker();
            this.clockNow = Date.now();
            this.urlStageTimer = setInterval(() => {
              this.clockNow = Date.now();
            }, 1000);
          },
          stopUrlTicker() {
            if (this.urlStageTimer) {
              clearInterval(this.urlStageTimer);
              this.urlStageTimer = null;
            }
          },
          async confirmQualityAndUpload() {
            const variant = this.qualityPicker.variants.find(
              (item) => item.formatId === this.qualityPicker.selected,
            );
            const sourceUrl = this.qualityPicker.sourceUrl;
            // 解析阶段就拿好文件名：标题 + 所选档位的容器后缀。
            // 留到转存完成后再取，那时 qualityPicker 已被清空，只能退回去
            // 猜 URL 末段（YouTube 会得出 "watch"）。
            const fileName = this.buildMediaFileName(this.qualityPicker.title, variant);
            this.qualityPicker.visible = false;
            await this.runMediaUpload(sourceUrl, variant || null, fileName);
          },
          // 视频标题通常不含扩展名（服务端返回的是 "Me at the zoo"），
          // 而 isImageFile / getFileIcon / 预览判定全都依赖扩展名——
          // 没有后缀的话图标会退化成通用文件。这里补上所选档位的容器。
          buildMediaFileName(title, variant) {
            const raw = String(title || "").trim();
            if (!raw) return "";
            const ext = String((variant && variant.ext) || "").trim().replace(/^\./, "");
            if (!ext) return raw;
            // 标题里已经带了同样的后缀就不重复追加
            return raw.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? raw : `${raw}.${ext}`;
          },
          async runMediaUpload(rawUrl, variant, mediaFileName) {
            this.startUrlTicker();
            try {
              const data = await this.submitMediaUpload(rawUrl, variant);
              if (!Array.isArray(data) || !data[0]?.src) throw new Error("未返回文件路径");
              this.registerUploadedUrlFile(data[0].src, rawUrl, mediaFileName);
              this.urlToUpload = "";
            } catch (err) {
              this.showToast("转存失败：" + err.message, "error");
            }
            this.stopUrlTicker();
          },
          // 文件名优先级：解析出的视频标题 > URL 末段。
          // URL 末段是最差的选择：分享链接常常没有文件名（YouTube 的
          // /watch?v=... 会得出 "watch"，抖音短链只有一个短码），
          // 而服务端其实是按视频标题存的（实测 Me_at_the_zoo.mp4）。
          registerUploadedUrlFile(src, sourceUrl, mediaFileName) {
            const fromUrl = String(sourceUrl || "").split("/").pop().split("?")[0];
            const fileName =
              String(mediaFileName || "").trim() || fromUrl || "url_file";
            const uploadedFile = {
              name: fileName,
              fileName: fileName,
              url: `${this.baseURL}${src}`,
              path: src,
              size: 0, // URL上传无法预知大小
              selected: false,
              uploadTime: Date.now(),
            };

            this.uploadedFiles.unshift(uploadedFile);
            this.addToHistory(uploadedFile);
            this.showToast(`成功从URL上传到 ${this.storageTarget}`, "success");
          },
          async uploadPlainUrlToServer(rawUrl) {
            const response = await fetch(
              `${this.baseURL}/api/upload-from-url`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  url: rawUrl,
                  storageMode: this.storageMode,
                  folderPath: this.normalizeFolderPath(this.folderPath),
                }),
                credentials: "include",
              },
            );

            const data = await response.json();
            if (!response.ok) {
              // 401 是会话过期，不是「上传失败」。原文案是访客策略的话术
              // （"Guest upload disabled. Please login first."），用户看不出
              // 该重新登录，只会反复重试同一件必然失败的事。
              if (response.status === 401) {
                const expired = new Error("登录状态已过期，请重新登录后再上传。");
                expired.status = 401;
                expired.unauthorized = true;
                throw expired;
              }
              const error = new Error(data.errorDetail || data.error || "上传失败");
              // 错误码必须带上：REMOTE_CONTENT_HTML 是「这条链接其实是网页」
              // 的信号，uploadFromUrl 靠它改走解析。
              error.code = data.errorCode || "";
              error.status = response.status;
              throw error;
            }
            return data;
          },

          // 会话过期时把人送去登录页，登录完按 redirect 回到当前页，
          // 正在转存的那条链接不会因此丢失。带上 pathname + search，
          // 与 upload-app.js 里 auth 检查失败时的跳转保持一致。
          redirectToLogin() {
            const back =
              window.location.pathname + window.location.search;
            window.location.href =
              "/login.html?redirect=" + encodeURIComponent(back);
          },
          // 抖音等平台的"复制链接"给的是整段分享文案，形如
          //   "0.71 复制打开抖音，看看【…】… https://v.douyin.com/xxxx/ 12/12 …"
          // 链接夹在中间，直接 new URL() 必然失败。这里先把链接抠出来再用。
          extractUrlFromText(text) {
            const match = String(text || "").match(
              /https?:\/\/[^\s<>"'`）)】\]]+/i,
            );
            return match ? match[0].replace(/[.,;:！。，、）)】\]]+$/, "") : "";
          },
          async uploadFromUrl() {
            if (this.authChecking || this.urlSubmitting || this.urlUploading || this.urlResolving || this.qualityPicker.visible) return;
            const pasted = String(this.urlToUpload || "").trim();
            if (!pasted) {
              this.showToast("请输入有效的URL", "error");
              return;
            }

            // 分享文案里抽出真正的链接，并回填输入框，让用户看清将要解析的是什么
            const submittedUrl = this.extractUrlFromText(pasted) || pasted;
            if (submittedUrl !== pasted) {
              this.urlToUpload = submittedUrl;
            }

            // 验证URL格式
            try {
              const url = new URL(submittedUrl);
              if (!["http:", "https:"].includes(url.protocol)) {
                this.showToast("仅支持HTTP/HTTPS协议的URL", "error");
                return;
              }
            } catch {
              this.showToast("URL格式无效", "error");
              return;
            }

            this.urlSubmitting = true;
            this.startUrlTicker();
            try {
              // 先等能力探测落地。isMediaShareLink() 的第一条判据是
              // mediaResolve.loaded，探测没回来时它对任何链接都返回 false，
              // 分享链接会被当成普通直链交给服务端 —— 服务端抓到的是平台
              // 网页。探测在页面加载时已发起，冷启动要跑 yt-dlp 子进程
              // （服务端实测 3.3s），所以这几秒的等待正是线上踩过的坑。
              await this.ensureMediaResolveStatus();

              // 分享链接：交给服务端解析，先把可选清晰度摆出来让用户定，再转存
              if (this.isMediaShareLink(submittedUrl)) {
                // 这一支已经"收下"了这个链接（解析 + 后续转存都由弹窗接手），
                // 所以立即清空输入框。此前这里直接 return，输入框里一直留着
                // 那条分享文案 —— 用户看到的就是"转存了但 URL 还在"。
                this.urlToUpload = "";
                // 自己的 try：解析失败是解析的事，别落到下面直链那句
                // 「URL上传失败」的文案里（openQualityPicker 内部已提示过
                // 解析失败，这里只是兜住它意外抛出的情况）。
                try {
                  await this.openQualityPicker(submittedUrl);
                } catch (resolveErr) {
                  this.showToast(
                    "解析失败：" + (resolveErr.message || "无法解析该链接"),
                    "error",
                  );
                }
                return;
              }

              const data = await this.uploadPlainUrlToServer(submittedUrl);

              // 处理成功响应 - 后端返回格式与普通上传一致 [{ src: '/file/xxx' }]
              if (!Array.isArray(data) || !data[0]?.src) throw new Error("未返回文件路径");
              this.registerUploadedUrlFile(data[0].src, submittedUrl);

              this.urlToUpload = "";
            } catch (err) {
              // 服务端发现这个地址返回的是网页（分享链接的典型表现）——
              // 那条链接其实需要解析，改走解析流程，别把网页存成文件。
              // 2026-10-14 线上就是这么多出一个 7696026443508451931.html。
              if (err && err.code === "REMOTE_CONTENT_HTML") {
                this.urlToUpload = "";
                try {
                  await this.openQualityPicker(submittedUrl);
                } catch (resolveErr) {
                  this.showToast(
                    "解析失败：" + (resolveErr.message || "无法解析该链接"),
                    "error",
                  );
                }
                return;
              }
              // 失败时保留输入框内容：用户多半要重试，清掉等于逼他重新粘贴。
              this.showToast("URL上传失败：" + err.message, "error");
            } finally {
              this.urlSubmitting = false;
              this.stopUrlTicker();
            }
          },
  };

  window.KVUploadMedia = { methods: methods };
})();
