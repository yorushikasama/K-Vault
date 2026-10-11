/** 旧版图床管理的 Vue 应用（自 admin-imgtc.html 内联脚本拆出，逻辑保持原样）。 */
  new Vue({
    el: '#app',
    data: {
      baseURL: document.location.origin,
      Number: 0,
      totalCount: 0,
      fileConfig: {
        image: {
          name: '图片',
          exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'ico', 'svg', 'heic', 'heif', 'avif'],
          icon: 'image',
          count: 0
        },
        video: {
          name: '视频',
          exts: ['mp4', 'webm', 'ogg', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'm4v', '3gp', 'ts'],
          icon: 'video',
          count: 0
        },
        audio: {
          name: '音频',
          exts: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'ape', 'opus'],
          icon: 'music',
          count: 0
        },
        document: {
          name: '文件',
          exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'zip', 'rar', '7z', 'tar', 'gz', 'exe', 'apk', 'dmg', 'iso', 'msi', 'deb', 'rpm', 'json', 'xml', 'csv', 'sql', 'html', 'css', 'js', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h'],
          icon: 'folder-open',
          count: 0
        }
      },
      uploadConfig: {
        maxSize: 20 * 1024 * 1024,  // 最大上传20MB
        maxConcurrent: 3
      },
        tableData: [],
        nextCursor: null,
      isLoadingMore: false,
      search: '',
      currentPage: 1,
      pageSize: 15,
      selectedFiles: [],
      sortOption: 'dateDesc',
      filterOption: 'all',
      fileType: 'image',
      // 失效检测（checkBrokenFiles 在 admin-shared）所需状态
      pageDisposed: false,
      brokenCheckSeq: 0,
      brokenCheckController: null,
      brokenCheckMessage: null,
      quickWebsites: [
        { name: '上传中心', url: './', icon: 'cloud-upload' },
        { name: '图片浏览', url: './gallery.html', icon: 'images' },
        { name: 'Movavi', url: 'https://www.movavi.com/zh/movavi-video-converter.html', icon: 'file-video-camera' },
        { name: 'FreeConvert', url: 'https://www.freeconvert.com/zh/video-compressor', icon: 'file' },
        { name: 'YouCompress', url: 'https://www.youcompress.com/zh-cn/', icon: 'file-archive' },
        { name: 'Cloudinary', url: 'https://console.cloudinary.com/', icon: 'cloud' },
      ],
    },
    computed: Object.assign({}, window.KVAdminShared.computed, {
      filteredTableData() {
        return this.tableData.filter(data => {
          // 搜索匹配
          const searchLower = this.search.toLowerCase();
          const matchesSearch = !searchLower || [
            (data.metadata.fileName || '').toLowerCase(),
            data.name?.toLowerCase(),
          ].some(field => field?.includes(searchLower));

          // 筛选匹配
          const matchesFilter = {
            'all': true,
            'favorites': data.metadata.liked,
            'blocked': data.metadata.ListType === 'Block',
            'unblocked': data.metadata.ListType === 'White',
            'adult': data.metadata.Label?.toLowerCase() === 'adult',
          }[this.filterOption] ?? true;

          // 文件类型匹配
          const ext = data.name.split('.').pop().toLowerCase();
          // 用 fileConfig 里的实际键来判断，不要直接索引 this.fileType：
          // 后者可能被 localStorage 带进越界值（历史版本存过 "all"），
          // fileConfig[越界值] 是 undefined，取 .exts 会整段抛错、列表渲染不出来。
          const config = this.fileConfig[this.fileType];
          const matchesType = this.fileType === 'document' ?
          !Object.keys(this.fileConfig).some(type =>
            type !== 'document' && this.fileConfig[type].exts.includes(ext) // 匹配其他所有文件
          ) :
          !config || config.exts.includes(ext);
          return matchesSearch && matchesFilter && matchesType;
        });
      },
                        fileTypeIcon() {
        return this.fileType === 'image' ? 'image' :
        this.fileType === 'video' ? 'video' :
        this.fileType === 'audio' ? 'music' :
        this.fileType === 'document' ? 'folder-open' : '';
      }
    }),
    watch: Object.assign({}, window.KVAdminShared.watch, {  // 监听数据变化
      tableData: {
        handler(newData) {
          this.selectedFiles = newData.filter(file => file.selected);
        },
        deep: true
      },
            filterOption(newOption) { localStorage.setItem('filterOption', newOption); }
    }),
    methods: Object.assign({}, window.KVAdminShared.methods, {
      refreshDashboard() {location.reload();},  // 刷新页面
      async handleLogout() {  // 退出登录
        try {
          await fetch('./api/auth/logout', { method: 'POST', credentials: 'include' });
        } catch (e) {}
        window.location.href = './login.html';
      },
      handlePageChange(page) { this.currentPage = page; },  // 切换页面
                  // 切换排序方式
      // 切换筛选方式
      async loadMore() {
        if (this.isLoadingMore || !this.nextCursor) return;
        this.isLoadingMore = true;
        try {
          const result = await fetch(`./api/manage/list?cursor=${encodeURIComponent(this.nextCursor)}`, {
            method: 'GET',
            credentials: 'include',
          }).then((r) => r.json());

          const mapped = (result.keys || []).map((file) => this.normalizeListItem(file));
          this.mergeListData(mapped);
          this.nextCursor = result.list_complete ? null : result.cursor;
          if (Number.isFinite(result?.stats?.total)) {
            this.totalCount = result.stats.total;
          }
          this.updateStats();
        } catch {
          this.$message.error('加载更多失败，请稍后重试');
        } finally {
          this.isLoadingMore = false;
        }
      },
              formattedFileDetails(item) {
        const metadata = item.metadata;
        const timestamp = new Date(metadata.TimeStamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        // 详情内容走 v-html 注入：文件名等元数据来自外部输入，必须转义，
        // 否则一个带 <img onerror=…> 的文件名就能在后台执行脚本。
        const esc = KVShared.escapeHtml;
        return `
          <div class="file-detail-card">
            <div><strong>ID：</strong>${esc(item.name)}</div>
            <div><strong>文件名：</strong>${esc(metadata.fileName || item.name)}</div>
            <div><strong>上传时间：</strong>${esc(timestamp)}</div>
            <div><strong>元数据：</strong>${esc(JSON.stringify(metadata))}</div>
          </div>
        `;
      },
      calculatePageSize() {  // 设置页面大小
        const config = {
          minSize: 15, // 最小页面卡片数
          cardWidth: 240,
          ratio: 3/4, // 卡片高宽比
          gap: 20, // 卡片间距
          defaultWidth: 800,
          defaultHeaderHeight: 60 // 默认Dashboard高度
        };
        // 获取容器尺寸
        const content = document.querySelector('.content');
        const header = document.querySelector('.header-content');
        const width = content?.clientWidth || config.defaultWidth;
        const height = window.innerHeight - (header?.offsetHeight || config.defaultHeaderHeight);
        // 计算行列数
        const cols = Math.floor(width / (config.cardWidth + config.gap));
        const cardHeight = (width / cols - config.gap) * config.ratio;
        const rows = Math.floor(height / (cardHeight + config.gap));
        // 设置页面大小
        this.pageSize = Math.max(rows * cols, config.minSize);
      },
            updateStats() {
        this.Number = this.tableData.length;
        if (!Number.isFinite(this.totalCount) || this.totalCount < this.Number) {
          this.totalCount = this.Number;
        }
        let fileCount = {image: 0, video: 0, audio: 0, document: 0};
        this.tableData.forEach(file => {
          const ext = file.name.split('.').pop().toLowerCase();
          const type = Object.keys(this.fileConfig).find(t =>
            this.fileConfig[t].exts.includes(ext)
          ) || 'document';
          fileCount[type]++;
        });
        ['image', 'video', 'audio', 'document'].forEach((type) => {
          this.fileConfig[type].count = fileCount[type] || 0;
        });
      },
      // 文件操作
            async refreshFileList() {  // 不刷新页面，仅更新数据
        try {
          const result = await fetch("./api/manage/list?limit=100&includeStats=1", { method: 'GET', credentials: 'include' })
            .then(response => response.json());
          const mapped = (result.keys || []).map((file) => this.normalizeListItem(file));
          this.tableData = mapped;
          this.nextCursor = result.list_complete ? null : result.cursor;
          this.totalCount = Number.isFinite(result?.stats?.total) ? result.stats.total : mapped.length;
          this.updateStats();
          this.sortData(this.tableData);
        } catch {
          this.$message.error('刷新文件列表失败，请检查网络连接');
        }
      },
                  handleDelete(index, key) {
        this.$confirm('此操作将永久删除该文件, 是否继续?', '提示', {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning'
        }).then(() => {
          fetch(`./api/manage/delete/${key}`, { method: 'GET', credentials: 'include' })
            .then(response => response.ok ? this.tableData.splice(index, 1) : Promise.reject())
            .then(() => {
              this.updateStats();
              this.$message.success('删除成功！');
            })
            .catch(() => this.$message.error('删除失败，请检查网络连接'));
        }).catch(() => this.$message.info('已取消删除'));
      },
                        // 批处理相关
      selectAllInPage() {  // 全选当前页
        const selected = !this.paginatedTableData.every(file => file.selected);
        this.paginatedTableData.forEach(file => file.selected = selected);
      },
      handleBatchDelete() {  // 批量删除
        this.$confirm('此操作将永久删除这 ' + this.selectedFiles.length + ' 个文件, 是否继续?', '提示', {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning'
        }).then(() => {
          const promises = this.selectedFiles.map(file => fetch(`./api/manage/delete/${file.name}`, { method: 'GET', credentials: 'include' }));

          Promise.all(promises)
            .then(results => {
              results.forEach((response, index) => {
                if (response.ok) {
                  const fileIndex = this.tableData.findIndex(file => file.name === this.selectedFiles[index].name);
                  if (fileIndex !== -1) {
                    this.tableData.splice(fileIndex, 1);
                  }
                }
              });
              this.clearSelection();
              this.updateStats();
              this.$message.success('批量删除成功!');
            })
            .catch(() => this.$message.error('批量删除失败，请检查网络连接'));
        }).catch(() => this.$message.info('已取消批量删除'));
      },
      handleBatchOperation(command) {
        if (this.selectedFiles.length === 0) { this.$message.warning('请先选择文件'); return; }
        switch (command) {
          case 'copy': this.handleBatchCopy(); break;
          case 'copyMarkdown': this.handleBatchCopyMarkdown(); break;
          case 'copyHtml': this.handleBatchCopyHtml(); break;
          case 'delete': this.handleBatchDelete(); break;
          case 'download': this.handleBatchDownload(); break;
          case 'block': this.handleBatchBlockOrUnblock('Block'); break;
          case 'unblock': this.handleBatchBlockOrUnblock('White'); break;
        }
      },
      // 工具相关
      handleToolkit(command) {
        switch (command) {
          case 'selectAllInPage': this.selectAllInPage(); break;
          case 'checkBrokenFiles': this.checkBrokenFiles(); break;
          case 'editWebsites': this.editWebsites(); break;
          case 'openUploader': this.openUploader(); break;
          case 'exportLinks': this.exportAllLinks(); break;
        }
      },
      switchFileType(type) {  // 切换文件类型
        // type 常来自 localStorage，而 localStorage 是长期存在的：早期版本支持过
        // "all"，用户浏览器里可能还留着这个值。fileConfig 只有
        // image/video/audio/document 四个键，拿越界的键取 fileConfig[type].name
        // 会读到 undefined 上的属性而抛错，所以先把非法值挡回默认类型。
        this.fileType = Object.prototype.hasOwnProperty.call(this.fileConfig, type) ? type : 'image';
        this.currentPage = 1;
        localStorage.setItem('fileType', this.fileType);
        this.$message({
          message: `已切换为${this.fileConfig[this.fileType].name}模式, 共${this.fileConfig[this.fileType].count}个文件`,
          type: 'success',
          duration: 1500
        });
      },
      // 处理网站点击
            // 编辑快捷方式
            getFileIcon(filename) {
        return KVShared.fileIconOf(filename);
      },
                }),
    async mounted() {
      // 先检查认证状态
      try {
        const authResponse = await fetch('./api/auth/check', { method: 'GET', credentials: 'include' });
        const authData = await authResponse.json();
        
        if (authData.authRequired && !authData.authenticated) {
          window.location.href = './login.html?redirect=' + encodeURIComponent(window.location.pathname);
          return;
        }
        this.showLogoutButton = authData.authRequired && authData.authenticated;
      } catch (e) {
        this.$message.error('认证检查失败，请刷新页面');
        return;
      }

      window.addEventListener('resize', this.calculatePageSize);
      this.updateWindowWidth();

      // 获取文件列表数据
      try {
        const result = await fetch("./api/manage/list?limit=100&includeStats=1", { method: 'GET', credentials: 'include' })
          .then(response => response.json());
        const mapped = (result.keys || []).map((file) => this.normalizeListItem(file));
        this.tableData = mapped;
        this.nextCursor = result.list_complete ? null : result.cursor;
        this.totalCount = Number.isFinite(result?.stats?.total) ? result.stats.total : mapped.length;
        this.updateStats();
        // 恢复设置
        this.sortOption = localStorage.getItem('sortOption') || this.sortOption;
        this.sortData(this.tableData);
        this.fileType = localStorage.getItem('fileType') || this.fileType;
        this.switchFileType(this.fileType);
      } catch {
        this.$message.error('同步数据时出错，请检查网络连接');
      }

      if (localStorage.getItem('quickWebsites')) {
        this.quickWebsites = JSON.parse(localStorage.getItem('quickWebsites'));
      }
    },
    beforeDestroy() {
      this.pageDisposed = true;
      this.cancelBrokenCheck();
      window.removeEventListener('resize', this.calculatePageSize);
    }
  });
