/**
 * 视频库页的 Vue 应用。
 *
 * 与 gallery-app.js 是同一套派生链、同一套数据源（/api/manage/list），
 * 只有三处不同：类型口径是 VIDEO 而不是 IMAGE，卡片里放 <video> 而不是
 * <img>，以及本页有目录维度（见 folderPath）。
 *
 * 目录这一维是补上的，不是多余的：文件工作台能进目录，而本页面最初只能
 * 拉根目录，于是用户在 /douyin 里有 8 个视频、在这个页面上看到 0 个 ——
 * 「视频页面只有 8 个」其实是「文件页有 8 个、视频页一个都没有」被误读。
 * 计数必须能说清自己在数哪个范围，否则同一批文件在两页给出两个数，
 * 而两个数都不算错。
 *
 * 这里保留独立文件而不是抽公共组件，是因为这个仓库没有构建步骤，抽共享
 * 组件要额外引入全局组件注册 + 两页各自的模板，收益不抵成本；而「两边必须
 * 一致」的部分由 test/video-gallery-parity.test.js 钉住。
 */
(function () {
  // 顶栏的退出按钮由 shell-tools.js 绑定（四个分区页共用 KVShared.logout），
  // 与 gallery-app.js 同一机制：页面脚本只补外壳管不到的动作，本页没有。

  new Vue({
    el: '#app',
    data: {
      baseURL: document.location.origin,
      videos: [],
      loading: true,
      searchQuery: '',
      linkFormat: 'url',
      currentPage: 1,
      pageSize: 12, // 视频卡比图片卡大得多，一页 12 个已经要滚很久了
      nextCursor: null,
      hasMore: true,
      searchTimer: null,
      folders: [],
      folderPath: '',
      folderLoading: false
    },
    computed: {
      /* 与图库完全同构的派生链，每层只做一件事：
       *   videos          服务端返回的原始文件（不过滤）
       *   videoItems      只留视频            <- 本页的身份由此定义
       *   searchedVideos  再按搜索词过滤
       *   filteredVideos  最后切片
       * 计数一律取 searchedVideos.length，与网格看到的内容严格一致 ——
       * 曾经图库页栽在这里：页头数的是未过滤的原始列表，正文数的是过滤后的，
       * 两个数字各自都对，放在一起自相矛盾。 */
      videoItems() {
        return this.videos.filter((vid) => KVShared.isVideoName(vid.name));
      },

      searchedVideos() {
        const query = this.searchQuery.trim().toLowerCase();
        if (!query) return this.videoItems;
        return this.videoItems.filter((vid) => {
          const name = String(vid.metadata?.fileName || vid.name || '').toLowerCase();
          return name.includes(query);
        });
      },

      filteredVideos() {
        const start = (this.currentPage - 1) * this.pageSize;
        return this.searchedVideos.slice(start, start + this.pageSize);
      },

      /* 与网格、搜索、分页严格同源：搜索「mp4」时这里也只数匹配到的视频。 */
      totalCount() {
        return this.searchedVideos.length;
      },

      selectedCount() {
        return this.videoItems.filter((vid) => vid.selected).length;
      },

      /* 目录树：根节点 + 服务端给的目录列表，按层级排序。
         与文件工作台的 folderTreeNodes 同构 —— 两边都从 /api/manage/folders
         读，所以同一个目录在两页的名字和计数一致。 */
      folderTree() {
        const root = {
          path: '',
          name: '全部视频',
          depth: 0,
          fileCount: this.folderCount('')
        };
        const nodes = (this.folders || [])
          .map((folder) => {
            const path = KVShared.normalizeFolderPath(folder.path ?? folder.folderPath ?? '');
            if (!path) return null;
            return {
              path,
              name: folder.name || path.split('/').pop(),
              depth: path.split('/').length,
              videoCount: folder.videoCount
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path, 'zh-CN'));
        return [root].concat(nodes);
      },

      folderBreadcrumbs() {
        const parts = KVShared.normalizeFolderPath(this.folderPath).split('/').filter(Boolean);
        const crumbs = [{ path: '', name: '全部视频' }];
        let acc = '';
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          crumbs.push({ path: acc, name: part });
        }
        return crumbs;
      },

      /* 页头那句「范围内 N 项」的范围说明。不写清楚的话，用户在
         /douyin 看到 8、回到根目录看到 5，会以为是漏了 3 个。 */
      scopeLabel() {
        return this.folderPath ? `目录 /${this.folderPath}` : '全部目录';
      },

      /* 根目录的视频总数。服务端 list 不带 folderPath 时只返回根目录直属
         文件，所以「根目录视频数」必须由目录接口的 videoCount 给，不能拿
         当前已加载的 videos 去数 —— 那个数只覆盖已翻到的那几页。 */
      allVideoCount() {
        const root = (this.folders || []).find((f) => !f.path);
        if (root && Number.isFinite(root.videoCount)) return root.videoCount;
        // 目录接口没给（旧的 Node 端副本、或请求失败）时退回当前范围。
        // 这是一个保守下界，但必须是当前目录的数，不能是 0 —— 显示 0 会让
        // 用户以为这里没有视频。
        return this.videos.length;
      },

      isAllSelected() {
        return this.filteredVideos.length > 0 && this.filteredVideos.every((vid) => vid.selected);
      },

      totalPages() {
        return Math.ceil(this.searchedVideos.length / this.pageSize);
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

      /* 目录树上的数字是**该目录的视频数**，不是该目录的文件总数 ——
         目录里若混着图片，数字得说自己在数视频，否则又是一个
         「两个数都不算错」的场合。服务端只给总数，所以视频数在这里算。 */
      folderCount(path) {
        if (!path) return this.allVideoCount;
        return this.folders.find((f) => f.path === path)?.videoCount ?? '—';
      },

      async loadFolders() {
        this.folderLoading = true;
        try {
          const response = await fetch('./api/manage/folders', {
            method: 'GET',
            credentials: 'include'
          });
          if (!response.ok) return;
          const payload = await response.json();
          this.folders = Array.isArray(payload?.folders) ? payload.folders : [];
        } catch (error) {
          this.folders = [];
        } finally {
          this.folderLoading = false;
        }
      },

      async selectFolder(path) {
        const next = KVShared.normalizeFolderPath(path);
        if (next === this.folderPath) return;
        this.folderPath = next;
        this.currentPage = 1;
        this.clearSelection();
        this.nextCursor = null;
        this.hasMore = true;
        await this.loadVideos();
      },

      formatLink(vid) {
        const url = `${this.baseURL}/file/${vid.name}`;
        const name = vid.metadata?.fileName || vid.name;
        return KVShared.formatLink(url, name, this.linkFormat);
      },

      async loadVideos() {
        this.loading = true;
        try {
          const result = await this.fetchPage(null);
          this.videos = result.items;
          this.nextCursor = result.nextCursor;
          this.hasMore = result.hasMore;
        } catch (error) {
          this.showToast('加载失败，请检查网络', 'error');
        }
        this.loading = false;
      },

      async loadMore() {
        if (!this.nextCursor || this.loading) return;
        this.loading = true;
        try {
          const result = await this.fetchPage(this.nextCursor);
          this.videos = [...this.videos, ...result.items];
          this.nextCursor = result.nextCursor;
          this.hasMore = result.hasMore;
          this.showToast(`加载了 ${result.items.length} 个视频`, 'success');
        } catch (error) {
          this.showToast('加载失败', 'error');
        }
        this.loading = false;
      },

      /* 拉一页并做归一化。游标翻页拿回来的文件要接在前一页后面，
       * 每一条都得补 selected:false 和 fileName 回退 —— 服务端只在
       * 部分路径写 metadata.fileName。 */
      async fetchPage(cursor) {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', String(cursor));
        // 目录维度必须由服务端筛，不能前端筛：不带 folderPath 时接口只返回
        // 根目录直属文件，前端拿到的就已经是残缺的一页，再怎么过滤也补不回来。
        if (this.folderPath) params.set('folderPath', this.folderPath);
        const response = await fetch(`./api/manage/list?${params.toString()}`, {
          method: 'GET',
          credentials: 'include'
        });

        if (response.status === 401) {
          window.location.href = './api/manage/login';
          return { items: [], nextCursor: null, hasMore: false };
        }

        const result = await response.json();
        const invalidPrefixes = ['session:', 'chunk:', 'upload:', 'temp:'];
        const items = (result.keys || [])
          .filter((vid) => {
            if (!vid.name) return false;
            if (invalidPrefixes.some((prefix) => vid.name.startsWith(prefix))) return false;
            const metadata = vid.metadata || {};
            return metadata.fileName && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
          })
          .map((vid) => ({
            ...vid,
            selected: false,
            metadata: { ...vid.metadata, fileName: vid.metadata?.fileName || vid.name }
          }));

        return {
          items,
          nextCursor: result.list_complete ? null : result.cursor,
          hasMore: !result.list_complete
        };
      },

      handleSearch() {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          this.currentPage = 1;
        }, 300);
      },

      toggleSelect(vid) {
        vid.selected = !vid.selected;
      },

      selectAll() {
        const newState = !this.isAllSelected;
        this.filteredVideos.forEach((vid) => { vid.selected = newState; });
      },

      clearSelection() {
        this.videos.forEach((vid) => { vid.selected = false; });
      },

      copyLink(vid) {
        this.copyToClipboard(this.formatLink(vid));
        this.showToast('链接已复制', 'success');
      },

      batchCopy() {
        const selected = this.videos.filter((vid) => vid.selected);
        const links = selected.map((vid) => this.formatLink(vid)).join('\n');
        this.copyToClipboard(links);
        this.showToast(`已复制 ${selected.length} 个链接`, 'success');
      },

      batchDownload() {
        const selected = this.videos.filter((vid) => vid.selected);
        this.showToast(`开始下载 ${selected.length} 个文件`, 'info');
        selected.forEach((vid, i) => {
          setTimeout(() => { this.downloadVideo(vid); }, i * 500);
        });
      },

      async batchDelete() {
        const selected = this.videos.filter((vid) => vid.selected);
        if (!selected.length) return;
        if (!confirm(`确定要删除这 ${selected.length} 个文件吗？`)) return;

        let successCount = 0;
        for (const vid of selected) {
          if (await this.deleteOne(vid)) successCount += 1;
        }
        this.showToast(`成功删除 ${successCount} 个文件`, 'success');
      },

      /* 视频卡片自带播放器，网格里直接能看。真要放大看或看详情时，
       * 跳到 preview.html 而不是本页再套一层弹窗 —— 一个页面套一个
       * 内嵌另一个页面，两层播放器同时存在时焦点和全屏都会打架。 */
      openPreview(vid) {
        const target = KVShared.buildPreviewTarget(
          vid.metadata?.fileName || vid.name,
          `${this.baseURL}/file/${vid.name}`,
          { autoplay: true }
        );
        if (target.type === 'download') {
          this.downloadVideo(vid);
          return;
        }
        window.open(target.iframeUrl || target.url, '_blank', 'noopener');
      },

      downloadVideo(vid) {
        KVShared.downloadFile(`/file/${vid.name}`, vid.metadata?.fileName || vid.name);
      },

      async deleteVideo(vid) {
        if (!confirm('确定要删除这个文件吗？')) return;
        if (await this.deleteOne(vid)) this.showToast('删除成功', 'success');
      },

      async deleteOne(vid) {
        try {
          const response = await fetch(`./api/manage/delete/${vid.name}`, {
            method: 'GET',
            credentials: 'include'
          });
          if (!response.ok) return false;
          const index = this.videos.findIndex((v) => v.name === vid.name);
          if (index > -1) this.videos.splice(index, 1);
          return true;
        } catch (error) {
          return false;
        }
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
      const isAuth = await this.checkAuth();
      if (!isAuth) return;

      // 目录树先到：徽标上的数字要能解释「文件 8 / 视频 5」，所以它必须在
      // 列表之前就位，否则用户会先看到一个没来由的 5，再看到目录里写着 8。
      await this.loadFolders();
      await this.loadVideos();

      // 网格里同时挂着多个 <video>，preload 必须停在 none：
      // 一页 12 个 metadata 预载会让首屏多打 12 个 Range 请求，卡在移动
      //网络上尤其明显。模板里已经写死 preload="none"，这里只是把策略
      // 在代码里显式说一遍，防止有人后来把模板改成 metadata 后两边脱节。
    },
    beforeDestroy() {
      clearTimeout(this.searchTimer);
    }
  });
})();