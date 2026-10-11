/** 浏览器内图片压缩管线的方法集（自 upload-app.js 拆出）。只被 index.html 加载。
 *
 * 覆盖格式支持探测、压缩参数读写、Canvas 压缩执行与上传前的逐项预处理；
 * 方法通过 this 访问页面状态（imageCompress、imageCompressFormats 等
 * 仍在 upload-app.js），由 upload-app.js 以 Object.assign 并入 methods。 */
(function () {
  "use strict";

  var methods = {
          getImageFormatConfig(format) {
            return (
              this.imageCompressFormats.find((item) => item.value === format) ||
              this.imageCompressFormats[0]
            );
          },
          isFormatSupported(format) {
            return this.imageCompress.support?.[format] !== false;
          },
          async detectImageCompressionSupport() {
            if (!document.createElement("canvas").toBlob) return;
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, 1, 1);
            }

            await Promise.all(
              this.imageCompressFormats.map(
                (format) =>
                  new Promise((resolve) => {
                    canvas.toBlob(
                      (blob) => {
                        const supported = !!blob && blob.type === format.mime;
                        this.$set(this.imageCompress.support, format.value, supported);
                        resolve();
                      },
                      format.mime,
                      0.82,
                    );
                  }),
              ),
            );

            if (!this.isFormatSupported(this.imageCompress.format)) {
              const fallback = this.imageCompressFormats.find((format) =>
                this.isFormatSupported(format.value),
              );
              if (fallback) this.imageCompress.format = fallback.value;
            }
          },
          loadImageCompressSettings() {
            try {
              const raw = localStorage.getItem("imageCompressSettings");
              if (!raw) return;
              const settings = JSON.parse(raw);
              if (typeof settings.enabled === "boolean") {
                this.imageCompress.enabled = settings.enabled;
              }
              if (settings.format) this.imageCompress.format = settings.format;
              if (settings.quality) this.imageCompress.quality = settings.quality;
              if (settings.maxDimension !== undefined) {
                this.imageCompress.maxDimension = settings.maxDimension;
              }
              if (typeof settings.keepOriginalWhenLarger === "boolean") {
                this.imageCompress.keepOriginalWhenLarger =
                  settings.keepOriginalWhenLarger;
              }
              this.normalizeImageCompressSettings();
            } catch (e) {}
          },
          syncImageCompressState() {
            if (this.imageUploadDecision === "optimized") {
              this.imageCompress.enabled = true;
            } else if (this.imageUploadDecision === "original") {
              this.imageCompress.enabled = false;
            }
          },
          normalizeImageCompressSettings() {
            const quality = Number(this.imageCompress.quality) || 82;
            const maxDimension = Number(this.imageCompress.maxDimension) || 0;
            this.imageCompress.quality = Math.min(95, Math.max(30, quality));
            this.imageCompress.maxDimension = Math.min(
              12000,
              Math.max(0, Math.round(maxDimension)),
            );
            if (
              !this.imageCompressFormats.some(
                (format) => format.value === this.imageCompress.format,
              )
            ) {
              this.imageCompress.format = "webp";
            }
          },
          saveImageCompressSettings() {
            this.normalizeImageCompressSettings();
            try {
              localStorage.setItem(
                "imageCompressSettings",
                JSON.stringify({
                  enabled: this.imageCompress.enabled,
                  format: this.imageCompress.format,
                  quality: this.imageCompress.quality,
                  maxDimension: this.imageCompress.maxDimension,
                  keepOriginalWhenLarger:
                    this.imageCompress.keepOriginalWhenLarger,
                }),
              );
            } catch (e) {}
          },
          handleImageCompressToggle() {
            if (this.imageCompress.enabled) {
              if (this.imageUploadDecision === "original") {
                this.imageUploadDecision = "optimized";
                try {
                  localStorage.setItem("kvault:image-upload-decision", "optimized");
                } catch (e) {}
              }
            } else if (this.imageUploadDecision === "optimized") {
              this.imageUploadDecision = "original";
              try {
                localStorage.setItem("kvault:image-upload-decision", "original");
              } catch (e) {}
            }
            this.saveImageCompressSettings();
          },
          selectCompressFormat(format) {
            if (!this.isFormatSupported(format)) return;
            this.imageCompress.format = format;
            this.saveImageCompressSettings();
          },
          snapshotImageCompressOptions(enabled) {
            this.normalizeImageCompressSettings();
            const format = this.getImageFormatConfig(this.imageCompress.format);
            return {
              enabled: !!enabled,
              format: format.value,
              quality: this.imageCompress.quality,
              maxDimension: this.imageCompress.maxDimension,
              keepOriginalWhenLarger: this.imageCompress.keepOriginalWhenLarger,
            };
          },
          isCompressibleImage(file) {
            const type = (file.type || "").toLowerCase();
            if (!type.startsWith("image/")) return false;
            return !["image/gif", "image/svg+xml"].includes(type);
          },
          replaceFileExtension(name, ext) {
            const safeExt = String(ext || "").replace(/^\./, "");
            if (!safeExt) return name;
            const base = String(name || "image").replace(/\.[^/.]+$/, "");
            return `${base}.${safeExt}`;
          },
          loadImageFromFile(file) {
            return new Promise((resolve, reject) => {
              const url = URL.createObjectURL(file);
              const image = new Image();
              image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
              };
              image.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("图片解码失败"));
              };
              image.src = url;
            });
          },
          canvasToBlob(canvas, mime, quality) {
            return new Promise((resolve, reject) => {
              if (!canvas.toBlob) {
                reject(new Error("当前浏览器不支持图片压缩"));
                return;
              }
              canvas.toBlob(
                (blob) => {
                  if (!blob) {
                    reject(new Error("图片压缩失败"));
                    return;
                  }
                  resolve(blob);
                },
                mime,
                quality,
              );
            });
          },
          async compressImageFile(file, options) {
            if (!options.enabled || !this.isCompressibleImage(file)) {
              return { file, changed: false };
            }

            const format = this.getImageFormatConfig(options.format);
            if (!this.isFormatSupported(format.value)) {
              return {
                file,
                changed: false,
                reason: `浏览器不支持输出 ${format.label}，已上传原图`,
              };
            }

            const image = await this.loadImageFromFile(file);
            const naturalWidth = image.naturalWidth || image.width;
            const naturalHeight = image.naturalHeight || image.height;
            if (!naturalWidth || !naturalHeight) {
              throw new Error("无法读取图片尺寸");
            }

            let width = naturalWidth;
            let height = naturalHeight;
            const maxDimension = Number(options.maxDimension) || 0;
            if (maxDimension > 0 && Math.max(width, height) > maxDimension) {
              const ratio = maxDimension / Math.max(width, height);
              width = Math.max(1, Math.round(width * ratio));
              height = Math.max(1, Math.round(height * ratio));
            }

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("无法创建图片处理画布");

            if (format.mime === "image/jpeg") {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, 0, width, height);
            }
            ctx.drawImage(image, 0, 0, width, height);

            const blob = await this.canvasToBlob(
              canvas,
              format.mime,
              options.quality / 100,
            );
            if (blob.type && blob.type !== format.mime) {
              return {
                file,
                changed: false,
                reason: `浏览器不支持输出 ${format.label}，已上传原图`,
              };
            }

            if (
              options.keepOriginalWhenLarger &&
              blob.size >= file.size
            ) {
              return {
                file,
                changed: false,
                reason: "压缩后体积未变小，已保留原图",
              };
            }

            const compressed = new File(
              [blob],
              this.replaceFileExtension(file.name, format.ext),
              {
                type: format.mime,
                lastModified: file.lastModified,
              },
            );

            return {
              file: compressed,
              changed: true,
              formatLabel: format.label,
              originalSize: file.size,
              outputSize: compressed.size,
              resized: width !== naturalWidth || height !== naturalHeight,
            };
          },
          async prepareUploadItem(item) {
            if (item.imageCompressionPrepared) return;
            item.imageCompressionPrepared = true;
            const options = item.imageCompressOptions || {
              enabled: false,
            };

            if (!options.enabled || !this.isCompressibleImage(item.originalFile)) {
              return;
            }

            const format = this.getImageFormatConfig(options.format);
            item.status = "processing";
            item.compressionStatus = `正在转换为 ${format.label}...`;

            try {
              const result = await this.compressImageFile(
                item.originalFile,
                options,
              );
              if (!result.changed) {
                item.compressionStatus = result.reason || "已跳过压缩";
                return;
              }

              item.file = result.file;
              item.name = result.file.name;
              item.size = result.file.size;
              if (item.preview) URL.revokeObjectURL(item.preview);
              item.preview = URL.createObjectURL(result.file);
              const saved = Math.max(
                0,
                result.originalSize - result.outputSize,
              );
              const resizedText = result.resized ? "，已调整尺寸" : "";
              item.compressionStatus = `已转为 ${result.formatLabel}，节省 ${this.formatSize(saved)}${resizedText}`;
            } catch (err) {
              console.warn("Image compression skipped:", err);
              item.compressionStatus = `压缩失败，已上传原图：${err.message}`;
            }
          },
  };

  window.KVUploadImage = { methods: methods };
})();
