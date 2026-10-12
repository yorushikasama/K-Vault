/** 前端 UI 设计设置面板的方法（自 admin-app.js 拆出）。只被 admin.html 加载。 */
/** 这些方法通过 this 访问页面状态（data 字段仍在 admin-app.js），
 *  由 admin-app.js 以 Object.assign 并入 methods。 */
(function () {
  "use strict";

  var methods = {
      // 登录页背景设置
            // 根据加载模式获取图片显示状态
      async uploadUiDesignBackgroundFile(file) {
        if (!file) return '';
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folderPath', this.folderPath || '');
        const response = await fetch(`${this.baseURL}/upload`, {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(payload) || !payload[0]?.src) {
          const message = Array.isArray(payload) ? payload[0]?.error : payload?.error;
          throw new Error(message || '上传失败');
        }
        return `${this.baseURL}${payload[0].src}`;
      },
      async showUiDesignSettingsPanel() {
        const manager = window.UIDesignManager;
        if (!manager || typeof manager.getSettings !== 'function') {
          this.$message.error('当前版本暂不支持前端 UI 设置。');
          return;
        }

        const requestUiConfigDirect = async (method, config) => {
          const url = method === 'GET'
            ? `/api/ui-config?_ts=${Date.now()}`
            : '/api/ui-config';
          const init = {
            method,
            credentials: 'include',
            headers: {
              Accept: 'application/json'
            }
          };
          if (method !== 'GET') {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify({ config });
          }

          const response = await fetch(url, init);
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.success === false) {
            const detail = payload?.error?.message || payload?.error || `请求失败 (${response.status})`;
            throw new Error(detail);
          }
          return payload;
        };

        const syncFromServerFallback = async () => {
          try {
            const payload = await requestUiConfigDirect('GET');
            const config = payload?.config || payload?.settings || {};
            if (typeof manager.setSettings === 'function') {
              manager.setSettings(config, { persist: true, silent: true });
            }
            return {
              success: true,
              source: 'server',
              settings: config,
              binding: payload?.binding || ''
            };
          } catch (error) {
            return {
              success: false,
              source: 'local',
              settings: manager.getSettings(),
              error: error?.message || String(error),
              binding: ''
            };
          }
        };

        const saveToServerFallback = async (values) => {
          const localApplied = typeof manager.setSettings === 'function'
            ? manager.setSettings(values, { persist: true, silent: true })
            : values;
          try {
            const payload = await requestUiConfigDirect('POST', localApplied);
            const config = payload?.config || payload?.settings || localApplied;
            const verifyPayload = await requestUiConfigDirect('GET');
            const verifiedConfig = verifyPayload?.config || verifyPayload?.settings || {};
            const isMatch = JSON.stringify(verifiedConfig) === JSON.stringify(config);
            if (!isMatch) {
              throw new Error('保存后回读校验失败，请检查 KV 绑定与 Functions 日志。');
            }
            if (typeof manager.setSettings === 'function') {
              manager.setSettings(verifiedConfig, { persist: true, silent: true });
            }
            return {
              success: true,
              source: 'server',
              settings: verifiedConfig,
              binding: verifyPayload?.binding || payload?.binding || ''
            };
          } catch (error) {
            return {
              success: false,
              source: 'local',
              settings: localApplied,
              error: error?.message || String(error),
              binding: ''
            };
          }
        };

        if (typeof manager.syncFromServer === 'function') {
          const syncResult = await manager.syncFromServer({
            silent: true,
            applyLocalOnFailure: true
          });
          if (syncResult && syncResult.success === false && syncResult.error) {
            this.$message.warning(`读取服务端配置失败，已使用本地缓存：${syncResult.error}`);
          }
        } else {
          const syncResult = await syncFromServerFallback();
          if (syncResult && syncResult.success === false && syncResult.error) {
            this.$message.warning(`读取服务端配置失败，已使用本地缓存：${syncResult.error}`);
          }
        }

        const snapshot = manager.getSettings();
        const defaults = typeof manager.getDefaults === 'function'
          ? manager.getDefaults()
          : manager.getSettings();

        const clamp = (value, min, max) => {
          const n = Number(value);
          if (!Number.isFinite(n)) return min;
          return Math.min(max, Math.max(min, n));
        };
        const escapeAttr = (value) =>
          String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const checked = (condition) => (condition ? 'checked' : '');

        const html = `
          <div class="ui-design-panel" id="uiDesignPanel">
            <div class="ui-design-head">
              <div>
                <div class="ui-design-title"><i data-lucide="palette"></i><span>前端 UI 设计</span></div>
                <div class="ui-design-subtitle">当前改动实时预览，点击保存后同步到所有设备。</div>
              </div>
            </div>

            <section class="ui-design-section">
              <div class="ui-design-section-title"><i data-lucide="image"></i> 背景图设置（全站）</div>
              <div class="ui-design-inline">
                <input id="uiGlobalBgUrl" class="ui-design-input" type="text" value="${escapeAttr(snapshot.globalBackgroundUrl)}" placeholder="请输入图片链接（https://example.com/background.jpg）">
              </div>
              <div class="ui-design-inline">
                <button type="button" id="uiUploadGlobalBtn" class="ui-upload-drop"><i data-lucide="cloud-upload"></i><span>上传图片</span></button>
                <input id="uiUploadGlobalInput" type="file" accept="image/*" class="hidden-file-input">
                <button type="button" id="uiClearGlobalBg" class="el-button el-button--small">清除</button>
              </div>
              <div class="ui-design-tip">将应用到首页、图片浏览、后台、WebDAV 及其他所有可见页面。</div>
            </section>

            <section class="ui-design-section">
              <div class="ui-design-section-title"><i data-lucide="log-in"></i> 登录页背景图</div>
              <div class="ui-segmented">
                <label class="ui-segment"><input type="radio" name="uiLoginMode" value="follow-global" ${checked(snapshot.loginBackgroundMode !== 'custom')}><span>与全站一致</span></label>
                <label class="ui-segment"><input type="radio" name="uiLoginMode" value="custom" ${checked(snapshot.loginBackgroundMode === 'custom')}><span>仅登录页单独设置</span></label>
              </div>
              <div class="ui-design-inline" id="uiLoginCustomRow">
                <input id="uiLoginBgUrl" class="ui-design-input" type="text" value="${escapeAttr(snapshot.loginBackgroundUrl)}" placeholder="请输入登录页背景图链接">
                <button type="button" id="uiUploadLoginBtn" class="ui-upload-drop"><i data-lucide="cloud-upload"></i><span>上传图片</span></button>
                <input id="uiUploadLoginInput" type="file" accept="image/*" class="hidden-file-input">
                <button type="button" id="uiClearLoginBg" class="el-button el-button--small">清除</button>
              </div>
            </section>

            <section class="ui-design-section">
              <div class="ui-design-section-title"><i data-lucide="copy"></i> 界面透明度</div>
              <div class="ui-design-range-wrap">
                <div class="ui-design-range-head">
                  <span>卡片透明度</span>
                  <span class="ui-design-value" id="uiCardOpacityValue"></span>
                </div>
                <input id="uiCardOpacity" class="ui-design-range" type="range" min="0" max="100" value="${clamp(snapshot.cardOpacity, 0, 100)}">
              </div>
              <div class="ui-design-range-wrap">
                <div class="ui-design-range-head">
                  <span>模糊强度</span>
                  <span class="ui-design-value" id="uiCardBlurValue"></span>
                </div>
                <input id="uiCardBlur" class="ui-design-range" type="range" min="0" max="32" value="${clamp(snapshot.cardBlur, 0, 32)}">
              </div>
            </section>

            <section class="ui-design-section">
              <div class="ui-design-section-title"><i data-lucide="audio-waveform"></i> 动态背景特效</div>
              <div class="ui-segmented">
                <label class="ui-segment"><input type="radio" name="uiEffectStyle" value="none" ${checked(snapshot.effectStyle !== 'texture')}><span>无特效</span></label>
                <label class="ui-segment"><input type="radio" name="uiEffectStyle" value="texture" ${checked(snapshot.effectStyle === 'texture')}><span>纸纹叠加</span></label>
              </div>
              <!-- 「数学符号」与「粒子网格」两档已删除。它们画在 z-index:-2 的
                   全屏 canvas 上，而 body 是不透明的 --ui-page-bg，所以画出来的
                   东西必然被完全盖住 —— 看不见，却要每秒 450 次 fillText。
                   纸纹是纯 CSS background-image，不吃主线程，所以保留。 -->
              <div class="ui-design-range-wrap">
                <div class="ui-design-range-head">
                  <span>特效强度</span>
                  <span class="ui-design-value" id="uiEffectIntensityValue"></span>
                </div>
                <input id="uiEffectIntensity" class="ui-design-range" type="range" min="0" max="100" value="${clamp(snapshot.effectIntensity, 0, 100)}">
              </div>
              <label class="ui-design-inline">
                <input id="uiOptimizeMobile" type="checkbox" ${checked(snapshot.optimizeMobile !== false)}>
                <span>移动端自动优化特效性能</span>
              </label>
              <div class="ui-design-tip">移动端会自动降低特效密度，减少 CPU 占用。</div>
            </section>

            <div class="ui-design-foot">
              <button type="button" id="uiResetDefaults" class="el-button el-button--small">恢复默认</button>
              <span id="uiSaveStatus" class="ui-design-save-status"></span>
            </div>
          </div>
        `;

        const readValues = () => {
          const loginMode =
            document.querySelector('input[name="uiLoginMode"]:checked')?.value ||
            'follow-global';
          const effectStyle =
            document.querySelector('input[name="uiEffectStyle"]:checked')?.value ||
            'none';
          return {
            baseColor: defaults.baseColor,
            globalBackgroundUrl: document.getElementById('uiGlobalBgUrl')?.value?.trim() || '',
            loginBackgroundMode: loginMode,
            loginBackgroundUrl: document.getElementById('uiLoginBgUrl')?.value?.trim() || '',
            cardOpacity: clamp(document.getElementById('uiCardOpacity')?.value, 0, 100),
            cardBlur: clamp(document.getElementById('uiCardBlur')?.value, 0, 32),
            effectStyle,
            effectIntensity: clamp(document.getElementById('uiEffectIntensity')?.value, 0, 100),
            optimizeMobile: !!document.getElementById('uiOptimizeMobile')?.checked
          };
        };

        const setSaveStatus = (state, text) => {
          const status = document.getElementById('uiSaveStatus');
          if (!status) return;
          status.setAttribute('data-state', state || '');
          status.textContent = text || '';
        };

        const updateValueLabels = () => {
          const opacityEl = document.getElementById('uiCardOpacityValue');
          const blurEl = document.getElementById('uiCardBlurValue');
          const intensityEl = document.getElementById('uiEffectIntensityValue');
          if (opacityEl) {
            opacityEl.textContent = `${Math.round(clamp(document.getElementById('uiCardOpacity')?.value, 0, 100))}%`;
          }
          if (blurEl) {
            blurEl.textContent = `${Math.round(clamp(document.getElementById('uiCardBlur')?.value, 0, 32))}px`;
          }
          if (intensityEl) {
            intensityEl.textContent = `${Math.round(clamp(document.getElementById('uiEffectIntensity')?.value, 0, 100))}%`;
          }
        };

        const toggleLoginCustomRow = () => {
          const loginMode =
            document.querySelector('input[name="uiLoginMode"]:checked')?.value ||
            'follow-global';
          const row = document.getElementById('uiLoginCustomRow');
          if (!row) return;
          const enabled = loginMode === 'custom';
          row.classList.toggle('is-disabled', !enabled);
        };

        const applyPreview = () => {
          updateValueLabels();
          toggleLoginCustomRow();
          const values = readValues();
          if (typeof manager.previewSettings === 'function') {
            manager.previewSettings(values);
          } else if (typeof manager.setSettings === 'function') {
            manager.setSettings(values, { persist: false, silent: true });
          }
          setSaveStatus('', '预览中：当前改动仅在本地生效，保存后全站同步。');
        };

        const applyValuesToForm = (values) => {
          const state = Object.assign({}, defaults, values || {});
          const globalUrl = document.getElementById('uiGlobalBgUrl');
          const loginUrl = document.getElementById('uiLoginBgUrl');
          const cardOpacity = document.getElementById('uiCardOpacity');
          const cardBlur = document.getElementById('uiCardBlur');
          const effectIntensity = document.getElementById('uiEffectIntensity');
          const optimizeMobile = document.getElementById('uiOptimizeMobile');
          if (globalUrl) globalUrl.value = state.globalBackgroundUrl || '';
          if (loginUrl) loginUrl.value = state.loginBackgroundUrl || '';
          if (cardOpacity) cardOpacity.value = clamp(state.cardOpacity, 0, 100);
          if (cardBlur) cardBlur.value = clamp(state.cardBlur, 0, 32);
          if (effectIntensity) effectIntensity.value = clamp(state.effectIntensity, 0, 100);
          if (optimizeMobile) optimizeMobile.checked = state.optimizeMobile !== false;
          const loginModeRadio = document.querySelector(`input[name="uiLoginMode"][value="${state.loginBackgroundMode === 'custom' ? 'custom' : 'follow-global'}"]`);
          if (loginModeRadio) loginModeRadio.checked = true;
          // 面板只剩「无特效」与「纸纹」两档；旧配置里存着的 math / particle
          // 不再有对应 radio，必须显式归到"无特效"，否则会出现三个都没选中
          // 的空白面板。
          const effectRadio = document.querySelector(`input[name="uiEffectStyle"][value="${state.effectStyle === 'texture' ? 'texture' : 'none'}"]`);
          if (effectRadio) effectRadio.checked = true;
        };

        const bindUpload = (triggerId, inputId, targetInputId) => {
          const trigger = document.getElementById(triggerId);
          const fileInput = document.getElementById(inputId);
          const targetInput = document.getElementById(targetInputId);
          if (!trigger || !fileInput || !targetInput) return;

          trigger.addEventListener('click', () => fileInput.click());
          fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            // duration:0 is right — a large upload has no predictable length — but
            // the notice used to have no close button either, so a stalled request
            // left a permanent 「正在上传背景图...」 that only a page reload could
            // clear. showClose gives the user an exit, and the counter distinguishes
            // "still working" from "hung".
            // Deliberately NO timeout here: a 100MB upload legitimately takes about
            // 3 minutes on this host, so any fixed cap would abort valid uploads.
            const startedAt = Date.now();
            const loading = this.$message({
              message: '正在上传背景图...',
              duration: 0,
              showClose: true
            });
            const loadingTicker = setInterval(() => {
              const seconds = Math.round((Date.now() - startedAt) / 1000);
              loading.message = `正在上传背景图... 已等待 ${seconds} 秒（大文件较慢，可关闭此提示）`;
            }, 1000);
            try {
              const url = await this.uploadUiDesignBackgroundFile(file);
              targetInput.value = url;
              applyPreview();
              this.$message.success('背景图上传成功。');
            } catch (error) {
              this.$message.error(`上传失败：${error.message || error}`);
            } finally {
              clearInterval(loadingTicker);
              loading.close();
              fileInput.value = '';
            }
          });
        };

        this.$alert(html, '前端 UI 设计', {
          customClass: 'ui-design-alert',
          dangerouslyUseHTMLString: true,
          showCancelButton: true,
          closeOnClickModal: false,
          confirmButtonText: '保存设置',
          cancelButtonText: '取消',
          beforeClose: (action, instance, done) => {
            if (action !== 'confirm') {
              if (typeof manager.restorePersisted === 'function') {
                manager.restorePersisted();
              }
              done();
              return;
            }

            const values = readValues();
            instance.confirmButtonLoading = true;
            instance.confirmButtonText = '保存中...';
            setSaveStatus('saving', '保存中...');

            const saveRequest = typeof manager.saveToServer === 'function'
              ? manager.saveToServer(values)
              : saveToServerFallback(values);

            saveRequest
              .then((result) => {
                instance.confirmButtonLoading = false;
                if (result?.success) {
                  instance.confirmButtonText = '✓ 已保存';
                  const bindingName = result?.binding ? `（KV: ${result.binding}）` : '';
                  setSaveStatus('success', `已保存并同步到服务端${bindingName}。`);
                  this.$message.success(`前端 UI 设置已保存并同步${bindingName}`);
                } else {
                  instance.confirmButtonText = '已本地保存';
                  setSaveStatus('warning', '服务端不可用，已保存到本地缓存。');
                  this.$message.warning(result?.error
                    ? `已本地保存，服务端同步失败：${result.error}`
                    : '已本地保存，服务端同步失败。');
                }
                window.setTimeout(() => done(), 260);
              })
              .catch((error) => {
                instance.confirmButtonLoading = false;
                instance.confirmButtonText = '保存设置';
                setSaveStatus('warning', '保存失败，请重试。');
                this.$message.error(`保存失败：${error.message || error}`);
              });
          }
        }).catch(() => {
          // $alert 带 showCancelButton：用户取消/关闭时 Promise 以 'cancel' 拒绝。
          // 取消已在 beforeClose 里恢复预览，这里只兜住拒绝，避免 unhandledrejection。
        });

        this.$nextTick(() => {
          applyValuesToForm(snapshot);
          updateValueLabels();
          toggleLoginCustomRow();
          applyPreview();

          const listenIds = [
            'uiGlobalBgUrl',
            'uiLoginBgUrl',
            'uiCardOpacity',
            'uiCardBlur',
            'uiEffectIntensity',
            'uiOptimizeMobile'
          ];
          listenIds.forEach((id) => {
            const node = document.getElementById(id);
            if (!node) return;
            node.addEventListener('input', applyPreview);
            node.addEventListener('change', applyPreview);
          });

          document
            .querySelectorAll('input[name="uiLoginMode"], input[name="uiEffectStyle"]')
            .forEach((node) => node.addEventListener('change', applyPreview));

          const clearGlobalBtn = document.getElementById('uiClearGlobalBg');
          if (clearGlobalBtn) {
            clearGlobalBtn.addEventListener('click', () => {
              const input = document.getElementById('uiGlobalBgUrl');
              if (input) input.value = '';
              applyPreview();
            });
          }

          const clearLoginBtn = document.getElementById('uiClearLoginBg');
          if (clearLoginBtn) {
            clearLoginBtn.addEventListener('click', () => {
              const input = document.getElementById('uiLoginBgUrl');
              if (input) input.value = '';
              applyPreview();
            });
          }

          const resetBtn = document.getElementById('uiResetDefaults');
          if (resetBtn) {
            resetBtn.addEventListener('click', () => {
              applyValuesToForm(defaults);
              applyPreview();
              setSaveStatus('', '已恢复默认预览，点击保存后全站生效。');
            });
          }

          bindUpload('uiUploadGlobalBtn', 'uiUploadGlobalInput', 'uiGlobalBgUrl');
          bindUpload('uiUploadLoginBtn', 'uiUploadLoginInput', 'uiLoginBgUrl');
        });
      },
  };

  window.KVAdminUiDesign = { methods: methods };
})();
