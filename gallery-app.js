/** 图库页的 Vue 应用（自 gallery.html 内联脚本拆出；含顶栏退出接线）。 */
    // 顶栏的退出按钮。这段在 new Vue 之前，与 Vue 实例无关——
    // 外壳由 theme-core.js 维护，页面脚本只补它管不到的那个动作。
    (function () {
      var logoutBtn = document.getElementById('logoutBtn');
      if (!logoutBtn) return;
      logoutBtn.addEventListener('click', function () {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
          .catch(function () { /* 忽略：下面照样跳转，别把用户困在已登出的页面 */ })
          .then(function () { window.location.href = '/login.html'; });
      });
    })();

    new Vue({
      el: '#app',
      data: {
        baseURL: document.location.origin,
        images: [],
        loading: true,
        searchQuery: '',
        linkFormat: 'url',
        currentPage: 1,
        pageSize: 30,
        nextCursor: null,
        hasMore: true,
        previewData: null,  // 新的预览数据对象
        searchTimer: null
      },
      computed: {
        /* 图库 = 只看图片，全页只有一个口径。
         *
         * 此前这里有三处各自重写「是不是图片」和「匹配不匹配搜索」：
         * filteredImages 一份、totalPages 一份，而 totalCount 用的
         * images.length —— 一份**不过滤**的原始列表。于是同一批文件被数了
         * 两遍且结果不同：存了 6 个非图片文件时，页头写「总数 6」而正文写
         * 「没有找到图片」，两个数字都在自己的逻辑里是对的，放在一起就是
         * 自相矛盾。用户看到的正是这个。
         *
         * 现在收敛成一条派生链，每一层只做一件事：
         *   images            服务端返回的原始文件（不过滤）
         *   imageItems        只留图片          <- 图库的身份由此定义
         *   searchedImages    再按搜索词过滤
         *   pagedImages       最后切片
         * 计数一律取 searchedImages.length，与网格看到的内容严格一致。 */
        imageItems() {
          return this.images.filter((img) => KVShared.isImageName(img.name));
        },

        searchedImages() {
          const query = this.searchQuery.trim().toLowerCase();
          if (!query) return this.imageItems;
          return this.imageItems.filter((img) => {
            const name = String(img.metadata?.fileName || img.name || '').toLowerCase();
            return name.includes(query);
          });
        },

        filteredImages() {
          const start = (this.currentPage - 1) * this.pageSize;
          return this.searchedImages.slice(start, start + this.pageSize);
        },

        /* 与网格、搜索、分页严格同源：搜索「png」时这里也只数匹配到的图片，
           不再出现「总数 6 / 搜索结果 1」这种对不上的情况。 */
        totalCount() {
          return this.searchedImages.length;
        },

        selectedCount() {
          return this.imageItems.filter((img) => img.selected).length;
        },

        isAllSelected() {
          return this.filteredImages.length > 0 && this.filteredImages.every((img) => img.selected);
        },

        totalPages() {
          return Math.ceil(this.searchedImages.length / this.pageSize);
        },
        displayPages() {
          const pages = [];
          const total = this.totalPages;
          const current = this.currentPage;
          
          let start = Math.max(1, current - 2);
          let end = Math.min(total, current + 2);
          
          if (end - start < 4) {
            if (start === 1) end = Math.min(5, total);
            else if (end === total) start = Math.max(1, total - 4);
          }
          
          for (let i = start; i <= end; i++) {
            pages.push(i);
          }
          return pages;
        }
      },
      methods: {
        extOf(name) {
          return String(name || '').split('.').pop().toLowerCase();
        },

        /* 能不能用 <img> 直接显示。RAW / PSD / tiff / heic / jxl 是图片，
           浏览器解不了码 —— 图库里给占位卡而不是碎图。 */
        canView(img) {
          return KVShared.isViewableImage(img.name);
        },

        async loadImages() {
          this.loading = true;
          try {
            const response = await fetch('./api/manage/list?limit=100', {
              method: 'GET',
              credentials: 'include'
            });
            
            if (response.status === 401) {
              window.location.href = './api/manage/login';
              return;
            }

            const result = await response.json();
            const invalidPrefixes = ['session:', 'chunk:', 'upload:', 'temp:'];
            const filtered = (result.keys || []).filter(img => {
              if (!img.name) return false;
              if (invalidPrefixes.some(prefix => img.name.startsWith(prefix))) return false;
              const metadata = img.metadata || {};
              return metadata.fileName && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
            });
            this.images = filtered.map(img => ({
              ...img,
              selected: false,
              metadata: {
                ...img.metadata,
                fileName: img.metadata?.fileName || img.name
              }
            }));
            this.nextCursor = result.list_complete ? null : result.cursor;
            this.hasMore = !result.list_complete;
          } catch (error) {
            this.showToast('加载失败，请检查网络', 'error');
          }
          this.loading = false;
        },

        async loadMore() {
          if (!this.nextCursor || this.loading) return;
          this.loading = true;
          try {
            const response = await fetch(`./api/manage/list?limit=100&cursor=${encodeURIComponent(this.nextCursor)}`, {
              method: 'GET',
              credentials: 'include'
            });
            const result = await response.json();
            const invalidPrefixes = ['session:', 'chunk:', 'upload:', 'temp:'];
            const filtered = (result.keys || []).filter(img => {
              if (!img.name) return false;
              if (invalidPrefixes.some(prefix => img.name.startsWith(prefix))) return false;
              const metadata = img.metadata || {};
              return metadata.fileName && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
            });
            const newImages = filtered.map(img => ({
              ...img,
              selected: false,
              metadata: {
                ...img.metadata,
                fileName: img.metadata?.fileName || img.name
              }
            }));
            this.images = [...this.images, ...newImages];
            this.nextCursor = result.list_complete ? null : result.cursor;
            this.hasMore = !result.list_complete;
            this.showToast(`加载了 ${newImages.length} 张图片`, 'success');
          } catch (error) {
            this.showToast('加载失败', 'error');
          }
          this.loading = false;
        },

        handleSearch() {
          clearTimeout(this.searchTimer);
          this.searchTimer = setTimeout(() => {
            this.currentPage = 1;
          }, 300);
        },

        toggleSelect(img) {
          img.selected = !img.selected;
        },

        selectAll() {
          const newState = !this.isAllSelected;
          this.filteredImages.forEach(img => img.selected = newState);
        },

        clearSelection() {
          this.images.forEach(img => img.selected = false);
        },

        formatLink(img) {
          const url = `${this.baseURL}/file/${img.name}`;
          const name = img.metadata?.fileName || img.name;
          return KVShared.formatLink(url, name, this.linkFormat);
        },

        copyLink(img) {
          const link = this.formatLink(img);
          this.copyToClipboard(link);
          this.showToast('链接已复制', 'success');
        },

        batchCopy() {
          const selected = this.images.filter(img => img.selected);
          const links = selected.map(img => this.formatLink(img)).join('\n');
          this.copyToClipboard(links);
          this.showToast(`已复制 ${selected.length} 个链接`, 'success');
        },

        batchDownload() {
          const selected = this.images.filter(img => img.selected);
          this.showToast(`开始下载 ${selected.length} 个文件`, 'info');
          selected.forEach((img, i) => {
            setTimeout(() => {
              this.downloadImage(img);
            }, i * 500);
          });
        },

        async batchDelete() {
          const selected = this.images.filter(img => img.selected);
          if (!confirm(`确定要删除这 ${selected.length} 个文件吗？`)) return;
          
          let successCount = 0;
          for (const img of selected) {
            try {
              const response = await fetch(`./api/manage/delete/${img.name}`, {
                method: 'GET',
                credentials: 'include'
              });
              if (response.ok) {
                const index = this.images.findIndex(i => i.name === img.name);
                if (index > -1) this.images.splice(index, 1);
                successCount++;
              }
            } catch (e) {}
          }
          this.showToast(`成功删除 ${successCount} 个文件`, 'success');
        },

        previewImage(img) {
          // 构造绝对直链 URL（必须是完整的 https:// 链接）
          const fileUrl = `${this.baseURL}/file/${img.name}`;
          const fileName = img.metadata?.fileName || img.name;
          const target = KVShared.buildPreviewTarget(fileName, fileUrl, { autoplay: true });
          if (target.type === 'download') {
            // 其他类型（.zip, .exe 等）- 直接下载
            this.downloadImage(img);
            return;
          }
          this.previewData = target;
        },

        // 关闭预览并销毁 iframe
        closePreview() {
          if (this.$refs.previewIframe) {
            this.$refs.previewIframe.src = 'about:blank';
          }
          this.previewData = null;
        },

        // 复制预览链接
        copyPreviewLink() {
          if (this.previewData) {
            this.copyToClipboard(this.previewData.url);
            this.showToast('链接已复制', 'success');
          }
        },

        downloadImage(img) {
          KVShared.downloadFile(`/file/${img.name}`, img.metadata?.fileName || img.name);
        },

        async deleteImage(img, index) {
          if (!confirm('确定要删除这个文件吗？')) return;
          try {
            const response = await fetch(`./api/manage/delete/${img.name}`, {
              method: 'GET',
              credentials: 'include'
            });
            if (response.ok) {
              const realIndex = this.images.findIndex(i => i.name === img.name);
              if (realIndex > -1) this.images.splice(realIndex, 1);
              this.showToast('删除成功', 'success');
            } else {
              throw new Error('删除失败');
            }
          } catch (error) {
            this.showToast('删除失败', 'error');
          }
        },

        handleImageError(event, img) {
          event.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23f0f0f0" width="100" height="100"/><text x="50" y="55" text-anchor="middle" fill="%23999" font-size="12">加载失败</text></svg>';
        },

        copyToClipboard(text) {
          return KVShared.copyToClipboard(text);
        },

        showToast(message, type = 'info') {
          KVShared.toast(message, type);
        },

        async checkAuth() {
          return KVShared.ensureAuth({ loginPath: '/login.html' });
        }
      },
      async mounted() {
        // 先检查认证
        const isAuth = await this.checkAuth();
        if (!isAuth) return;

        this.loadImages();

        // 键盘快捷键。处理函数挂在实例上，否则是个拿不到引用的匿名箭头函数，
        // beforeDestroy 里无从解绑。
        this.handleGlobalKeydown = (e) => {
          if (e.key === 'Escape' && this.previewData) {
            this.closePreview();
          }
        };
        document.addEventListener('keydown', this.handleGlobalKeydown);
      },
      beforeDestroy() {
        if (this.handleGlobalKeydown) {
          document.removeEventListener('keydown', this.handleGlobalKeydown);
          this.handleGlobalKeydown = null;
        }
        clearTimeout(this.searchTimer);
      }
    });
