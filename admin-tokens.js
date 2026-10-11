/** API Token 管理的方法集（自 admin-app.js 拆出）。只被 admin.html 加载。 */
/** 这些方法通过 this 访问页面状态（data 字段仍在 admin-app.js），
 *  由 admin-app.js 以 Object.assign 并入 methods。 */
(function () {
  "use strict";

  var methods = {
      tokenScopeTagType(scopeName = '') {
        const map = {
          upload: '',
          read: 'success',
          delete: 'danger',
          paste: 'warning',
        };
        return map[String(scopeName || '').toLowerCase()] || 'info';
      },
      formatDateTime(timestamp) {
        const value = Number(timestamp || 0);
        if (!Number.isFinite(value) || value <= 0) return '-';
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
      },
      formatRelativeTime(timestamp) {
        const value = Number(timestamp || 0);
        if (!Number.isFinite(value) || value <= 0) return '从未';
        const diff = Date.now() - value;
        const minute = 60 * 1000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (diff < minute) return '刚刚';
        if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
        if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
        if (diff < day * 30) return `${Math.floor(diff / day)} 天前`;
        return this.formatDateTime(value);
      },
      openApiTokenDialog() {
        this.tokenDialogVisible = true;
        this.loadApiTokens();
      },
      openCreateTokenDialog() {
        this.tokenForm = {
          name: '',
          scopes: ['upload', 'read'],
          expiryPreset: 'never',
          customExpiresAt: '',
          allowedStorages: [],
          folderPrefix: '',
          maxFileSizeMb: 0,
        };
        this.createTokenDialogVisible = true;
      },
      resolveTokenExpiresAt() {
        const preset = String(this.tokenForm.expiryPreset || 'never');
        if (preset === '7d') return Date.now() + 7 * 24 * 3600 * 1000;
        if (preset === '30d') return Date.now() + 30 * 24 * 3600 * 1000;
        if (preset === '90d') return Date.now() + 90 * 24 * 3600 * 1000;
        if (preset === 'custom') {
          const custom = Number(this.tokenForm.customExpiresAt || 0);
          return Number.isFinite(custom) && custom > Date.now() ? custom : null;
        }
        return null;
      },
      async loadApiTokens() {
        this.tokenLoading = true;
        try {
          const response = await fetch('./api/admin/tokens', {
            method: 'GET',
            credentials: 'include',
          });
          const payload = await response.json();
          if (!response.ok || !payload?.success) {
            throw new Error(payload?.error?.message || payload?.message || '加载 Token 列表失败。');
          }
          this.apiTokens = Array.isArray(payload.tokens) ? payload.tokens : [];
        } catch (error) {
          this.$message.error(error.message || '加载 API Token 失败。');
        } finally {
          this.tokenLoading = false;
        }
      },
      async createApiToken() {
        const name = String(this.tokenForm.name || '').trim();
        const scopes = Array.isArray(this.tokenForm.scopes) ? this.tokenForm.scopes : [];
        if (!name) {
          this.$message.warning('请输入 Token 名称。');
          return;
        }
        if (scopes.length === 0) {
          this.$message.warning('请至少选择一个权限。');
          return;
        }
        const expiresAt = this.resolveTokenExpiresAt();
        if (String(this.tokenForm.expiryPreset) === 'custom' && !expiresAt) {
          this.$message.warning('请选择有效的未来过期时间。');
          return;
        }
        this.tokenCreateLoading = true;
        try {
          const response = await fetch('./api/admin/tokens', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name,
              scopes,
              expiresAt,
              policies: this.buildTokenPolicies(),
            }),
          });
          const payload = await response.json();
          if (!response.ok || !payload?.success) {
            throw new Error(payload?.error?.message || payload?.message || '创建 Token 失败。');
          }
          this.createTokenDialogVisible = false;
          this.createdTokenValue = String(payload.token || '');
          this.createdTokenCopied = false;
          this.createdTokenDialogVisible = true;
          await this.loadApiTokens();
        } catch (error) {
          this.$message.error(error.message || '创建 Token 失败。');
        } finally {
          this.tokenCreateLoading = false;
        }
      },
      async copyCreatedTokenValue() {
        const token = String(this.createdTokenValue || '');
        if (!token) return;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(token);
          } else {
            this.copyToClipboardFallback(token);
          }
          this.createdTokenCopied = true;
        } catch {
          this.copyToClipboardFallback(token);
          this.createdTokenCopied = true;
        }
      },
      async toggleApiTokenEnabled(token) {
        const tokenId = token?.id;
        if (!tokenId) return;
        const nextEnabled = Boolean(token.enabled);
        this.$set(this.tokenMutatingMap, tokenId, true);
        try {
          const response = await fetch(`./api/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextEnabled }),
          });
          const payload = await response.json();
          if (!response.ok || !payload?.success) {
            throw new Error(payload?.error?.message || payload?.message || '更新 Token 状态失败。');
          }
          this.$message.success(nextEnabled ? 'Token 已启用。' : 'Token 已禁用。');
        } catch (error) {
          token.enabled = !nextEnabled;
          this.$message.error(error.message || '更新 Token 状态失败。');
        } finally {
          this.$delete(this.tokenMutatingMap, tokenId);
        }
      },
      async removeApiToken(token) {
        const tokenId = token?.id;
        if (!tokenId) return;
        try {
          await this.$confirm(`确认删除 Token「${token.name}」吗？`, '删除确认', {
            type: 'warning',
            confirmButtonText: '删除',
            cancelButtonText: '取消',
          });
        } catch {
          return;
        }

        this.$set(this.tokenMutatingMap, tokenId, true);
        try {
          const response = await fetch(`./api/admin/tokens/${encodeURIComponent(tokenId)}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          const payload = await response.json();
          if (!response.ok || !payload?.success) {
            throw new Error(payload?.error?.message || payload?.message || '删除 Token 失败。');
          }
          this.apiTokens = this.apiTokens.filter((item) => item.id !== tokenId);
          this.$message.success('Token 已删除。');
        } catch (error) {
          this.$message.error(error.message || '删除 Token 失败。');
        } finally {
          this.$delete(this.tokenMutatingMap, tokenId);
        }
      },
      buildTokenPolicies() {
        const policies = {};
        const storages = Array.isArray(this.tokenForm.allowedStorages)
          ? this.tokenForm.allowedStorages.filter(Boolean)
          : [];
        if (storages.length > 0) policies.allowedStorages = storages;
        const folderPrefix = String(this.tokenForm.folderPrefix || '').trim();
        if (folderPrefix) policies.folderPrefix = folderPrefix;
        const maxMb = Number(this.tokenForm.maxFileSizeMb || 0);
        if (Number.isFinite(maxMb) && maxMb > 0) policies.maxFileSize = Math.round(maxMb * 1024 * 1024);
        return Object.keys(policies).length > 0 ? policies : null;
      },
      async rotateApiToken(token) {
        const tokenId = token?.id;
        if (!tokenId) return;
        try {
          await this.$confirm(
            `确认轮换 Token「${token.name}」吗？旧 Secret 将立即失效，新 Secret 只展示一次。`,
            '轮换确认',
            { type: 'warning', confirmButtonText: '轮换', cancelButtonText: '取消' }
          );
        } catch {
          return;
        }
        this.$set(this.tokenMutatingMap, tokenId, true);
        try {
          const response = await fetch(`./api/admin/tokens/${encodeURIComponent(tokenId)}/rotate`, {
            method: 'POST',
            credentials: 'include',
          });
          const payload = await response.json();
          if (!response.ok || !payload?.success) {
            throw new Error(payload?.error?.message || payload?.message || '轮换 Token 失败。');
          }
          this.createdTokenValue = String(payload.token || '');
          this.createdTokenCopied = false;
          this.createdTokenDialogVisible = true;
          await this.loadApiTokens();
        } catch (error) {
          this.$message.error(error.message || '轮换 Token 失败。');
        } finally {
          this.$delete(this.tokenMutatingMap, tokenId);
        }
      },
  };

  window.KVAdminTokens = { methods: methods };
})();
