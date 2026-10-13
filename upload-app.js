/** 上传首页的 Vue 应用（自 index.html 内联脚本拆出，逻辑保持原样）。 */
      new Vue({
        el: "#app",
        data: {
          baseURL: document.location.origin,
          theme: document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light",
          storageStatusLoading: false,
          storageStatusVerified: false,
          authStatusVerified: false,
          authRequired: null,
          guestLimitVerified: false,
          guestDailyLimitVerified: false,
          telegramAvailable: false,
          authError: "",
          authLoginRequired: false,
          storageStatusError: "",
          historySaveError: "",
          historyReadBlocked: false,
          historyConfirmOpen: false,
          clipboardReading: false,
          linkFormats: [
            { value: "url", label: "直链" },
            { value: "markdown", label: "Markdown" },
            { value: "html", label: "HTML" },
            { value: "bbcode", label: "BBCode" },
            { value: "ubb", label: "UBB" },
          ],
          isDragging: false,
          showUrlInput: false,
          urlToUpload: "",
          urlSubmitting: false,
          clockNow: Date.now(),
          urlStageTimer: null,
          // Media resolve capability, loaded from /api/resolve-url/status. The
          // allowed-host list stays server side so this UI can never disagree
          // with what the backend actually accepts.
          // allowUnknownHosts 表示服务端不限制域名（只拒绝内网地址）；此时
          // allowedHosts 会被服务端刻意返回空数组，不能拿空数组做匹配。
          mediaResolve: {
            available: false,
            allowedHosts: [],
            allowUnknownHosts: false,
            loaded: false,
          },
          // 模板里三处 @click="cancelQualityPicker" 都指向这里，但 3257348 之后
          // 一直没实现：点「取消」会抛 TypeError，弹窗关不掉——这是「卡死」的
          // 第二个来源（弹窗遮罩还在，下面整页都点不动）。
          // 语义必须与弹窗里的说明一致：只取消本项解析与选择，不开始转存。
          cancelQualityPicker() {
            const item = this.qualityPicker.task;
            // 先关界面，再中止请求：顺序反了会让 fetch 的 reject 打到
            // 一个已经看不见的任务上，catch 分支又去弹 toast。
            this.qualityPicker.visible = false;
            this.qualityPicker.loading = false;
            this.qualityPicker.error = "";
            this.qualityPicker.task = null;
            this.qualityPicker.sourceUrl = "";
            this.qualityPicker.variants = [];
            this.qualityPicker.selected = "";
            this.qualityPicker.title = "";

            if (item && this.isUploadTaskActive(item)) {
              this._taskControllers.get(item.id)?.abort();
              this.removeUploadTask(item);
            }
            if (!this.urlActivityCount) this.stopUrlTicker();
            this.startUpload();
          },

          // 分享链接的清晰度选择；variants 由服务端 yt-dlp 的格式清单按分辨率去重得到
          qualityPicker: {
            visible: false,
            loading: false,
            title: "",
            variants: [],
            selected: "",
            maxBytes: 0,
            sourceUrl: "",
            task: null,
            error: "",
          },
          pendingUploadBatch: null,
          pendingUploadBatches: [],
          pendingCompressionChoice: "original",
          pasteUploadNotice: null,
          pasteUploadNoticeTimer: null,
          globalPasteHandler: null,
          globalKeydownHandler: null,
          imageUploadDecision: "original",
          imageCompress: {
            enabled: false,
            format: "webp",
            quality: 82,
            maxDimension: 0,
            keepOriginalWhenLarger: true,
            support: {
              webp: true,
              avif: true,
              jpeg: true,
              png: true,
            },
          },
          uploadingFiles: [],
          uploadedFiles: [],
          uploadHistory: [],
          linkFormat: "url",
          previewData: null, // 新的预览数据对象
          isAuthenticated: false,
          folderPath: "",
          uploadFolders: [],
          uploadFoldersLoading: false,
          uploadFoldersFetched: false,
          showUploadFolderCreator: false,
          newUploadFolderPath: "",
          uploadFolderCreating: false,
          storageMode: "telegram", // 存储模式：telegram, r2, s3, discord, huggingface, github
          storageTarget: "Telegram 频道", // 显示文本
          r2Available: false, // R2 是否可用
          s3Available: false, // S3 是否可用
          discordAvailable: false, // Discord 是否可用
          huggingfaceAvailable: false,
          githubAvailable: false,
          authChecking: true, // 是否正在检查认证状态
          isGuest: false, // 是否为访客模式
          guestUploadConfig: null, // 访客上传配置 { maxFileSize, maxDailyUploads }
          uploadConfig: {
            maxSize: 200 * 1024 * 1024, // 200MB max, follows the server's UPLOAD_MAX_SIZE
            chunkSize: 5 * 1024 * 1024, // 5MB chunks
            smallFileThreshold: 20 * 1024 * 1024, // 20MB, below this use direct upload
            maxConcurrent: 3,
          },
          uploadLimits: {},
          storageStates: {},
        },
        created() {
          this._idSequence = 0;
          this._idPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          this._uploadRunning = new Set();
          this._taskControllers = new Map();
          this._requestControllers = new Set();
          this._objectUrls = new Set();
          this._imageCancellations = new Set();
          this._successTimers = new Map();
          this._queueTimer = null;
          this._maxConcurrent = Math.max(1, Math.floor(Number(this.uploadConfig.maxConcurrent) || 3));
          this._pumping = false;
          this._telegramRunning = false;
          this._telegramNextAt = 0;
          this._resolveGeneration = 0;
          this._dialogLocked = false;
          this._isDisposed = false;
        },
        computed: {
          selectedCount() {
            return this.uploadedFiles.filter((f) => f.selected).length;
          },
          isAllSelected() {
            return (
              this.uploadedFiles.length > 0 &&
              this.uploadedFiles.every((f) => f.selected)
            );
          },
          failedCount() {
            return this.uploadingFiles.filter((f) => f.status === "error")
              .length;
          },
          imageCompressFormats() {
            return [
              {
                value: "webp",
                label: "WebP",
                mime: "image/webp",
                ext: "webp",
                icon: "image",
                tip: "兼容性好，通常比 JPEG/PNG 更省空间",
              },
              {
                value: "avif",
                label: "AVIF",
                mime: "image/avif",
                ext: "avif",
                icon: "zap",
                tip: "压缩率更高，适合现代浏览器",
              },
              {
                value: "jpeg",
                label: "JPEG",
                mime: "image/jpeg",
                ext: "jpg",
                icon: "file-image",
                tip: "适合照片，兼容性最好",
              },
              {
                value: "png",
                label: "PNG",
                mime: "image/png",
                ext: "png",
                icon: "file-image",
                tip: "保留透明通道，体积通常较大",
              },
            ];
          },
          imageCompressSummary() {
            const format =
              this.imageCompressFormats.find(
                (item) => item.value === this.imageCompress.format,
              ) || this.imageCompressFormats[0];
            const sizeText = this.imageCompress.maxDimension
              ? `最大边长 ${this.imageCompress.maxDimension}px`
              : "保留原始尺寸";
            const modeText =
              this.imageUploadDecision === "optimized"
                ? `默认使用 ${format.label}，质量 ${this.imageCompress.quality}%，${sizeText}。`
                : this.imageUploadDecision === "ask"
                  ? this.imageCompress.enabled
                    ? `询问窗口默认使用 ${format.label}，质量 ${this.imageCompress.quality}%，${sizeText}。`
                    : "询问窗口默认选择原图上传。"
                  : "默认直接上传原始图片文件。";
            return modeText;
          },
          imageUploadDecisionSummary() {
            const messages = {
              original: "默认直接上传原始图片文件，不弹出确认窗口。",
              optimized: "上传前会按下方设置转换图片。",
              ask: "每批图片上传前先询问，并记住本次处理方式。",
            };
            return messages[this.imageUploadDecision] || messages.original;
          },
                    uploadFolderOptions() {
            return (this.uploadFolders || [])
              .map((folder) => {
                const path = this.normalizeFolderPath(
                  folder.path || folder.folderPath || "",
                );
                if (!path) return null;
                return {
                  ...folder,
                  path,
                  fileCount: Number(folder.fileCount || 0),
                };
              })
              .filter(Boolean)
              .sort((a, b) => {
                const depthA = a.path.split("/").length;
                const depthB = b.path.split("/").length;
                if (depthA !== depthB) return depthA - depthB;
                return a.path.localeCompare(b.path, "zh-CN", {
                  sensitivity: "base",
                });
              });
          },
          storageOptions() {
            const options = [
              { mode: "telegram", label: "Telegram", target: KVShared.STORAGE_TARGETS.telegram, brand: "fab fa-telegram", available: this.telegramAvailable },
              { mode: "r2", label: "R2", target: KVShared.STORAGE_TARGETS.r2, icon: "cloud", available: this.r2Available },
              { mode: "s3", label: "S3", target: KVShared.STORAGE_TARGETS.s3, icon: "database", available: this.s3Available },
              { mode: "discord", label: "Discord", target: KVShared.STORAGE_TARGETS.discord, brand: "fab fa-discord", available: this.discordAvailable },
              { mode: "huggingface", label: "HuggingFace", target: KVShared.STORAGE_TARGETS.huggingface, icon: "folder-git-2", available: this.huggingfaceAvailable },
              { mode: "github", label: "GitHub", target: KVShared.STORAGE_TARGETS.github, brand: "fab fa-github", available: this.githubAvailable },
            ];
            return this.isGuest ? options.filter((option) => ["telegram", "r2"].includes(option.mode)) : options;
          },
          canAddUploads() {
            return !this.authChecking && this.authStatusVerified && !this.authLoginRequired &&
              !this.storageStatusLoading && this.storageStatusVerified &&
              this.storageOptions.some((option) => option.mode === this.storageMode && option.available);
          },
          activeTaskCount() {
            return this.uploadingFiles.filter((file) => ["waiting", "processing", "uploading", "resolving", "choosing"].includes(file.status)).length;
          },
          urlUploading() {
            return this.uploadingFiles.some((file) => file.kind !== "file" && file.status === "uploading");
          },
          urlResolving() {
            return this.uploadingFiles.some((file) => file.status === "resolving");
          },
          urlActivityCount() {
            return this.uploadingFiles.filter((file) => file.kind !== "file" && ["uploading", "resolving"].includes(file.status)).length;
          },
          urlStage() {
            const active = this.uploadingFiles.filter((file) => file.kind !== "file" && ["uploading", "resolving"].includes(file.status));
            if (!active.length) return "";
            const startedAt = Math.min(...active.map((file) => file.startedAt || this.clockNow));
            const seconds = Math.max(0, Math.floor((this.clockNow - startedAt) / 1000));
            return `${active.length} 个远程任务等待服务端响应；最早一项已等待 ${seconds} 秒。未提供传输进度。`;
          },
          activeUploadDialog() {
            if (this.qualityPicker.visible) return "qualityDialog";
            if (this.pendingUploadBatch) return "compressionDialog";
            if (this.previewData) return "previewDialog";
            return this.historyConfirmOpen ? "historyDialog" : "";
          },
          activeDialogKey() {
            const id = this.qualityPicker.visible && this.qualityPicker.task
              ? this.qualityPicker.task.id
              : this.pendingUploadBatch ? this.pendingUploadBatch.id : "";
            return this.activeUploadDialog ? `${this.activeUploadDialog}:${id}` : "";
          },
          canConfirmQuality() {
            if (!this.qualityPicker.visible || this.qualityPicker.loading || this.qualityPicker.error) return false;
            const task = this.qualityPicker.task;
            const variant = this.qualityPicker.variants.find((item) => item.formatId === this.qualityPicker.selected);
            if (!variant || this.isVariantDisabled(variant)) return false;
            // 队列路径（task 存在）要求任务处于可确认态；直连路径
            // （用户从输入框提交分享链接）task 恒为 null——那是有意为之，
            // 这条路根本不建队列项。原条件 `!!task && ...` 把 task 当成
            // 必要条件，于是直连路径下这个按钮永远禁用：视频明明解析出了
            // 两个清晰度、弹窗也正常显示，用户却点不动「转存」，卡在弹窗里。
            // 所以只在 task 存在时才校验它的状态。
            if (!task) return true;
            return task.status === "choosing";
          },
          effectiveUploadLimit() {
            const maxBytes = this.getUploadLimit(this.storageMode).maxBytes || this.uploadConfig.maxSize;
            return this.isGuest && this.guestUploadConfig
              ? Math.min(maxBytes, this.guestUploadConfig.maxFileSize)
              : maxBytes;
          },
          hasVerifiedUploadLimit() {
            const limit = this.uploadLimits[this.storageMode];
            return !this.authChecking && !this.storageStatusLoading && this.authStatusVerified &&
              this.storageStatusVerified && !!limit && Number.isFinite(limit.maxBytes) && limit.maxBytes > 0 &&
              (!this.isGuest || this.guestLimitVerified);
          },
          currentUploadLimitLabel() {
            if (this.authChecking || this.storageStatusLoading) return "读取中";
            return this.hasVerifiedUploadLimit ? this.formatSize(this.effectiveUploadLimit) : "暂未确认";
          },
          currentUploadLimitNote() {
            if (this.authChecking || this.storageStatusLoading) return "正在读取服务端配置与访客限制，不以预设值代替实际限制。";
            if (!this.hasVerifiedUploadLimit) {
              return `未取得完整的服务端限制；前端暂按 ${this.formatSize(this.effectiveUploadLimit)} 校验，这不是已确认的服务端上限。最终以上传响应为准。`;
            }
            const limit = this.uploadLimits[this.storageMode];
            const notes = ["已读取服务端限制。"];
            if (this.isGuest) {
              notes.push(`已叠加访客单文件上限 ${this.formatSize(this.guestUploadConfig.maxFileSize)}；访客不支持分片上传。`);
            } else if (limit.supportsChunkUpload === false) {
              notes.push("当前目标不支持分片上传。");
            } else if (limit.supportsChunkUpload === true) {
              const threshold = limit.directThreshold || this.uploadConfig.smallFileThreshold;
              notes.push(`超过 ${this.formatSize(threshold)} 时使用分片${limit.directThreshold ? "" : "（前端默认阈值）"}；分片不会提高单文件上限。`);
            } else {
              notes.push("服务端未提供分片能力信息，实际以上传响应为准。");
            }
            if (typeof limit.message === "string" && limit.message) notes.push(limit.message);
            return notes.join(" ");
          },
          pendingUploadStats() {
            const files = this.pendingUploadBatch?.files || [];
            return files.reduce(
              (stats, file) => {
                stats.fileCount += 1;
                stats.totalSize += file.size || 0;
                if (this.isCompressibleImage(file)) stats.imageCount += 1;
                return stats;
              },
              { fileCount: 0, imageCount: 0, totalSize: 0 },
            );
          },
          selectedHistoryCount() {
            return this.uploadHistory.filter((f) => f.selected).length;
          },
          isAllHistorySelected() {
            return (
              this.uploadHistory.length > 0 &&
              this.uploadHistory.every((f) => f.selected)
            );
          },
          historyStats() {
            const stats = { images: 0, videos: 0, others: 0, totalSize: 0 };
            this.uploadHistory.forEach((item) => {
              const ext = item.name.split(".").pop().toLowerCase();
              if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) {
                stats.images++;
              } else if (["mp4", "webm", "avi", "mov"].includes(ext)) {
                stats.videos++;
              } else {
                stats.others++;
              }
              stats.totalSize += item.size || 0;
            });
            return stats;
          },
        },
        watch: {
          activeDialogKey(key) {
            if (key && !this._dialogLocked) {
              this._dialogLocked = true;
              this._dialogReturnFocus = document.activeElement;
              this._dialogOverflow = document.body.style.overflow;
              document.body.style.overflow = "hidden";
            }
            this.$nextTick(() => {
              if (this._isDisposed || key !== this.activeDialogKey) return;
              if (key) {
                this.focusActiveDialog();
                this.isolateUploadSurface();
              } else {
                this.restoreDialogEnvironment(true);
                this.showNextPendingUpload();
                this.startUpload();
              }
            });
          },
        },
        methods: Object.assign({}, window.KVUploadMedia.methods, window.KVUploadImage.methods, {
          nextUploadId(prefix = "task") {
            return `${prefix}-${this._idPrefix}-${++this._idSequence}`;
          },

          abortError() {
            const error = new Error("操作已取消");
            error.name = "AbortError";
            return error;
          },

          isUploadTaskActive(item) {
            return !this._isDisposed && this.uploadingFiles.includes(item);
          },

          assertUploadActive(item, signal) {
            if (this._isDisposed || signal?.aborted || (item && !this.isUploadTaskActive(item))) {
              throw this.abortError();
            }
          },

          // 控制器保留到响应体读完；非队列请求也在销毁时统一中止。
          async requestJson(url, options = {}, item = null) {
            const controller = options.signal ? null : new AbortController();
            const signal = options.signal || controller.signal;
            if (controller) this._requestControllers.add(controller);
            try {
              this.assertUploadActive(item, signal);
              const response = await fetch(url, { credentials: "include", ...options, signal });
              this.assertUploadActive(item, signal);
              let data;
              try {
                data = await response.json();
              } catch (error) {
                this.assertUploadActive(item, signal);
                const invalid = new Error(`服务端未返回有效 JSON（HTTP ${response.status}），请检查服务或代理。`);
                invalid.status = response.status;
                throw invalid;
              }
              this.assertUploadActive(item, signal);
              const result = Array.isArray(data) ? data[0] : data;
              if (!response.ok || result?.success === false || result?.error) {
                const detail = result?.errorDetail || result?.error;
                const error = new Error(typeof detail === "string" ? detail : `请求失败（HTTP ${response.status}）`);
                error.status = response.status;
                throw error;
              }
              return data;
            } finally {
              if (controller) this._requestControllers.delete(controller);
            }
          },

          ensureCanAddUploads() {
            if (this._isDisposed) return false;
            if (this.canAddUploads) return true;
            this.showToast("请先确认身份及可用存储目标，再添加文件。可重新读取服务端状态。", "error");
            return false;
          },

          createTrackedObjectURL(file) {
            if (this._isDisposed) throw this.abortError();
            const url = URL.createObjectURL(file);
            this._objectUrls.add(url);
            return url;
          },

          releaseObjectURL(url) {
            if (url && this._objectUrls.delete(url)) URL.revokeObjectURL(url);
          },

          removeUploadTask(item) {
            const timer = this._successTimers.get(item.id);
            if (timer !== undefined) clearTimeout(timer);
            this._successTimers.delete(item.id);
            this.releaseObjectURL(item.preview);
            item.preview = null;
            item.file = null;
            item.originalFile = null;
            const index = this.uploadingFiles.indexOf(item);
            if (index !== -1) this.uploadingFiles.splice(index, 1);
          },

          getDialogControls(root) {
            if (!root) return [];
            return Array.from(root.querySelectorAll(
              'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
            )).filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[inert], [hidden], [aria-hidden="true"]'));
          },

          focusActiveDialog() {
            const dialog = this.$refs[this.activeUploadDialog];
            if (!dialog) return;
            const preferred = dialog.querySelector("[data-dialog-focus]:not([disabled])");
            (preferred || this.getDialogControls(dialog)[0] || dialog).focus();
          },

          isolateUploadSurface() {
            const surface = this.$refs.uploadSurface;
            if (!surface) return;
            if (!this._surfaceState) {
              this._surfaceState = {
                node: surface,
                inert: surface.getAttribute("inert"),
                ariaHidden: surface.getAttribute("aria-hidden"),
              };
            }
            surface.setAttribute("inert", "");
            surface.setAttribute("aria-hidden", "true");
          },

          restoreDialogEnvironment(restoreFocus) {
            const state = this._surfaceState;
            if (state) {
              for (const [name, value] of [["inert", state.inert], ["aria-hidden", state.ariaHidden]]) {
                if (value === null) state.node.removeAttribute(name);
                else state.node.setAttribute(name, value);
              }
              this._surfaceState = null;
            }
            if (this._dialogLocked) document.body.style.overflow = this._dialogOverflow || "";
            this._dialogLocked = false;
            const previous = this._dialogReturnFocus;
            this._dialogReturnFocus = null;
            if (restoreFocus && !this._isDisposed) {
              const target = previous?.isConnected && !previous.disabled && !previous.closest("[inert]")
                ? previous : this.$refs.uploadMain;
              target?.focus?.();
            }
          },

          toggleUrlInput() {
            this.showUrlInput = !this.showUrlInput;
            if (this.showUrlInput) this.$nextTick(() => this.$refs.urlInput && this.$refs.urlInput.focus());
          },

          handleWorkbenchKeydown(event) {
            const name = this.activeUploadDialog;
            const dialog = this.$refs[name];
            if (!dialog) return;
            if (event.key === "Escape") {
              event.preventDefault();
              if (name === "compressionDialog") this.cancelPendingUpload();
              else this.closePreview();
              return;
            }
            if (event.key !== "Tab") return;
            const controls = Array.from(dialog.querySelectorAll(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])',
            )).filter((node) => node.getClientRects().length && !node.closest("[inert]"));
            const first = controls[0];
            const last = controls[controls.length - 1];
            const active = document.activeElement;
            if (!first) {
              event.preventDefault();
              dialog.focus();
            } else if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
              event.preventDefault();
              first.focus();
            }
          },

          bindPreviewIframeKeys() {
            try {
              const frame = this.$refs.previewIframe;
              if (frame && frame.contentDocument) {
                frame.contentDocument.addEventListener("keydown", (event) => {
                  if (event.key === "Escape") this.handleWorkbenchKeydown(event);
                });
              }
            } catch (e) { /* 跨源内容仍可通过弹窗关闭按钮退出。 */ }
          },

          getUploadTaskStatus(file) {
            if (file.status === "waiting") return "等待上传";
            if (file.status === "processing") return "浏览器内处理图片";
            if (file.status === "success") return "上传成功";
            if (file.status === "error") return "上传失败";
            if (file.uploadStage === "initializing") return "初始化分片上传";
            if (file.uploadStage === "merging") return "分片已接收，等待合并与存储";
            if (file.uploadStage === "chunks") return `服务端已接收 ${file.confirmedChunks}/${file.totalChunks} 片`;
            return "请求已发出，等待服务器响应（无传输百分比）";
          },

          async refreshUploadLimits() {
            if (this.authChecking || this.storageStatusLoading) return;
            if (!this.authStatusVerified || (this.isGuest && !this.guestLimitVerified)) {
              if (!(await this.checkAuth())) return;
            }
            await this.checkStorageTarget(false);
          },

          normalizeFolderPath(value) {
            return KVShared.normalizeFolderPath(value);
          },

          handleFolderPathInput() {
            this.folderPath = this.normalizeFolderPath(this.folderPath);
            try {
              localStorage.setItem("uploadFolderPath", this.folderPath);
            } catch (e) {}
          },

          clearFolderPath() {
            this.folderPath = "";
            try {
              localStorage.setItem("uploadFolderPath", "");
            } catch (e) {}
          },

          persistFolderPath() {
            this.folderPath = this.normalizeFolderPath(this.folderPath);
            try {
              localStorage.setItem("uploadFolderPath", this.folderPath);
            } catch (e) {}
          },

          selectUploadFolder(path) {
            this.folderPath = this.normalizeFolderPath(path);
            this.persistFolderPath();
            this.showToast(`已选择上传目录：${this.folderPath || "根目录"}`, "success");
          },

          ensureUploadFolderLocal(path, fileCount = 0) {
            const normalized = this.normalizeFolderPath(path);
            if (!normalized) return;
            const parts = normalized.split("/");
            let current = "";
            parts.forEach((part) => {
              current = current ? `${current}/${part}` : part;
              const exists = (this.uploadFolders || []).some((folder) => {
                return (
                  this.normalizeFolderPath(folder.path || folder.folderPath || "") ===
                  current
                );
              });
              if (!exists) {
                this.uploadFolders.push({
                  path: current,
                  name: part,
                  parentPath: current.includes("/")
                    ? current.split("/").slice(0, -1).join("/")
                    : "",
                  depth: current.split("/").length,
                  fileCount: current === normalized ? Number(fileCount || 0) : 0,
                });
              }
            });
          },

          normalizeUploadFolderList(folders = []) {
            const map = new Map();
            (Array.isArray(folders) ? folders : []).forEach((folder) => {
              const path = this.normalizeFolderPath(
                folder?.path || folder?.folderPath || "",
              );
              if (!path) return;
              map.set(path, {
                ...folder,
                path,
                name: folder?.name || path.split("/").pop() || path,
                fileCount: Number(folder?.fileCount || 0),
              });
            });
            return Array.from(map.values());
          },

          async fetchUploadFolders(force = false) {
            if (this.isGuest) return;
            if (this.uploadFoldersLoading) return;
            if (this.uploadFoldersFetched && !force) return;

            this.uploadFoldersLoading = true;
            let unauthorized = false;
            let lastError = "";
            try {
              const endpoints = [
                "/api/manage/folders?storage=all",
                "/api/manage/list?includeFolders=1&limit=1",
              ];
              const merged = new Map();

              for (const endpoint of endpoints) {
                const response = await fetch(endpoint, {
                  method: "GET",
                  credentials: "include",
                });
                if (response.status === 401 || response.status === 403) {
                  unauthorized = true;
                  break;
                }
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.success === false) {
                  lastError = data.error || "目录读取失败";
                  continue;
                }
                this.normalizeUploadFolderList(data.folders).forEach((folder) => {
                  merged.set(folder.path, folder);
                });
              }

              if (unauthorized) {
                this.uploadFoldersFetched = false;
                if (force) {
                  this.showToast("需要先登录管理后台后才能读取已有目录", "error");
                }
                return;
              }

              if (merged.size === 0 && lastError) {
                throw new Error(lastError);
              }

              this.uploadFolders = Array.from(merged.values());
              if (this.folderPath) this.ensureUploadFolderLocal(this.folderPath);
              this.uploadFoldersFetched = true;
            } catch (error) {
              if (force) {
                const message =
                  error.message === "Failed to fetch"
                    ? "无法读取后端目录，请确认服务已启动"
                    : error.message || "目录读取失败";
                this.showToast(message, "error");
              }
            } finally {
              this.uploadFoldersLoading = false;
            }
          },

          openUploadFolderCreator() {
            if (this.isGuest) {
              this.showToast("访客模式不可新建目录", "error");
              return;
            }
            this.newUploadFolderPath = this.folderPath
              ? `${this.folderPath}/新目录`
              : "新目录";
            this.showUploadFolderCreator = true;
            this.$nextTick(() => this.$refs.newFolderInput?.focus?.());
          },

          cancelUploadFolderCreator() {
            this.showUploadFolderCreator = false;
            this.newUploadFolderPath = "";
          },

          async createUploadFolder() {
            if (this.uploadFolderCreating) return;
            const path = this.normalizeFolderPath(this.newUploadFolderPath);
            if (!path) {
              this.showToast("请输入目录路径", "error");
              return;
            }

            this.uploadFolderCreating = true;
            try {
              const response = await fetch("/api/manage/folders", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok || !data.success) {
                throw new Error(data.error || "目录创建失败");
              }
              this.ensureUploadFolderLocal(path);
              this.selectUploadFolder(path);
              this.showUploadFolderCreator = false;
              this.newUploadFolderPath = "";
              this.uploadFoldersFetched = true;
              this.showToast(`目录已创建：${path}`, "success");
            } catch (error) {
              this.showToast(error.message || "目录创建失败", "error");
            } finally {
              this.uploadFolderCreating = false;
            }
          },

          // 上传触发
          triggerUpload() {
            this.$refs.fileInput.click();
          },

          // 处理文件选择
          handleFileSelect(event) {
            const files = Array.from(event.target.files || []);
            this.prepareFilesForUpload(files);
            event.target.value = "";
          },

          // 拖拽事件
          onDragOver() {
            this.isDragging = true;
          },
          onDragLeave() {
            this.isDragging = false;
          },
          onDrop(event) {
            this.isDragging = false;
            const files = Array.from(event.dataTransfer.files || []);
            this.prepareFilesForUpload(files);
          },

          getClipboardFileExtension(mimeType, fallback = "bin") {
            const type = String(mimeType || "").split(";")[0].toLowerCase();
            const map = {
              "image/jpeg": "jpg",
              "image/png": "png",
              "image/webp": "webp",
              "image/gif": "gif",
              "image/bmp": "bmp",
              "image/svg+xml": "svg",
              "image/avif": "avif",
              "video/mp4": "mp4",
              "video/webm": "webm",
              "audio/mpeg": "mp3",
              "audio/wav": "wav",
              "audio/ogg": "ogg",
              "application/pdf": "pdf",
              "application/zip": "zip",
              "text/plain": "txt",
            };
            return map[type] || type.split("/").pop() || fallback;
          },

          normalizeClipboardFile(file, index = 0, prefix = "paste") {
            const name = String(file.name || "").trim();
            if (name && !/^image\.(png|jpe?g|gif|webp)$/i.test(name)) {
              return file;
            }

            const ext = this.getClipboardFileExtension(file.type);
            const safeExt = String(ext || "bin").replace(/[^a-z0-9]/gi, "") || "bin";
            return new File(
              [file],
              `${prefix}_${Date.now()}_${index + 1}.${safeExt}`,
              {
                type: file.type || "application/octet-stream",
                lastModified: file.lastModified || Date.now(),
              },
            );
          },

          extractFilesFromClipboardData(clipboardData, prefix = "paste") {
            const files = [];
            const seen = new Set();
            const pushFile = (file, index) => {
              if (!file) return;
              const key = `${file.name || ""}:${file.type || ""}:${file.size}`;
              if (seen.has(key)) return;
              seen.add(key);
              files.push(this.normalizeClipboardFile(file, index, prefix));
            };

            Array.from(clipboardData?.files || []).forEach(pushFile);
            Array.from(clipboardData?.items || []).forEach((item, index) => {
              if (item.kind === "file") {
                pushFile(item.getAsFile(), index);
              }
            });

            return files;
          },

          shouldIgnorePasteTarget(target) {
            const el = target?.closest?.(
              "input, textarea, select, [contenteditable='true']",
            );
            return Boolean(el);
          },

          async queuePastedFiles(files, sourceLabel = "Ctrl+V") {
            if (!files || files.length === 0) {
              this.showPasteUploadNotice({
                type: "error",
                title: "没有检测到可上传文件",
                message: "请先复制图片或文件，再使用粘贴上传。",
              });
              return;
            }

            const valid = this.validateUploadFiles(files);
            if (!valid || valid.length === 0) {
              this.showPasteUploadNotice({
                type: "error",
                title: "粘贴内容未加入队列",
                message: "文件可能超过当前存储上限，或剪贴板内容不支持上传。",
              });
              return;
            }

            const context = this.createUploadContext();
            const imageCount = valid.filter((file) =>
              this.isCompressibleImage(file),
            ).length;
            const totalSize = valid.reduce((sum, file) => sum + (file.size || 0), 0);
            const needsChoice = imageCount > 0 && this.imageUploadDecision === "ask";

            this.showPasteUploadNotice({
              type: "success",
              title: needsChoice ? "已识别粘贴文件" : "粘贴上传已加入队列",
              message: needsChoice
                ? `通过 ${sourceLabel} 识别到文件，请在确认窗口选择图片处理方式。`
                : `通过 ${sourceLabel} 添加成功，已加入上传队列并开始处理。`,
              fileCount: valid.length,
              totalSize: this.formatSize(totalSize),
              storageTarget: context.storageTarget,
              folderPath: context.folderPath,
            });

            setTimeout(() => {
              this.prepareFilesForUpload(valid, { skipValidation: true }).catch((error) => {
                this.showPasteUploadNotice({
                  type: "error",
                  title: "粘贴上传启动失败",
                  message: error.message || "请稍后重试。",
                });
              });
            }, 0);
          },

          // 粘贴上传
          async pasteFromClipboard() {
            try {
              const items = await navigator.clipboard.read();
              const files = [];
              for (const [itemIndex, item] of items.entries()) {
                for (const type of item.types || []) {
                  if (type === "text/plain" || type === "text/html") continue;
                  try {
                    const blob = await item.getType(type);
                    if (!blob || !blob.size) continue;
                    const ext = this.getClipboardFileExtension(type);
                    const file = new File(
                      [blob],
                      `clipboard_${Date.now()}_${itemIndex + 1}.${ext}`,
                      { type },
                    );
                    files.push(file);
                  } catch (error) {
                    // 有些剪贴板类型只暴露名称，读取失败时跳过该项。
                  }
                }
              }
              await this.queuePastedFiles(files, "粘贴按钮");
            } catch (err) {
              this.showPasteUploadNotice({
                type: "error",
                title: "无法读取剪贴板",
                message: "浏览器拒绝访问剪贴板时，请直接按 Ctrl/Cmd + V 粘贴文件或图片。",
              });
            }
          },





          











          // 在入口处固定配置；后续切换目标、目录或图片设置不修改已有任务。
          createUploadContext() {
            const limit = { ...this.getUploadLimit(this.storageMode) };
            if (this.isGuest && this.guestUploadConfig) {
              limit.maxBytes = Math.min(limit.maxBytes, this.guestUploadConfig.maxFileSize);
              limit.supportsChunkUpload = false;
            }
            const chunkSize = Number(this.uploadConfig.chunkSize);
            return Object.freeze({
              storageMode: this.storageMode,
              storageTarget: this.storageTarget,
              folderPath: this.normalizeFolderPath(this.folderPath),
              isGuest: this.isGuest,
              limit: Object.freeze(limit),
              chunkSize: Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : 5 * 1024 * 1024,
            });
          },

          snapshotFileBatchOptions() {
            return {
              context: this.createUploadContext(),
              decision: this.imageUploadDecision,
              imageOptions: this.snapshotImageCompressOptions(this.imageCompress.enabled),
            };
          },

          createUploadTask(kind, context, fields = {}) {
            return {
              id: this.nextUploadId(), kind, context,
              storageMode: context.storageMode,
              storageTarget: context.storageTarget,
              folderPath: context.folderPath,
              name: "", size: null, file: null, originalFile: null, preview: null,
              status: "waiting", uploadStage: "waiting", error: null,
              progress: 0, confirmedChunks: 0, totalChunks: 0, isChunked: false,
              startedAt: 0, attempts: 0, resultRegistered: false,
              compressionStatus: "", imageCompressionPrepared: false,
              imageCompressOptions: null, sourceUrl: "", variant: null,
              mediaResolved: false, mediaMaxBytes: 0,
              ...fields,
            };
          },



          loadImageUploadDecision() {
            try {
              const saved = localStorage.getItem("kvault:image-upload-decision");
              if (["original", "optimized", "ask"].includes(saved)) {
                this.imageUploadDecision = saved;
              }
            } catch (e) {}
          },

          setImageUploadDecision(decision) {
            if (!["original", "optimized", "ask"].includes(decision)) return;
            this.imageUploadDecision = decision;
            if (decision === "optimized") {
              this.imageCompress.enabled = true;
            } else if (decision === "original") {
              this.imageCompress.enabled = false;
            }
            try {
              localStorage.setItem("kvault:image-upload-decision", decision);
            } catch (e) {}
            this.saveImageCompressSettings();
          },

          storageEnabledFromStatus(statusItem) {
            return !!(
              statusItem &&
              (statusItem.connected || statusItem.configured) &&
              statusItem.enabled !== false
            );
          },

          getUploadLimit(storageMode) {
            const fallback = {
              telegram: {
                maxBytes: 20 * 1024 * 1024,
                directThreshold: 20 * 1024 * 1024,
                supportsChunkUpload: false,
              },
              r2: {
                maxBytes: this.uploadConfig.maxSize,
                directThreshold: this.uploadConfig.smallFileThreshold,
                supportsChunkUpload: true,
              },
              s3: {
                maxBytes: this.uploadConfig.maxSize,
                directThreshold: this.uploadConfig.smallFileThreshold,
                supportsChunkUpload: true,
              },
              discord: {
                maxBytes: 25 * 1024 * 1024,
                directThreshold: this.uploadConfig.smallFileThreshold,
                supportsChunkUpload: true,
              },
              huggingface: {
                maxBytes: 35 * 1024 * 1024,
                directThreshold: this.uploadConfig.smallFileThreshold,
                supportsChunkUpload: true,
              },
              github: {
                maxBytes: this.uploadConfig.maxSize,
                directThreshold: this.uploadConfig.smallFileThreshold,
                supportsChunkUpload: true,
              },
            };
            const base = fallback[storageMode] || fallback.telegram;
            return {
              ...base,
              ...(this.uploadLimits?.[storageMode] || {}),
            };
          },

          getTaskMaxBytes(item) {
            const maxBytes = item.context.limit.maxBytes;
            // 原快照不会因切换设置放宽；身份变为访客时再叠加当前限制。
            return this.isGuest && this.guestUploadConfig
              ? Math.min(maxBytes, this.guestUploadConfig.maxFileSize) : maxBytes;
          },

          validateUploadItemSize(item) {
            const maxBytes = this.getTaskMaxBytes(item);
            if (item.file.size > maxBytes) {
              throw new Error(`${this.getItemStorageTarget(item)} 本任务单文件校验上限为 ${this.formatSize(maxBytes)}。请减小文件，或按新目标重新添加；重试保留原配置。`);
            }
          },

          shouldUseChunkedUpload(item) {
            const limit = item.context.limit;
            return !item.context.isGuest && !this.isGuest && limit.supportsChunkUpload === true &&
              item.file.size > limit.directThreshold;
          },

          assertTaskPermission(item) {
            if (!this.authStatusVerified || this.authChecking || this.authLoginRequired) {
              throw new Error("身份尚未确认，请重新读取状态后重试。");
            }
            if (!this.storageStatusVerified || !this.storageOptions.some((option) =>
              option.mode === item.context.storageMode && option.available)) {
              throw new Error(`原目标 ${item.context.storageTarget} 当前不可用或无权使用；不会自动切换存储。请重新读取状态后重试。`);
            }
          },










          validateUploadFiles(files, context = this.createUploadContext(), allowCompression = false) {
            const maxSize = context.limit.maxBytes;
            const valid = Array.from(files || []).filter((file) => file && Number.isFinite(file.size) &&
              (file.size <= maxSize || (allowCompression && this.isCompressibleImage(file))));
            const rejected = Array.from(files || []).length - valid.length;
            if (rejected) this.showToast(`${rejected} 个文件超过本批 ${this.formatSize(maxSize)} 校验上限或无法读取`, "error");
            return valid;
          },

          async prepareFilesForUpload(files, options = {}) {
            if (!this.ensureCanAddUploads()) return { fileCount: 0 };
            const snapshot = options.context ? options : this.snapshotFileBatchOptions();
            const { context, decision, imageOptions } = snapshot;
            // 可压缩图片允许先处理，真正发请求前仍按处理后的大小校验。
            const valid = this.validateUploadFiles(files, context, decision !== "original");
            if (!valid.length) return { fileCount: 0, totalSize: 0, pending: false };
            const imageCount = valid.filter((file) => this.isCompressibleImage(file)).length;
            const pending = imageCount > 0 && decision === "ask";
            if (pending) {
              this.pendingUploadBatches.push({
                id: this.nextUploadId("batch"), files: valid, context,
                imageOptions: { ...imageOptions },
                choice: imageOptions.enabled ? "compress" : "original",
              });
              this.showNextPendingUpload();
            } else {
              this.processFiles(valid, { ...imageOptions, enabled: imageCount > 0 && decision === "optimized" }, context);
            }
            return {
              fileCount: valid.length, imageCount,
              totalSize: valid.reduce((sum, file) => sum + file.size, 0),
              pending, storageTarget: context.storageTarget, folderPath: context.folderPath,
            };
          },

          showNextPendingUpload() {
            if (this._isDisposed || this.activeUploadDialog || !this.pendingUploadBatches.length) return;
            this.pendingUploadBatch = this.pendingUploadBatches.shift();
            this.pendingCompressionChoice = this.pendingUploadBatch.choice;
          },

          setPendingCompressionMode(mode) {
            if (["original", "compress"].includes(mode)) this.pendingCompressionChoice = mode;
          },

          cancelPendingUpload() {
            const batch = this.consumePendingUploadBatch();
            if (batch) batch.files = [];
          },

          consumePendingUploadBatch() {
            const batch = this.pendingUploadBatch;
            this.pendingUploadBatch = null;
            this.$nextTick(() => {
              if (this._isDisposed) return;
              this.showNextPendingUpload();
              this.startUpload();
            });
            return batch;
          },

          confirmPendingUpload() {
            if (!this.pendingUploadBatch || this._isDisposed) return;
            const enabled = this.pendingCompressionChoice === "compress";
            const batch = this.consumePendingUploadBatch();
            this.processFiles(batch.files, { ...batch.imageOptions, enabled }, batch.context);
            batch.files = [];
          },

          
          
          getItemStorageMode(item) {
            return item.context.storageMode;
          },

          getItemStorageTarget(item) {
            return item.context.storageTarget;
          },

          getItemFolderPath(item) {
            return item.context.folderPath;
          },






          // 所有入口都只入队；并发槽只由 startUpload 分配。
          processFiles(files, imageCompressOptions, uploadContext) {
            if (this._isDisposed || !files?.length) return;
            const context = uploadContext || this.createUploadContext();
            const imageOptions = Object.freeze({ ...(imageCompressOptions || this.snapshotImageCompressOptions(false)) });
            for (const file of files) {
              const item = this.createUploadTask("file", context, {
                name: file.name, size: file.size, file, originalFile: file,
                originalName: file.name, originalSize: file.size,
                imageCompressOptions: imageOptions,
              });
              if (String(file.type).startsWith("image/")) {
                try { item.preview = this.createTrackedObjectURL(file); } catch (error) { /* 预览失败不阻止上传。 */ }
              }
              this.uploadingFiles.push(item);
            }
            this.startUpload();
          },

          canScheduleTask(item) {
            return item.status === "waiting" && !this._uploadRunning.has(item.id) &&
              !(item.kind === "media" && !item.mediaResolved && this.activeUploadDialog);
          },

          // 页面级统一调度：先同步占槽，再执行异步操作，防止多批次和重试重入。
          startUpload() {
            if (this._isDisposed || this._pumping || this.authChecking || this.storageStatusLoading) return;
            this._pumping = true;
            clearTimeout(this._queueTimer);
            this._queueTimer = null;
            try {
              while (this._uploadRunning.size < this._maxConcurrent) {
                const item = this.uploadingFiles.find((task) => this.canScheduleTask(task) &&
                  (this.getItemStorageMode(task) !== "telegram" ||
                    (!this._telegramRunning && Date.now() >= this._telegramNextAt)));
                if (!item) break;
                const telegram = this.getItemStorageMode(item) === "telegram";
                this._uploadRunning.add(item.id);
                if (telegram) this._telegramRunning = true;
                const controller = new AbortController();
                this._taskControllers.set(item.id, controller);
                item.status = item.kind === "media" && !item.mediaResolved ? "resolving" : "uploading";
                item.startedAt = Date.now();
                item.attempts += 1;
                if (item.kind !== "file") this.startUrlTicker();
                this.runUploadTask(item, controller.signal, telegram);
              }
              const delay = this._telegramNextAt - Date.now();
              if (!this._telegramRunning && delay > 0 && this._uploadRunning.size < this._maxConcurrent &&
                this.uploadingFiles.some((item) => this.canScheduleTask(item) && this.getItemStorageMode(item) === "telegram")) {
                this._queueTimer = setTimeout(() => { this._queueTimer = null; this.startUpload(); }, delay);
              }
            } finally {
              this._pumping = false;
            }
          },

          // runUploadTask 把非 file 的任务交给这里。3257348 引入队列时只写了
          // 调用点，没写实现：this.uploadRemoteTask 是 undefined，调用即抛
          // TypeError，于是任务卡在 uploading——服务端其实已经返回 200 了
          // （nginx access 里有 POST /api/resolve-url 200），页面却一直转圈，
          // 而且 finally 里的收尾虽然会跑，item.status 也已被置成 error，
          // 表现为「粘贴抖音链接后界面冻住」。
          //
          // 两种远程任务：
          //   kind === "media" 分享链接 → /api/resolve-url（带 upload:true）
          //   kind === "url"   普通直链 → /api/upload-from-url
          async uploadRemoteTask(item, signal) {
            this.assertUploadActive(item, signal);
            this.assertTaskPermission(item);
            item.status = "uploading";
            item.uploadStage = "requesting";
            item.progress = 0;

            const body = {
              url: item.sourceUrl,
              storageMode: this.getItemStorageMode(item),
              folderPath: this.getItemFolderPath(item),
            };
            const endpoint =
              item.kind === "media" ? "/api/resolve-url" : "/api/upload-from-url";
            if (item.kind === "media") {
              body.upload = true;
              body.formatId = item.variant?.formatId || "";
              body.needsAudio = item.variant?.needsAudio === true;
            }

            // requestJson 自带 AbortSignal 与统一的错误契约（含 v2 信封解析），
            // 不要自己再写一份 fetch。
            const data = await this.requestJson(
              `${this.baseURL}${endpoint}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal,
              },
              item,
            );

            this.assertUploadActive(item, signal);
            this.handleUploadSuccess(item, this.getUploadResponse(data));
          },

          async runUploadTask(item, signal, telegram) {
            try {
              this.assertUploadActive(item, signal);
              this.assertTaskPermission(item);
              if (item.kind === "file") await this.uploadFile(item, signal);
              else if (item.kind === "media" && !item.mediaResolved) await this.openQualityPicker(item, signal);
              else await this.uploadRemoteTask(item, signal);
            } catch (error) {
              if (this.isUploadTaskActive(item) && error.name !== "AbortError") {
                item.status = "error";
                item.error = error.message || "请求失败，请重试";
                if (this.qualityPicker.task === item) {
                  this.qualityPicker.loading = false;
                  this.qualityPicker.error = item.error;
                }
                this.showToast(`${item.name}：${item.error}`, "error");
              }
            } finally {
              this._taskControllers.delete(item.id);
              this._uploadRunning.delete(item.id);
              if (telegram) {
                this._telegramRunning = false;
                // 包括失败、取消、解析与重试；跨批次继续遵守 500ms 间隔。
                this._telegramNextAt = Date.now() + 500;
              }
              if (!this._isDisposed) {
                if (!this.urlActivityCount) this.stopUrlTicker();
                this.startUpload();
              }
            }
          },

          async uploadFile(item, signal) {
            await this.prepareUploadItem(item, signal);
            this.assertUploadActive(item, signal);
            this.assertTaskPermission(item);
            this.validateUploadItemSize(item);
            item.status = "uploading";
            item.progress = 0;
            item.isChunked = this.shouldUseChunkedUpload(item);
            if (item.isChunked) await this.chunkedUpload(item, signal);
            else await this.directUpload(item, signal);
          },

          // 直接上传：fetch 不提供请求体的传输进度，只报告请求阶段。
          async directUpload(item, signal) {
            item.uploadStage = "requesting";
            const formData = new FormData();
            formData.append("file", item.file);
            formData.append("storageMode", this.getItemStorageMode(item));
            formData.append("folderPath", this.getItemFolderPath(item));
            const data = await this.requestJson(`${this.baseURL}/upload`, {
              method: "POST", body: formData, signal,
            }, item);
            this.handleUploadSuccess(item, this.getUploadResponse(data));
          },

          // 分片数量只代表已接收；合并/写存储返回有效 src 后才算完成。
          async chunkedUpload(item, signal) {
            const file = item.file;
            const chunkSize = item.context.chunkSize;
            const totalChunks = Math.ceil(file.size / chunkSize);
            item.uploadStage = "initializing";
            item.confirmedChunks = 0;
            item.totalChunks = totalChunks;
            const init = await this.requestJson(`${this.baseURL}/api/chunked-upload/init`, {
              method: "POST", headers: { "Content-Type": "application/json" }, signal,
              body: JSON.stringify({
                fileName: file.name, fileSize: file.size, fileType: file.type, totalChunks,
                storageMode: this.getItemStorageMode(item), folderPath: this.getItemFolderPath(item),
              }),
            }, item);
            const uploadId = (init?.data || init)?.uploadId;
            if (typeof uploadId !== "string" || !uploadId.trim()) throw new Error("初始化未返回有效的上传标识");
            item.uploadStage = "chunks";
            for (let i = 0; i < totalChunks; i++) {
              this.assertUploadActive(item, signal);
              const formData = new FormData();
              formData.append("chunk", file.slice(i * chunkSize, Math.min((i + 1) * chunkSize, file.size)));
              formData.append("uploadId", uploadId);
              formData.append("chunkIndex", i);
              const result = await this.requestJson(`${this.baseURL}/api/chunked-upload/chunk`, {
                method: "POST", body: formData, signal,
              }, item);
              if ((result?.data || result)?.success !== true) throw new Error(`分片 ${i + 1} 未获服务端确认`);
              item.confirmedChunks = i + 1;
            }
            item.uploadStage = "merging";
            const data = await this.requestJson(`${this.baseURL}/api/chunked-upload/complete`, {
              method: "POST", headers: { "Content-Type": "application/json" }, signal,
              body: JSON.stringify({ uploadId }),
            }, item);
            this.handleUploadSuccess(item, this.getUploadResponse(data));
          },

          getUploadResponse(data) {
            const payload = data?.data || data;
            const result = Array.isArray(payload) ? payload[0] : payload?.items?.[0] || payload;
            if (typeof result?.src !== "string" || !result.src.trim()) throw new Error("未返回有效的文件路径");
            const url = new URL(result.src, this.baseURL);
            if (!["http:", "https:"].includes(url.protocol)) throw new Error("返回的文件链接协议无效");
            return { ...result, url: url.href };
          },

          handleUploadSuccess(item, result) {
            this.assertUploadActive(item);
            if (item.resultRegistered) return;
            const name = item.file?.name || result.fileName || result.name || item.name;
            const size = item.file ? item.file.size : Number.isFinite(result.size) ? result.size : null;
            const uploadedFile = {
              id: this.nextUploadId("result"), taskId: item.id,
              name, fileName: name, url: result.url, path: result.src, size,
              storageMode: item.context.storageMode, storageTarget: item.context.storageTarget,
              folderPath: item.context.folderPath, selected: false, uploadTime: Date.now(),
            };
            item.resultRegistered = true;
            item.status = "success";
            item.uploadStage = "complete";
            item.progress = 100;
            this.uploadedFiles.unshift(uploadedFile);
            this.addToHistory(uploadedFile);
            this.showToast(`已上传 ${name} 到 ${item.context.storageTarget}`, "success");
            const timer = setTimeout(() => {
              this._successTimers.delete(item.id);
              if (!this._isDisposed && item.status === "success") this.removeUploadTask(item);
            }, 2000);
            this._successTimers.set(item.id, timer);
          },

          // 格式化链接
          formatLink(file) {
            // 使用核心方法获取干净的文件直链与安全的文件名
            return KVShared.formatLink(this.getCleanFileUrl(file), this.getDisplayName(file), this.linkFormat);
          },

          // 获取批量链接
          getBatchLinks() {
            const selected = this.uploadedFiles.filter((f) => f.selected);
            const files = selected.length > 0 ? selected : this.uploadedFiles;
            return files.map((f) => this.formatLink(f)).join("\n");
          },

          // 复制链接
          async copyLink(file) {
            try {
              const link = this.formatLink(file);
              await this.copyToClipboard(link);
              this.showToast("链接已复制", "success");
            } catch (err) {
              this.showToast("复制失败，请手动复制", "error");
            }
          },

          // 复制选中链接
          async copySelectedLinks() {
            await this.copyFileLinks(this.uploadedFiles.filter((file) => file.selected));
          },

          // 复制全部链接
          async copyAllLinks() {
            await this.copyFileLinks(this.uploadedFiles);
          },

          async copyFileLinks(files) {
            if (!files.length) return;
            const count = files.length;
            try {
              await this.copyToClipboard(files.map((file) => this.formatLink(file)).join("\n"));
              this.showToast(`已复制 ${count} 个链接`, "success");
            } catch (error) {
              this.showToast("复制失败，请使用链接文本手动复制", "error");
            }
          },

          // 选择全部
          selectAll() {
            const newState = !this.isAllSelected;
            this.uploadedFiles.forEach((f) => (f.selected = newState));
          },

          // 清空结果
          clearResults() {
            this.uploadedFiles = [];
          },

          // 清空上传队列
          clearUploadQueue() {
            this.uploadingFiles = this.uploadingFiles.filter(
              (f) => f.status === "uploading" || f.status === "processing",
            );
            if (this.uploadingFiles.length === 0) {
              this.showToast("队列已清空", "success");
            }
          },

          // 重试单个失败项
          async retryUpload(item) {
            item.status = "waiting";
            item.error = null;
            item.progress = 0;
            await this.uploadFile(item);
          },

          // 重试所有失败项
          async retryAllFailed() {
            const failed = this.uploadingFiles.filter(
              (f) => f.status === "error",
            );
            if (failed.length === 0) return;

            this.showToast(`正在重试 ${failed.length} 个失败项...`, "info");

            // 重置状态
            failed.forEach((item) => {
              item.status = "waiting";
              item.error = null;
              item.progress = 0;
            });

            await this.startUpload();

            const successCount = failed.filter(
              (f) => f.status === "success",
            ).length;
            if (successCount > 0) {
              this.showToast(
                `重试成功 ${successCount}/${failed.length} 个文件`,
                "success",
              );
            }
          },

          // 从结果中移除
          removeFromResults(index) {
            this.uploadedFiles.splice(index, 1);
          },

          // 下载文件
          downloadFile(file) {
            // 使用核心方法获取干净的文件直链与安全的文件名
            KVShared.downloadFile(this.getCleanFileUrl(file), this.getDisplayName(file));
          },

          // 打开预览页面 - 使用统一媒体预览服务
          openPreview(file) {
            const target = KVShared.buildPreviewTarget(
              this.getDisplayName(file),
              this.getCleanFileUrl(file),
              { autoplay: true },
            );
            if (target.type === "download") {
              this.downloadFile(file);
              return;
            }
            this.previewData = target;
          },

          // 关闭预览并彻底移除 iframe
          closePreview() {
            // 彻底移除 iframe 元素，停止视频/音频播放
            if (this.$refs.previewIframe) {
              this.$refs.previewIframe.src = "about:blank";
            }
            this.previewData = null;
          },

          // 复制预览文件的直链
          async copyPreviewLink() {
            if (!this.previewData) return;
            try {
              await this.copyToClipboard(this.previewData.url);
              this.showToast("直链已复制", "success");
            } catch (error) {
              this.showToast("复制失败，请返回结果区手动复制链接", "error");
            }
          },

          // 下载预览中的文件
          downloadPreviewFile() {
            if (!this.previewData) return;
            const a = document.createElement("a");
            a.href = this.previewData.url;
            a.download = this.previewData.fileName || "download";
            a.click();
          },

          // 历史记录相关
          addToHistory(file) {
            // 避免重复
            const exists = this.uploadHistory.find((h) => h.url === file.url);
            if (!exists) {
              this.uploadHistory.unshift({ ...file, selected: false });
              this.saveHistory();
            }
          },

          selectAllHistory() {
            const newState = !this.isAllHistorySelected;
            this.uploadHistory.forEach((f) => (f.selected = newState));
          },

          toggleHistorySelect(index) {
            this.uploadHistory[index].selected =
              !this.uploadHistory[index].selected;
          },

          async copySelectedHistoryLinks() {
            await this.copyFileLinks(this.uploadHistory.filter((file) => file.selected));
          },

          removeFromHistory(index) {
            this.uploadHistory.splice(index, 1);
            this.saveHistory();
          },

          // 安全获取文件显示名称（避免显示 URL 或乱码）
          getDisplayName(item) {
            // 优先使用 fileName 或 name
            const name = item.fileName || item.name;

            // 如果有有效的名称（不包含 :// 协议头）
            if (name && !name.includes("://")) {
              return name;
            }

            // 尝试从 URL 提取文件名部分
            if (item.url) {
              const urlPath = item.url.split("/").pop().split("?")[0];
              // 只有当提取的文件名合理时才使用（有扩展名且长度适中）
              if (urlPath && urlPath.includes(".") && urlPath.length < 80) {
                return urlPath;
              }
            }

            return "未知文件";
          },

          // 核心方法：从污染的 URL 中提取干净的文件直链
          // 无论输入是 ID、路径、还是完整 URL，都返回标准格式：https://pan.katelya.eu.org/file/{id}.{ext}
          getCleanFileUrl(item) {
            let rawUrl = item.url || item.path || "";

            // 情况1: 已经是标准直链格式 https://pan.katelya.eu.org/file/xxx.ext
            if (rawUrl.startsWith("https://") && rawUrl.includes("/file/")) {
              // 提取 /file/ 后面的部分作为 fileId
              const match = rawUrl.match(/\/file\/([^?#]+)/);
              if (match) {
                const fileId = match[1];
                return `${this.baseURL}/file/${fileId}`;
              }
            }

            // 情况2: 相对路径格式 /file/xxx.ext
            if (rawUrl.startsWith("/file/")) {
              return `${this.baseURL}${rawUrl}`;
            }

            // 情况3: 只有 fileId（如 BQACAg...ext）
            if (rawUrl && !rawUrl.includes("/") && !rawUrl.includes("://")) {
              return `${this.baseURL}/file/${rawUrl}`;
            }

            // 情况4: 污染的 URL（如 /file/https://... 或其他异常格式）
            // 尝试提取最后的文件ID部分
            const lastSegment = rawUrl.split("/").pop().split("?")[0];
            if (lastSegment && lastSegment.includes(".")) {
              return `${this.baseURL}/file/${lastSegment}`;
            }

            // 兜底：返回原始 URL
            return rawUrl;
          },

          // 从 URL 中提取干净的文件路径（不带域名，格式：/file/xxx.ext）
          
          // 文件类型判断方法。扩展名清单改用 KVShared 的统一版本 ——
          // 这里原来自己抄了一份 8 项的，不含 avif / heic / tiff，于是
          // 会出现「图库认为是图片、上传页却当成普通文件」。kv-shared.js
          // 在本文件之前加载。
          isImageFile(filename) {
            return KVShared.isImageName(this.getFileExt(filename));
          },

          getFileExt(filename) {
            if (!filename) return "";
            const parts = filename.split(".");
            return parts.length > 1 ? parts.pop() : "";
          },

          getFileIcon(filename) {
            const ext = this.getFileExt(filename).toLowerCase();
            const iconMap = {
              // 视频
              mp4: "video",
              webm: "video",
              avi: "video",
              mov: "video",
              mkv: "video",
              flv: "video",
              // 音频
              mp3: "music",
              wav: "music",
              ogg: "music",
              flac: "music",
              aac: "music",
              m4a: "music",
              // 文档
              pdf: "file-text",
              doc: "file-text",
              docx: "file-text",
              xls: "file-spreadsheet",
              xlsx: "file-spreadsheet",
              ppt: "presentation",
              pptx: "presentation",
              txt: "file-text",
              md: "file-text",
              // 压缩包
              zip: "file-archive",
              rar: "file-archive",
              "7z": "file-archive",
              tar: "file-archive",
              gz: "file-archive",
              // 代码
              js: "file-code",
              ts: "file-code",
              py: "file-code",
              java: "file-code",
              c: "file-code",
              cpp: "file-code",
              html: "file-code",
              css: "file-code",
              json: "file-code",
            };
            return iconMap[ext] || "file";
          },

          
          handleHistoryImgError(event, item) {
            // 图片加载失败时，将其标记为非图片，让Vue重新渲染为图标
            item._imgError = true;
            this.$forceUpdate();
          },

          clearHistory() {
            this.historyConfirmOpen = true;
          },

          confirmClearHistory() {
            this.uploadHistory = [];
            this.historyConfirmOpen = false;
            // 读取被损坏数据阻断过的话，清空之后这个状态也该解除。
            this.historyReadBlocked = false;
            if (this.saveHistory()) this.showToast("本地历史已清空，服务器文件未删除", "success");
          },

          saveHistory() {
            try {
              localStorage.setItem("uploadHistory", JSON.stringify(this.uploadHistory));
              this.historySaveError = "";
              return true;
            } catch (error) {
              this.historySaveError = "本地历史未能保存，可能是浏览器存储已满或被禁用。当前记录仍在本页，刷新后可能丢失；已成功上传的服务器文件不受影响，请先复制链接。";
              return false;
            }
          },

          loadHistory() {
            try {
              const history = localStorage.getItem("uploadHistory");
              if (history) {
                let needsSave = false;

                // 迁移旧数据：修复污染的 URL 和缺失的 fileName
                this.uploadHistory = JSON.parse(history).map((h) => {
                  let item = { ...h, selected: false };

                  // === 1. 修复污染的 URL 字段 ===
                  // 检查 URL 是否被污染（如 /file/https://... 或重复的域名）
                  if (item.url) {
                    const cleanUrl = this.cleanUrlField(item.url);
                    if (cleanUrl !== item.url) {
                      item.url = cleanUrl;
                      needsSave = true;
                    }
                  }

                  // === 2. 修复缺失或污染的 fileName 字段 ===
                  // 如果 fileName 包含 :// 或不存在
                  if (!item.fileName || item.fileName.includes("://")) {
                    // 尝试使用 name
                    if (item.name && !item.name.includes("://")) {
                      item.fileName = item.name;
                      needsSave = true;
                    } else {
                      // 从 URL 中提取文件名
                      const urlPath = (item.url || "")
                        .split("/")
                        .pop()
                        .split("?")[0];
                      if (
                        urlPath &&
                        urlPath.includes(".") &&
                        urlPath.length < 80
                      ) {
                        item.fileName = urlPath;
                        item.name = urlPath;
                        needsSave = true;
                      } else {
                        item.fileName = "未知文件";
                        item.name = "未知文件";
                        needsSave = true;
                      }
                    }
                  }

                  return item;
                });

                // 只有数据被修改时才保存
                if (needsSave) {
                  this.saveHistory();
                  console.log("历史记录已迁移修复");
                }
              }
            } catch (e) {
              console.error("加载历史记录失败:", e);
              this.uploadHistory = [];
            }
          },

          // 清理污染的 URL 字段
          cleanUrlField(url) {
            if (!url) return url;

            // 情况1: /file/https://pan.katelya.eu.org/file/xxx.ext
            // 或 /file/https://... 这种污染格式
            if (
              url.includes("/file/https://") ||
              url.includes("/file/http://")
            ) {
              // 提取最后一个有效的文件ID
              const match = url.match(
                /\/file\/([^\/?#]+\.[a-zA-Z0-9]+)(?:[?#].*)?$/,
              );
              if (match) {
                return `${this.baseURL}/file/${match[1]}`;
              }
            }

            // 情况2: 双重 https:// 前缀
            if (url.match(/https?:\/\/.*https?:\/\//)) {
              // 提取最后一个完整的 URL
              const lastUrl = url.match(/(https?:\/\/[^\/]+\/file\/[^?#]+)/);
              if (lastUrl) {
                // 从中提取 fileId
                const fileId = lastUrl[1].split("/file/").pop();
                return `${this.baseURL}/file/${fileId}`;
              }
            }

            // 情况3: 正常的完整 URL，确保使用当前域名
            if (url.startsWith("https://") && url.includes("/file/")) {
              const match = url.match(/\/file\/([^?#]+)/);
              if (match) {
                return `${this.baseURL}/file/${match[1]}`;
              }
            }

            // 情况4: 相对路径，补全域名
            if (url.startsWith("/file/")) {
              return `${this.baseURL}${url}`;
            }

            return url;
          },

          // 工具方法
          formatSize(bytes) {
            return KVShared.formatSize(bytes);
          },

          
          getFileIcon(filename) {
            return KVShared.fileIconOf(filename);
          },

          copyToClipboard(text) {
            return KVShared.copyToClipboard(text);
          },

          showToast(message, type = "info") {
            KVShared.toast(message, type);
          },

          showPasteUploadNotice(notice) {
            if (this.pasteUploadNoticeTimer) {
              clearTimeout(this.pasteUploadNoticeTimer);
              this.pasteUploadNoticeTimer = null;
            }
            this.pasteUploadNotice = {
              type: notice.type || "info",
              title: notice.title || "粘贴上传",
              message: notice.message || "",
              fileCount: notice.fileCount || 0,
              totalSize: notice.totalSize || "",
              storageTarget: notice.storageTarget || this.storageTarget,
              folderPath: notice.folderPath || "",
            };
            this.pasteUploadNoticeTimer = setTimeout(() => {
              this.dismissPasteUploadNotice();
            }, notice.type === "error" ? 6500 : 5200);
          },

          dismissPasteUploadNotice() {
            if (this.pasteUploadNoticeTimer) {
              clearTimeout(this.pasteUploadNoticeTimer);
              this.pasteUploadNoticeTimer = null;
            }
            this.pasteUploadNotice = null;
          },

          getPasteNoticeIcon(type) {
            const icons = {
              success: "clipboard-check",
              error: "triangle-alert",
              info: "clipboard",
            };
            return icons[type] || icons.info;
          },

          // 退出登录
          async handleLogout() {
            try {
              await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
              });
              window.location.href = "/login.html";
            } catch (e) {
              this.showToast("退出失败", "error");
            }
          },

          // 检查认证状态
          async checkAuth() {
            this.authChecking = true;
            this.authStatusVerified = false;
            this.guestLimitVerified = false;
            this.guestDailyLimitVerified = false;
            try {
              const response = await fetch("/api/auth/check", {
                credentials: "include",
                cache: "no-store",
              });
              if (!response.ok) throw new Error(`认证状态读取失败（${response.status}）`);
              const data = await response.json();
              if (!data || typeof data.authRequired !== "boolean" || typeof data.authenticated !== "boolean") {
                throw new Error("认证状态响应无效");
              }
              this.authStatusVerified = true;

              if (data.authRequired && !data.authenticated) {
                this.isAuthenticated = false;
                if (data.guestUpload && data.guestUpload.enabled) {
                  this.isGuest = true;
                  this.guestLimitVerified = Number.isFinite(data.guestUpload.maxFileSize) && data.guestUpload.maxFileSize > 0;
                  this.guestDailyLimitVerified = Number.isFinite(data.guestUpload.dailyLimit) && data.guestUpload.dailyLimit > 0;
                  this.guestUploadConfig = {
                    maxFileSize: this.guestLimitVerified ? data.guestUpload.maxFileSize : 5 * 1024 * 1024,
                    maxDailyUploads: this.guestDailyLimitVerified ? data.guestUpload.dailyLimit : 10,
                  };
                  this.storageMode = "telegram";
                  this.storageTarget = "Telegram 频道";
                  return true;
                }
                window.location.href =
                  "/login.html?redirect=" +
                  encodeURIComponent(window.location.pathname);
                return false;
              }

              this.isGuest = false;
              this.guestUploadConfig = null;
              this.isAuthenticated = data.authRequired && data.authenticated;
              return true;
            } catch (e) {
              console.error("Auth check failed:", e);
              this.isGuest = false;
              this.guestUploadConfig = null;
              return true;
            } finally {
              this.authChecking = false;
            }
          },

          // 检查存储目标
          async checkStorageTarget(restoreSavedMode = true) {
            if (this.storageStatusLoading) return;
            this.storageStatusLoading = true;
            this.storageStatusVerified = false;
            try {
              const response = await fetch("/api/status", {
                credentials: "include",
                cache: "no-store",
              });
              if (!response.ok) throw new Error(`存储状态读取失败（${response.status}）`);
              const status = await response.json();
              if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("存储状态响应无效");
              this.uploadLimits = status.uploadLimits && typeof status.uploadLimits === "object" ? status.uploadLimits : {};
              this.storageStatusVerified = true;
              this.telegramAvailable = status.telegram ? this.storageEnabledFromStatus(status.telegram) : true;

              // 检查各存储后端是否可用
              this.r2Available = this.storageEnabledFromStatus(status.r2);
              this.s3Available = this.storageEnabledFromStatus(status.s3);
              this.discordAvailable = this.storageEnabledFromStatus(
                status.discord,
              );
              this.huggingfaceAvailable = this.storageEnabledFromStatus(
                status.huggingface,
              );
              this.githubAvailable = this.storageEnabledFromStatus(status.github);

              // 手动刷新限制不改变当前目标；只有初始化时恢复偏好。
              if (!restoreSavedMode) return;
              let savedMode = "";
              try { savedMode = localStorage.getItem("storageMode") || ""; } catch (e) {}
              const modeAvailability = {
                telegram: this.telegramAvailable,
                r2: this.r2Available,
                s3: this.s3Available,
                discord: this.discordAvailable,
                huggingface: this.huggingfaceAvailable,
                github: this.githubAvailable,
              };
              const modeLabels = KVShared.STORAGE_TARGETS;

              // 如果保存的模式可用（且非访客模式或是 telegram/r2），恢复之
              if (savedMode && modeLabels[savedMode]) {
                if (savedMode === "telegram") {
                  this.storageMode = "telegram";
                  this.storageTarget = modeLabels["telegram"];
                } else if (modeAvailability[savedMode] && !this.isGuest) {
                  this.storageMode = savedMode;
                  this.storageTarget = modeLabels[savedMode];
                } else if (savedMode === "r2" && this.r2Available) {
                  this.storageMode = "r2";
                  this.storageTarget = modeLabels["r2"];
                } else {
                  this.storageMode = "telegram";
                  this.storageTarget = modeLabels["telegram"];
                }
              } else {
                this.storageMode = "telegram";
                this.storageTarget = modeLabels["telegram"];
              }
            } catch (e) {
              console.warn("Storage status unavailable:", e);
              this.uploadLimits = {};
              if (restoreSavedMode) {
                this.storageMode = "telegram";
                this.storageTarget = "Telegram 频道";
                this.r2Available = false;
                this.s3Available = false;
                this.discordAvailable = false;
                this.huggingfaceAvailable = false;
                this.githubAvailable = false;
              }
            } finally {
              this.storageStatusLoading = false;
            }
          },

          // 切换存储模式
          setStorageMode(mode) {
            const modeConfig = {
              telegram: { label: KVShared.STORAGE_TARGETS.telegram, available: true },
              r2: { label: KVShared.STORAGE_TARGETS.r2, available: this.r2Available },
              s3: { label: KVShared.STORAGE_TARGETS.s3, available: this.s3Available },
              discord: { label: KVShared.STORAGE_TARGETS.discord, available: this.discordAvailable },
              huggingface: { label: KVShared.STORAGE_TARGETS.huggingface, available: this.huggingfaceAvailable },
              github: { label: KVShared.STORAGE_TARGETS.github, available: this.githubAvailable },
            };

            const config = modeConfig[mode];
            if (!config) return;
            if (this.authChecking) return;

            // 访客只允许 telegram 和 r2
            if (this.isGuest && !["telegram", "r2"].includes(mode)) {
              this.showToast("访客模式仅支持 Telegram 和 R2 存储", "error");
              return;
            }

            if (!config.available && mode !== "telegram") {
              this.showToast(`${config.label}未配置或未启用`, "error");
              return;
            }

            this.storageMode = mode;
            this.storageTarget = config.label;
            localStorage.setItem("storageMode", mode);
            this.showToast(`已切换到 ${config.label}`, "success");
          },
        }),
        async mounted() {
          this.loadImageUploadDecision();
          this.loadImageCompressSettings();
          this.syncImageCompressState();
          this.detectImageCompressionSupport();

          try {
            this.folderPath = this.normalizeFolderPath(
              localStorage.getItem("uploadFolderPath") || "",
            );
          } catch (e) {
            this.folderPath = "";
          }

          // 检查认证状态（优先执行）
          const shouldContinue = await this.checkAuth();
          if (!shouldContinue) return;

          // 认证通过后再探测解析能力：未登录时该接口必然返回 401，没必要发
          this.loadMediaResolveStatus();

          // 检查存储目标
          await this.checkStorageTarget();

          // 读取后台已有上传目录，便于首页一键选择
          this.fetchUploadFolders();

          // 加载历史记录
          this.loadHistory();

          // 全局粘贴事件
          this.globalPasteHandler = async (e) => {
            const clipboardData = e.clipboardData;
            if (!clipboardData) return;

            const hasFilePayload =
              Array.from(clipboardData.files || []).length > 0 ||
              Array.from(clipboardData.items || []).some(
                (item) => item.kind === "file",
              );
            if (this.shouldIgnorePasteTarget(e.target) && !hasFilePayload) {
              return;
            }

            const files = this.extractFilesFromClipboardData(
              clipboardData,
              "paste",
            );

            if (files.length > 0) {
              e.preventDefault();
              await this.queuePastedFiles(files, "Ctrl/Cmd + V");
            }
          };
          document.addEventListener("paste", this.globalPasteHandler);

          // 键盘快捷键
          this.globalKeydownHandler = (e) => {
            // Ctrl+V 已通过 paste 事件处理
            // Escape 关闭预览
            if (e.key === "Escape" && this.previewData) {
              this.closePreview();
            }
          };
          document.addEventListener("keydown", this.globalKeydownHandler);
        },
        beforeDestroy() {
          if (this.globalPasteHandler) {
            document.removeEventListener("paste", this.globalPasteHandler);
          }
          if (this.globalKeydownHandler) {
            document.removeEventListener("keydown", this.globalKeydownHandler);
          }
          if (this.pasteUploadNoticeTimer) {
            clearTimeout(this.pasteUploadNoticeTimer);
          }
        },
      });
