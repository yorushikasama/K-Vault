/** 文件工作台的 Vue 应用（自 admin.html 内联脚本拆出，逻辑保持原样）。 */
  // 页面兜底：共享运行时若已提供组件则直接复用；图标由 Vue 管理，name 变化不会留下旧 SVG。
  if (!Vue.options.components['kv-icon'] && !Vue.options.components.KvIcon) {
    Vue.component('kv-icon', {
      props: { name: { type: String, default: 'file' } },
      render(h) {
        const name = String(this.name || '').trim();
        if (/^(?:fab|fas|far|fa-brands|fa-solid|fa-regular)\s+fa-[a-z0-9-]+$/.test(name)) {
          return h('i', { class: ['kv-icon', name], attrs: { 'aria-hidden': 'true' } });
        }
        const iconName = name.replace(/(^|-)([a-z0-9])/g, (_, dash, letter) => letter.toUpperCase());
        const library = window.lucide || {};
        const definition = (library.icons || {})[iconName] || library[iconName];
        const nodes = Array.isArray(definition)
          ? (definition[0] === 'svg' ? definition[2] : definition)
          : [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }], ['path', { d: 'M8 12h8M12 8v8' }]];
        const draw = (node, index) => h(node[0], { key: index, attrs: node[1] || {} }, (node[2] || []).map(draw));
        return h('svg', {
          class: ['kv-icon', 'lucide', 'lucide-' + name],
          attrs: { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', width: 20, height: 20,
            fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round',
            'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }
        }, (nodes || []).map(draw));
      }
    });
  }

  // ===== 列表渲染性能：模块级缓存 =====
  // 文件类型/图标按文件名记忆，避免每次模板重渲染都重复拆扩展名、扫映射表；重命名后键值不同，天然失效。
  const FILE_TYPE_CACHE = new Map();
  const FILE_ICON_CACHE = new Map();
  // 详情时间戳只构造一次格式化器；toLocaleString + timeZone 每次都会新建 Intl 实例，是详情气泡的主要开销
  let detailTimeFormatter = null;
  try {
    detailTimeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' });
  } catch (e) {
    detailTimeFormatter = null;
  }
  function memoFileValue(cache, key, compute) {
    if (key === undefined || key === null || key === '') return compute();
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= 4000) cache.clear();
    const value = compute();
    cache.set(key, value);
    return value;
  }
  function escapeDetailHtml(value) {
    return KVShared.escapeHtml(value);
  }

  new Vue({
    el: '#app',
    data: {
      baseURL: document.location.origin,
      Number: 0,
      reportedTotal: null,
      reportedTotalScopeKey: '',
      emptyPathMode: 'unknown', // 当前契约：Pages=all，Node/Docker=root；目录接口成功后确认。
      listLoaded: false,
      listComplete: false,
      listLoading: false,
      listError: '',
      listFromCache: false,
      loadedScopeKey: '',
      listAbortController: null,
      folderAbortController: null,
      folderScopeKey: '',
      activeScopeKey: '',
      scopeVersion: 0,
      cacheEpoch: 0,
      cacheOwner: '',
      resourceMutationId: 0,
      requestTimers: [],
      managedControllers: [],
      folderRequestSeq: 0,
      folderError: '',
      batchMutating: false,
      checkingFiles: false,
      favoritePending: {},
      folderDrawerOpen: false,
      folderReturnFocus: null,
      windowWidth: window.innerWidth,
      showLogoutButton: false,
      authReady: false,
      authError: '',
      pageDisposed: false,
      listErrorPhase: '',
      listNeedsRefresh: false,
      checkRequestSeq: 0,
      brokenCheckSeq: 0,
      brokenCheckMessage: null,
      brokenCheckController: null,
      tokenError: '',
      moveDialogScopeKey: '',
      storageLabels: { all: '全部存储', telegram: 'Telegram', r2: 'R2', s3: 'S3', discord: 'Discord', huggingface: 'HuggingFace', webdav: 'WebDAV', github: 'GitHub' },
      fileConfig: {
        all: {
          name: '全部',
          exts: [],  // 空数组表示匹配所有
          icon: 'layout-grid',
          count: 0
        },
        image: {
          name: '图片',
          exts: ['jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'png', 'apng', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'svg', 'heic', 'heif', 'avif', 'jxl'],
          icon: 'image',
          count: 0
        },
        video: {
          name: '视频',
          exts: ['mp4', 'webm', 'ogg', 'ogv', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'm4v', 'm3u8', '3gp', 'ts', 'mts', 'm2ts'],
          icon: 'video',
          count: 0
        },
        audio: {
          name: '音频',
          exts: ['mp3', 'mpeg', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'wma', 'ape', 'opus', 'weba', 'midi', 'mid', 'aif', 'aiff'],
          icon: 'music',
          count: 0
        },
        document: {
          name: '文件',
          exts: ['pdf', 'ofd', 'typ', 'typst', 'doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'rtf', 'odt', 'xls', 'xlsb', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'ods', 'fods', 'numbers', 'ppt', 'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm', 'odp', 'txt', 'md', 'markdown', 'zip', 'zipx', 'jar', 'war', 'ear', 'rar', '7z', 'tar', 'tgz', 'gz', 'gzip', 'bz2', 'bzip2', 'tbz', 'tbz2', 'xz', 'txz', 'lzma', 'zst', 'cab', 'iso', 'exe', 'apk', 'dmg', 'msi', 'deb', 'rpm', 'json', 'jsonc', 'json5', 'xml', 'csv', 'tsv', 'sql', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'vue', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'ttf', 'otf', 'woff', 'woff2', 'eml', 'msg', 'mbox', 'psd', 'ai', 'eps', 'sqlite', 'sqlite3', 'db', 'parquet', 'avro', 'wasm', 'webarchive', 'dwg', 'dxf', 'dwf', 'dwfx', 'xps', 'xmind', 'drawio', 'dio', 'excalidraw', 'mermaid', 'mmd', 'plantuml', 'puml', 'epub', 'umd', 'geojson', 'kml', 'gpx', 'shp', 'glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', 'dae', '3ds', '3mf', 'usd', 'usdz', 'kmz', 'step', 'stp', 'iges', 'igs', 'ifc', 'olb', 'dra', 'gds', 'oas', 'oasis'],
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
      pageSize: 24,
      sortOption: 'dateDesc',
      filterOption: 'all',
      fileType: 'all',
      storageFilter: 'all', // all | telegram | r2
      viewMode: 'grid', // grid | list
      viewMounted: { grid: true, list: false }, // 视图首次激活后常驻挂载，后续切换仅切显示，避免整棵列表树销毁重建
      openedDetailNames: {}, // 文件详情气泡内容懒渲染：首次点开的文件才生成 HTML
      folders: [],
      folderPath: '',
      folderLoading: false,
      folderMutating: false,
      folderMutatingAction: '',
      listRequestSeq: 0,
      isMobileViewport: false,
      mobileNavMetricsRaf: 0,
      headerResizeObserver: null,
      folderListCache: {},
      folderCacheTTL: 3 * 60 * 1000,
      folderCacheMaxEntries: 12,
      dragState: {
        active: false,
        fileIds: [],
        targetPath: null,
        leaveTimer: null,
        rafId: null,
      },
      loadMode: 'normal', // normal | dataSaver | noImage
      safeMode: true, // NSFW 安全模式
      systemStatus: {
        telegram: { connected: false, message: '检查中...' },
        kv: { connected: false, message: '检查中...' },
        r2: { connected: false, message: '检查中...', enabled: false },
        s3: { connected: false, message: '检查中...', enabled: false },
        discord: { connected: false, message: '检查中...', enabled: false },
        huggingface: { connected: false, message: '检查中...', enabled: false },
        github: { connected: false, message: '检查中...', enabled: false },
        auth: { enabled: false, message: '检查中...' }
      },
      batchToolbarPosition: {
        left: null,
        top: null
      },
      batchDragState: {
        dragging: false,
        offsetX: 0,
        offsetY: 0
      },
      previewData: null,  // 模态框预览数据
      revealedPreviewKeys: {},
      quickWebsites: [
        { name: '上传中心', url: './', icon: 'cloud-upload' },
        { name: '图片浏览', url: './gallery.html', icon: 'images' },
        { name: 'Movavi', url: 'https://www.movavi.com/zh/movavi-video-converter.html', icon: 'file-video-camera' },
        { name: 'FreeConvert', url: 'https://www.freeconvert.com/zh/video-compressor', icon: 'file' },
        { name: 'YouCompress', url: 'https://www.youcompress.com/zh-cn/', icon: 'file-archive' },
        { name: 'Cloudinary', url: 'https://console.cloudinary.com/', icon: 'cloud' },
      ],
      tokenDialogVisible: false,
      tokenLoading: false,
      createTokenDialogVisible: false,
      tokenCreateLoading: false,
      createdTokenDialogVisible: false,
      createdTokenValue: '',
      createdTokenCopied: false,
      apiTokens: [],
      tokenMutatingMap: {},
      tokenForm: {
        name: '',
        scopes: ['upload', 'read'],
        expiryPreset: 'never',
        customExpiresAt: '',
        allowedStorages: [],
        folderPrefix: '',
        maxFileSizeMb: 0,
      },
      storageOptions: ['telegram', 'r2', 's3', 'discord', 'huggingface', 'webdav', 'github'],
      moveDialogVisible: false,
      moveDialogLoading: false,
      moveDialogFoldersLoading: false,
      moveDialogFiles: [],
      moveDialogTargetPath: '',
      moveDialogFolderSearch: '',
      moveDialogNewFolderPath: '',
    },
    computed: Object.assign({}, window.KVAdminShared.computed, {
      selectedFiles() { return this.tableData.filter(file => file.selected); },
      isPagePartiallySelected() {
        const count = this.paginatedTableData.filter(file => file.selected).length;
        return count > 0 && count < this.paginatedTableData.length;
      },
      isAllLoadedSelected() {
        return this.tableData.length > 0 && this.selectedFiles.length === this.tableData.length;
      },
      selectedOutsidePageCount() {
        const names = new Set(this.paginatedTableData.map(file => file.name));
        return this.selectedFiles.filter(file => !names.has(file.name)).length;
      },
      selectedHiddenCount() {
        const names = new Set(this.filteredTableData.map(file => file.name));
        return this.selectedFiles.filter(file => !names.has(file.name)).length;
      },
      storageFilterLabel() { return this.storageLabels[this.storageFilter] || '全部存储'; },
      sortLabel() { return { dateDesc: '时间从新到旧', nameAsc: '文件标识 A–Z', sizeDesc: '大小从大到小' }[this.sortOption] || '时间从新到旧'; },
      filterLabel() { return { all: '全部状态', favorites: '收藏', blocked: '黑名单', unblocked: '白名单', adult: 'NSFW' }[this.filterOption] || '全部状态'; },
      emptyPathLabel() {
        return { all: '全部目录文件', root: '根目录文件', unknown: '默认文件范围' }[this.emptyPathMode];
      },
      rootCrumbLabel() { return this.folderPath ? '根目录' : this.emptyPathLabel; },
      scopeLabel() { return this.folderPath ? `目录 /${this.folderPath}（仅直属文件）` : this.emptyPathLabel; },
      scopeNote() {
        if (this.folderPath) return '仅列出当前目录直属文件，不包含子目录。';
        if (this.emptyPathMode === 'all') return '当前服务在空路径下返回所有目录的文件；移动到空路径仍表示移回根目录。';
        if (this.emptyPathMode === 'root') return '当前服务在空路径下仅返回根目录直属文件；其他目录请从左侧目录列表或手机端目录抽屉进入。';
        return '默认范围尚未确认：尚未收到可判断的文件列表响应。';
      },
      totalCount() {
        if (!this.listLoaded) return null;
        if (this.listComplete) return this.Number;
        // stats 由服务端按范围计算：Node 会剔除目录条件，故仅采用与当前范围一致的目录树计数。
        if (this.reportedTotalScopeKey === this.getFolderCacheKey() && Number.isFinite(this.reportedTotal)) {
          return Math.max(this.Number, this.reportedTotal);
        }
        return null;
      },
      loadedSummary() {
        if (!this.listLoaded) return this.listLoading ? '正在加载文件' : '尚未加载文件';
        const total = this.totalCount === null ? '总数待加载确认' : `范围内 ${this.totalCount} 项`;
        return `${total}，已加载 ${this.Number} 项${this.listFromCache ? '（3 分钟内缓存，可刷新）' : ''}`;
      },
      localModalOpen() { return Boolean(this.previewData || (this.isMobileViewport && this.folderDrawerOpen)); },
      emptyTitle() {
        if (this.listLoading) return '正在加载当前范围';
        if (this.listError && !this.listLoaded) return '文件列表加载失败';
        return this.Number ? '已加载文件中没有匹配项' : (this.listLoaded ? '当前范围暂无文件' : '尚未加载文件');
      },
      filteredTableData() {
        return this.tableData.filter(data => {
          // 搜索匹配
          const searchLower = String(this.search || '').trim().toLowerCase();
          const matchesSearch = !searchLower || [data.metadata.fileName, data.name]
            .some(field => String(field || '').toLowerCase().includes(searchLower));

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
          let matchesType = true;
          
          if (this.fileType === 'all') {
            // 全部模式：显示所有文件
            matchesType = true;
          } else if (this.fileType === 'document') {
            // 文档模式：排除图片、视频、音频
            matchesType = !Object.keys(this.fileConfig).some(type =>
              type !== 'document' && type !== 'all' && this.fileConfig[type].exts.includes(ext)
            );
          } else {
            // 特定类型模式
            matchesType = this.fileConfig[this.fileType].exts.includes(ext);
          }

          // 存储类型匹配
          const storagePrefix = this.getStorageType(data.name);
          const matchesStorage = this.storageFilter === 'all' || this.storageFilter === storagePrefix;
          // 目录筛选由后端 list 接口按 folderPath 负责，前端此处不再重复过滤，
          // 避免“全部文件”分页出现空白页。
          const matchesFolder = true;

          return matchesSearch && matchesFilter && matchesType && matchesStorage && matchesFolder;
        });
      },
            paginationTotal() {
        return this.filteredTableData.length;
      },
      paginatedData() {
        return this.paginatedTableData;
      },
      isAllSelected() {
        return this.paginatedData.length > 0 && this.paginatedData.every(f => f.selected);
      },
                  fileTypeIcon() {
        return this.fileType === 'all' ? 'layout-grid' :
        this.fileType === 'image' ? 'image' :
        this.fileType === 'video' ? 'video' :
        this.fileType === 'audio' ? 'music' :
        this.fileType === 'document' ? 'folder-open' : 'layout-grid';
      },
      storageFilterIcon() {
        return this.storageFilter === 'all' ? 'database' :
        this.storageFilter === 'telegram' ? 'fab fa-telegram' :
        this.storageFilter === 'r2' ? 'cloud' :
        this.storageFilter === 's3' ? 'database' :
        this.storageFilter === 'discord' ? 'fab fa-discord' :
        this.storageFilter === 'huggingface' ? 'bot' :
        this.storageFilter === 'webdav' ? 'hard-drive' :
        this.storageFilter === 'github' ? 'fab fa-github' : 'database';
      },
            folderBreadcrumbs() {
        const parts = this.normalizeFolderPath(this.folderPath).split('/').filter(Boolean);
        const result = [];
        for (let i = 0; i < parts.length; i += 1) {
          result.push({
            name: parts[i],
            path: parts.slice(0, i + 1).join('/'),
          });
        }
        return result;
      },
      folderTreeNodes() {
        const nodes = new Map();
        (this.folders || []).forEach((folder) => {
          const path = this.normalizeFolderPath(folder.path ?? folder.folderPath ?? '');
          if (!path) return; // Node 已含根节点；浏览入口只保留一个。
          nodes.set(path, {
            path,
            name: folder.name || path.split('/').pop(),
            depth: path.split('/').length,
            fileCount: Number.isFinite(folder.fileCount) ? folder.fileCount : '—',
          });
        });
        return [{ path: '', name: this.emptyPathLabel, depth: 0,
          fileCount: !this.folderPath && this.listLoaded
            ? (this.totalCount === null ? this.Number : this.totalCount)
            : '—' }]
          .concat(Array.from(nodes.values()).sort((a, b) =>
            a.depth - b.depth || a.path.localeCompare(b.path, 'zh-CN')));
      },
      dragTargetLabel() {
        if (!this.dragState.active) return '未选择目录';
        const target = this.normalizeFolderPath(this.dragState.targetPath || '');
        return target || '根目录';
      },
      moveDialogTargetLabel() {
        const target = this.normalizeFolderPath(this.moveDialogTargetPath || '');
        return target || '根目录';
      },
      moveDialogFolderOptions() {
        const keyword = String(this.moveDialogFolderSearch || '').trim().toLowerCase();
        const normalized = new Map();
        normalized.set('', {
          path: '',
          label: '根目录',
          fileCount: this.folderPath ? 0 : this.Number,
        });
        (this.folders || []).forEach((folder) => {
          const path = this.normalizeFolderPath(folder.path || folder.folderPath || '');
          if (!path) return;
          normalized.set(path, {
            path,
            label: path,
            fileCount: Number(folder.fileCount || 0),
          });
        });
        return Array.from(normalized.values())
          .filter((folder) => {
            if (!keyword) return true;
            return folder.label.toLowerCase().includes(keyword);
          })
          .map((folder) => ({
            ...folder,
            fileCountLabel: folder.path ? `${folder.fileCount || 0} 个文件` : '根目录',
          }))
          .sort((a, b) => {
            if (!a.path) return -1;
            if (!b.path) return 1;
            const depthA = a.path.split('/').length;
            const depthB = b.path.split('/').length;
            if (depthA !== depthB) return depthA - depthB;
            return a.path.localeCompare(b.path, 'zh-CN');
          });
      },
      batchToolbarStyle() {
        if (this.isMobileViewport) {
          return {};
        }
        if (this.batchToolbarPosition.left === null || this.batchToolbarPosition.top === null) {
          return {};
        }
        return {
          left: `${this.batchToolbarPosition.left}px`,
          top: `${this.batchToolbarPosition.top}px`,
          bottom: 'auto',
          transform: 'translate(0, 0)'
        };
      }
    }),
    watch: Object.assign({}, window.KVAdminShared.watch, {  // 监听数据变化；selectedFiles / totalCount 始终由 computed 派生。
      localModalOpen() { this.$nextTick(this.syncModalEnvironment); },
      search() {
        this.currentPage = 1;
        this.normalizeCurrentPage();
      },
      selectedFiles(newValue) {
        if (newValue.length === 0) {
          this.batchToolbarPosition.left = null;
          this.batchToolbarPosition.top = null;
          return;
        }
        if (this.isMobileViewport) {
          this.batchToolbarPosition.left = null;
          this.batchToolbarPosition.top = null;
          return;
        }
        if (this.batchToolbarPosition.left === null) {
          this.$nextTick(() => this.snapBatchToolbarToBottom());
        }
      },
            filterOption(newOption) {
        localStorage.setItem('filterOption', newOption);
        this.currentPage = 1;
        this.normalizeCurrentPage();
      },
      paginationTotal() {
        this.normalizeCurrentPage();
      },
      viewMode(newValue) { localStorage.setItem('adminViewMode', newValue); },
      folderPath(newValue) { localStorage.setItem('adminFolderPath', this.normalizeFolderPath(newValue)); }
    }),
    methods: Object.assign({}, window.KVAdminShared.methods, window.KVAdminTokens.methods, window.KVAdminUiDesign.methods, {
      // localModalOpen 的 watch 调用这个（预览弹窗或移动端目录抽屉打开）。
      // 它此前从未被定义，$nextTick(undefined) 是静默空操作——于是弹窗开着
      // 还能滚背景：实测 body.style.overflow 恒为空、window.scrollY 能从 0
      // 滚到 500，手指在预览图上滑动会把背后的文件列表带着走。
      // 与 index.html 的做法保持一致：只在进入时记录原值，退出时还原，
      // 不假设原值一定是空串。
      syncModalEnvironment() {
        const locked = this.localModalOpen;
        if (locked && !this._modalLocked) {
          this._modalOverflow = document.body.style.overflow;
          document.body.style.overflow = 'hidden';
          this._modalLocked = true;
        } else if (!locked && this._modalLocked) {
          document.body.style.overflow = this._modalOverflow || '';
          this._modalLocked = false;
        }
      },

      normalizeFolderPath(value = '') {
        return KVShared.normalizeFolderPath(value);
      },
      isUnconfiguredStatus(item = {}) {
        const message = String(item?.message || '').trim().toLowerCase();
        return message === '未配置' || message === 'not configured' || message.includes('not configured');
      },
      queueMobileNavMetricsUpdate() {
        if (this.mobileNavMetricsRaf) {
          cancelAnimationFrame(this.mobileNavMetricsRaf);
        }
        this.mobileNavMetricsRaf = requestAnimationFrame(() => {
          this.mobileNavMetricsRaf = 0;
          this.updateMobileNavMetrics();
        });
      },
      updateMobileNavMetrics() {
        const root = document.documentElement;
        if (!root) return;

        const isMobile = window.matchMedia('(max-width: 900px)').matches;
        if (!isMobile) {
          root.style.setProperty('--nav-height', '0px');
          root.style.setProperty('--nav-offset', '0px');
          return;
        }

        const header = (this.$el && this.$el.querySelector('.header-content')) || document.querySelector('.header-content');
        if (!header) return;

        const rect = header.getBoundingClientRect();
        const computed = window.getComputedStyle(header);
        const top = Number.parseFloat(computed.top) || 0;
        const marginBottom = Number.parseFloat(computed.marginBottom) || 0;
        const navHeight = Math.max(0, Math.ceil(rect.height));
        const navOffset = Math.max(0, Math.ceil(top + navHeight + marginBottom));

        root.style.setProperty('--nav-height', `${navHeight}px`);
        root.style.setProperty('--nav-offset', `${navOffset}px`);
      },
      observeMobileNavHeight() {
        if (typeof ResizeObserver !== 'function') return;
        this.unobserveMobileNavHeight();

        const header = (this.$el && this.$el.querySelector('.header-content')) || document.querySelector('.header-content');
        if (!header) return;

        this.headerResizeObserver = new ResizeObserver(() => {
          this.queueMobileNavMetricsUpdate();
        });
        this.headerResizeObserver.observe(header);
      },
      unobserveMobileNavHeight() {
        if (this.headerResizeObserver && typeof this.headerResizeObserver.disconnect === 'function') {
          this.headerResizeObserver.disconnect();
        }
        this.headerResizeObserver = null;
      },
      updateViewportFlags() {
        const wasMobile = this.isMobileViewport;
        this.isMobileViewport = window.matchMedia('(max-width: 900px)').matches;
        if (wasMobile && !this.isMobileViewport) {
          this.closeFolderDrawer({ restoreFocus: false });
        }
        if (this.isMobileViewport) {
          this.batchToolbarPosition.left = null;
          this.batchToolbarPosition.top = null;
          this.batchDragState.dragging = false;
        }
        this.queueMobileNavMetricsUpdate();
      },
      validCursor(cursor) {
        return (typeof cursor === 'string' && cursor.trim().length > 0)
          || (typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0);
      },
      validListRows(rows) {
        return Array.isArray(rows) && rows.every(row => row && typeof row.name === 'string' && row.name.length > 0
          && (row.metadata == null || (typeof row.metadata === 'object' && !Array.isArray(row.metadata))));
      },
      restoreFolderCache() {
        try {
          const parsed = JSON.parse(localStorage.getItem('adminFolderListCache') || '{}');
          this.folderListCache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
          this.pruneFolderCache();
          this.persistFolderCache();
        } catch {
          this.folderListCache = {};
        }
      },
      persistFolderCache() {
        try { localStorage.setItem('adminFolderListCache', JSON.stringify(this.folderListCache)); }
        catch { /* 隐私模式或配额不足时使用内存缓存。 */ }
      },
      validFolderCache(cacheKey, entry) {
        if (!entry || entry.version !== 2 || !this.cacheOwner || entry.owner !== this.cacheOwner
          || entry.scopeKey !== cacheKey || !Number.isFinite(entry.time)
          || entry.time > Date.now() || Date.now() - entry.time > this.folderCacheTTL
          || !this.validListRows(entry.rows) || typeof entry.listComplete !== 'boolean'
          || !['unknown', 'all', 'root'].includes(entry.emptyPathMode)
          || !(entry.reportedTotal === null || (Number.isInteger(entry.reportedTotal) && entry.reportedTotal >= 0))) return false;
        return entry.listComplete ? entry.nextCursor === null : this.validCursor(entry.nextCursor);
      },
      pruneFolderCache() {
        this.folderListCache = Object.fromEntries(Object.entries(this.folderListCache || {})
          .filter(([key, entry]) => this.validFolderCache(key, entry))
          .sort((a, b) => b[1].time - a[1].time).slice(0, this.folderCacheMaxEntries));
      },
      getFolderCacheKey() {
        return `${String(this.storageFilter || 'all').toLowerCase()}::${this.normalizeFolderPath(this.folderPath)}`;
      },
      cloneRowsForCache(rows = []) {
        return rows.map(item => ({ ...item, selected: false, metadata: { ...(item.metadata || {}) } }));
      },
      readFolderCache(cacheKey) {
        const entry = this.folderListCache[cacheKey];
        if (this.validFolderCache(cacheKey, entry)) return entry;
        if (entry) { this.$delete(this.folderListCache, cacheKey); this.persistFolderCache(); }
        return null;
      },
      applyFolderCacheEntry(entry) {
        const key = this.getFolderCacheKey();
        if (!this.authReady || this.pageDisposed || !this.validFolderCache(key, entry)) return false;
        this.tableData = this.cloneRowsForCache(entry.rows);
        this.nextCursor = entry.nextCursor;
        this.reportedTotal = entry.reportedTotal;
        this.reportedTotalScopeKey = Number.isFinite(entry.reportedTotal) ? key : '';
        if (this.emptyPathMode === 'unknown') this.emptyPathMode = entry.emptyPathMode;
        this.listComplete = entry.listComplete;
        this.listLoaded = true;
        this.listFromCache = true;
        this.loadedScopeKey = key;
        this.listNeedsRefresh = false;
        this.listError = '';
        this.listErrorPhase = '';
        this.updateStats();
        this.calculatePageSize();
        this.normalizeCurrentPage();
        return true;
      },
      writeFolderCache(cacheKey) {
        if (!this.authReady || this.pageDisposed || this.batchMutating || !this.listLoaded || this.listNeedsRefresh
          || cacheKey !== this.loadedScopeKey || cacheKey !== this.getFolderCacheKey()) return;
        this.$set(this.folderListCache, cacheKey, {
          version: 2, owner: this.cacheOwner, scopeKey: cacheKey, time: Date.now(),
          rows: this.cloneRowsForCache(this.tableData), nextCursor: this.nextCursor,
          listComplete: this.listComplete, reportedTotal: this.reportedTotal, emptyPathMode: this.emptyPathMode,
        });
        this.pruneFolderCache();
        this.persistFolderCache();
      },
      invalidateListRequest() {
        this.listRequestSeq += 1;
        if (this.listAbortController) this.listAbortController.abort();
        this.listAbortController = null;
        this.listLoading = false;
        this.isLoadingMore = false;
      },
      invalidateFolderRequest() {
        this.folderRequestSeq += 1;
        if (this.folderAbortController) this.folderAbortController.abort();
        this.folderAbortController = null;
        this.folderLoading = false;
      },
      clearFolderCache() {
        this.cacheEpoch += 1; // 清缓存同时使旧请求失效，禁止晚到响应回填。
        this.invalidateListRequest();
        this.invalidateFolderRequest();
        this.folderListCache = {};
        this.listNeedsRefresh = true;
        this.listComplete = false;
        this.reportedTotal = null;
        this.reportedTotalScopeKey = '';
        this.nextCursor = null;
        try { localStorage.removeItem('adminFolderListCache'); } catch { /* 内存缓存仍已清理。 */ }
      },
      syncResourceScope() {
        const key = this.getFolderCacheKey();
        if (key !== this.activeScopeKey) {
          this.scopeVersion += 1;
          this.activeScopeKey = key;
          this.invalidateListRequest();
          this.cancelBrokenCheck();
          this.closePreview(false);
          this.closeImageViewer(false);
          this.handleFileDragEnd();
          this.tableData = [];
          this.Number = 0;
          this.nextCursor = null;
          this.reportedTotal = null;
          this.reportedTotalScopeKey = '';
          this.loadedScopeKey = '';
          this.listLoaded = false;
          this.listComplete = false;
          this.listFromCache = false;
          this.listError = '';
          this.listErrorPhase = '';
          this.listNeedsRefresh = true;
          this.revealedPreviewKeys = {};
          this.currentPage = 1;
          this.updateStats();
          if (this.folderScopeKey !== this.storageFilter) {
            this.invalidateFolderRequest();
            this.folderScopeKey = this.storageFilter;
            this.folders = [];
            this.folderError = '';
          }
        }
        return { key, version: this.scopeVersion, folder: this.folderPath, storage: this.storageFilter, epoch: this.cacheEpoch };
      },
      isCurrentScope(scope) {
        return !this.pageDisposed && this.authReady && scope.key === this.getFolderCacheKey() && scope.version === this.scopeVersion;
      },
      isCurrentListRequest(scope, seq) {
        return this.isCurrentScope(scope) && seq === this.listRequestSeq && scope.epoch === this.cacheEpoch;
      },
                  async requestJson(url, options = {}) {
        const { controller = typeof AbortController === 'function' ? new AbortController() : null, ...init } = options;
        let timedOut = false;
        if (controller) this.managedControllers.push(controller);
        const timer = setTimeout(() => { timedOut = true; if (controller) controller.abort(); }, 30000);
        this.requestTimers.push(timer);
        try {
          const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...init, signal: controller?.signal });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload || typeof payload !== 'object' || payload.success === false || payload.error) {
            const error = new Error(payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '')
              || payload?.message || (response.ok ? '服务返回的数据格式无效' : `请求失败（HTTP ${response.status}）`));
            error.status = response.status;
            throw error;
          }
          return payload;
        } catch (error) {
          if (timedOut) throw new Error('请求超时，请检查网络后重试');
          throw error;
        } finally {
          clearTimeout(timer);
          this.requestTimers = this.requestTimers.filter(value => value !== timer);
          this.managedControllers = this.managedControllers.filter(value => value !== controller);
        }
      },
      handleResourceError(error) {
        if (error?.status !== 401 && error?.status !== 403) return;
        this.authReady = false;
        this.authError = '登录已失效或权限不足，请重新验证登录后重试。';
        this.clearFolderCache();
        this.cacheOwner = '';
        this.tableData = [];
        this.folders = [];
        this.listLoaded = false;
        this.updateStats();
        this.closePreview();
        this.closeImageViewer();
      },
      connectionLabel(key) {
        return { telegram: 'Telegram', kv: 'KV 存储', r2: 'R2 存储', s3: 'S3 存储', discord: 'Discord',
          huggingface: 'HuggingFace', github: 'GitHub', webdav: 'WebDAV', auth: '身份验证' }[key] || key;
      },
      getStorageType(name = '') {
        return KVShared.storageTypeOf(name);
      },
      getStorageLabel(name = '') {
        return KVShared.STORAGE_LABELS[this.getStorageType(name)] || 'Telegram';
      },
      toggleSelectByName(name) {
        const target = this.tableData.find((item) => item.name === name);
        if (target) target.selected = !target.selected;
      },
      getFileMoveId(file) {
        return String(file?.id || file?.name || file?.key || file?.metadata?.id || '').trim();
      },
      getFileMovePayload(file) {
        return {
          id: this.getFileMoveId(file),
          name: file?.name || '',
          key: file?.key || '',
          fileName: file?.metadata?.fileName || '',
          metadata: {
            id: file?.metadata?.id || '',
            fileId: file?.metadata?.fileId || '',
            fileName: file?.metadata?.fileName || '',
          },
        };
      },
      findFileByMoveId(id) {
        const target = String(id || '').trim();
        if (!target) return null;
        return this.tableData.find((file) => {
          return (
            this.getFileMoveId(file) === target ||
            String(file?.name || '') === target ||
            String(file?.id || '') === target
          );
        }) || null;
      },
      isRowInMoveSet(row, idSet) {
        return (
          idSet.has(this.getFileMoveId(row)) ||
          idSet.has(String(row?.name || '')) ||
          idSet.has(String(row?.id || ''))
        );
      },
      switchViewMode(mode) {
        if (!['grid', 'list'].includes(mode) || this.viewMode === mode) return;
        this.viewMode = mode;
        this.viewMounted[mode] = true;
        this.closeImageViewer();
        this.$nextTick(() => {
          if (mode === 'list') {
            // el-table 若曾在隐藏状态下经历过尺寸变化，重新显示时需要重算列宽
            const table = this.$refs.fileTable;
            if (table && typeof table.doLayout === 'function') table.doLayout();
          } else {
            // el-image 懒加载依赖滚动事件；网格重新显示后补发一次检查，未加载的缩略图立即开始加载
            window.dispatchEvent(new Event('scroll'));
          }
        });
      },
      openDetailPopover(name) {
        if (name && !this.openedDetailNames[name]) this.$set(this.openedDetailNames, name, true);
      },
      cloneFoldersSnapshot() {
        return Array.isArray(this.folders) ? this.folders.map((item) => ({ ...item })) : [];
      },
      sortFoldersLocal() {
        this.folders = [...(this.folders || [])].sort((a, b) => {
          const pathA = this.normalizeFolderPath(a.path || a.folderPath || '');
          const pathB = this.normalizeFolderPath(b.path || b.folderPath || '');
          const depthA = Number.isFinite(a.depth) ? a.depth : (pathA ? pathA.split('/').length : 0);
          const depthB = Number.isFinite(b.depth) ? b.depth : (pathB ? pathB.split('/').length : 0);
          if (depthA !== depthB) return depthA - depthB;
          return pathA.localeCompare(pathB, 'zh-CN', { sensitivity: 'base' });
        });
      },
      buildFolderNode(path, fileCount = 0) {
        const normalized = this.normalizeFolderPath(path);
        if (!normalized) return null;
        const segments = normalized.split('/');
        return {
          path: normalized,
          name: segments[segments.length - 1] || normalized,
          parentPath: segments.length > 1 ? segments.slice(0, -1).join('/') : '',
          depth: segments.length,
          fileCount: Number(fileCount || 0),
        };
      },
      ensureFolderBranchLocal(path) {
        const normalized = this.normalizeFolderPath(path);
        if (!normalized) return;
        const parts = normalized.split('/');
        let current = '';
        parts.forEach((part) => {
          current = current ? `${current}/${part}` : part;
          const exists = (this.folders || []).some((folder) => {
            return this.normalizeFolderPath(folder.path || folder.folderPath || '') === current;
          });
          if (!exists) {
            const node = this.buildFolderNode(current, 0);
            if (node) this.folders.push(node);
          }
        });
        this.sortFoldersLocal();
      },
      renameFolderBranchLocal(sourcePath, targetPath) {
        const source = this.normalizeFolderPath(sourcePath);
        const target = this.normalizeFolderPath(targetPath);
        if (!source || !target || source === target) return;
        this.folders = (this.folders || []).map((folder) => {
          const current = this.normalizeFolderPath(folder.path || folder.folderPath || '');
          if (!current || (current !== source && !current.startsWith(`${source}/`))) {
            return folder;
          }
          const suffix = current === source ? '' : current.slice(source.length + 1);
          const nextPath = suffix ? `${target}/${suffix}` : target;
          const nextNode = this.buildFolderNode(nextPath, Number(folder.fileCount || 0));
          return nextNode ? { ...folder, ...nextNode } : folder;
        });
        this.sortFoldersLocal();
      },
      removeFolderBranchLocal(path) {
        const target = this.normalizeFolderPath(path);
        if (!target) return;
        this.folders = (this.folders || []).filter((folder) => {
          const current = this.normalizeFolderPath(folder.path || folder.folderPath || '');
          return current !== target && !current.startsWith(`${target}/`);
        });
        this.sortFoldersLocal();
      },
      async selectFolder(path = '') {
        const normalized = this.normalizeFolderPath(path);
        if (normalized === this.folderPath && this.tableData.length > 0) {
          if (this.isMobileViewport) this.closeFolderDrawer();
          return;
        }
        this.folderPath = normalized;
        this.currentPage = 1;
        if (this.isMobileViewport) this.closeFolderDrawer();
        await this.refreshFileList({ preferCache: true });
      },
      openFolderDrawer() {
        if (!this.isMobileViewport || this.folderDrawerOpen) return;
        this.folderReturnFocus = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : (this.$refs.folderToggle || null);
        this.folderDrawerOpen = true;
        this.$nextTick(() => {
          const drawer = this.$refs.folderDrawer;
          if (drawer && typeof drawer.focus === 'function') drawer.focus();
        });
      },
      closeFolderDrawer(options = {}) {
        const { restoreFocus = true } = options;
        if (!this.folderDrawerOpen) return;
        this.folderDrawerOpen = false;
        const target = this.folderReturnFocus || this.$refs.folderToggle || null;
        this.folderReturnFocus = null;
        if (!restoreFocus) return;
        this.$nextTick(() => {
          if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
        });
      },
      toggleFolderDrawer() {
        if (this.folderDrawerOpen) this.closeFolderDrawer();
        else this.openFolderDrawer();
      },
      trapFolderDrawerFocus(event) {
        const drawer = this.$refs.folderDrawer;
        if (!drawer) return;
        const focusable = Array.from(
          drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ).filter((node) => !node.disabled && node.offsetParent !== null);
        if (focusable.length === 0) {
          event.preventDefault();
          drawer.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const inside = drawer.contains(active);
        if (event.shiftKey && (!inside || active === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || active === last)) {
          event.preventDefault();
          first.focus();
        }
      },
      clearLocalFilters() {
        this.search = '';
        this.fileType = 'all';
        this.filterOption = 'all';
        this.sortOption = 'dateDesc';
        this.currentPage = 1;
        this.normalizeCurrentPage();
      },
      applyEmptyPathMode(rows = []) {
        if (this.folderPath) return;
        // 以实际响应判断空路径的范围：返回了子目录文件即为“全部目录”，否则为“仅根目录”。
        if (rows.some((file) => this.normalizeFolderPath(file?.metadata?.folderPath || ''))) {
          this.emptyPathMode = 'all';
        } else if (this.emptyPathMode !== 'all') {
          this.emptyPathMode = 'root';
        }
      },
      applyFolderScopeTotal(list = []) {
        // Node 的目录树含根节点，Pages 仅返回具名目录；只有范围一致时才采用该计数。
        const normalized = (Array.isArray(list) ? list : []).map((folder) => ({
          path: this.normalizeFolderPath(folder?.path ?? folder?.folderPath ?? ''),
          fileCount: Number.isFinite(Number(folder?.fileCount)) ? Number(folder.fileCount) : null,
        }));
        const rootNode = normalized.find((folder) => folder.path === '');
        const current = this.folderPath
          ? normalized.find((folder) => folder.path === this.folderPath)
          : rootNode;
        const total = current && current.fileCount !== null ? current.fileCount : null;
        this.reportedTotal = total;
        this.reportedTotalScopeKey = total === null ? '' : this.getFolderCacheKey();
      },
      async fetchFolders(options = {}) {
        const { silent = false } = options;
        if (!this.authReady || this.pageDisposed) return false;
        const scope = {
          key: this.getFolderCacheKey(),
          version: this.scopeVersion,
          epoch: this.cacheEpoch,
        };
        const seq = ++this.folderRequestSeq;
        if (this.folderAbortController) this.folderAbortController.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        this.folderAbortController = controller;
        this.folderLoading = true;
        this.folderError = '';
        try {
          const params = new URLSearchParams();
          if (this.storageFilter && this.storageFilter !== 'all') {
            params.set('storage', this.storageFilter);
          }
          const query = params.toString();
          const payload = await this.requestJson(`./api/manage/folders${query ? `?${query}` : ''}`, {
            method: 'GET',
            controller,
          });
          if (this.pageDisposed || seq !== this.folderRequestSeq || !this.isCurrentScope(scope)) return false;
          const list = Array.isArray(payload?.folders) ? payload.folders : [];
          this.folders = list;
          this.sortFoldersLocal();
          this.applyFolderScopeTotal(list);
          return true;
        } catch (error) {
          if (this.pageDisposed || seq !== this.folderRequestSeq) return false;
          if (error?.name === 'AbortError') return false;
          this.folders = [];
          this.folderError = error?.message || '目录列表加载失败';
          this.handleResourceError(error);
          if (!silent) this.$message.error(this.folderError);
          return false;
        } finally {
          if (seq === this.folderRequestSeq) {
            this.folderLoading = false;
            if (this.folderAbortController === controller) this.folderAbortController = null;
          }
        }
      },
      async refreshFolderResources(showMessage = true) {
        try {
          this.clearFolderCache();
          const [foldersOk] = await Promise.all([
            this.fetchFolders({ silent: true }),
            this.refreshFileList({ force: true, silent: true }),
          ]);
          if (!showMessage) return;
          if (foldersOk && !this.listError) {
            this.$message.success('目录与文件已刷新');
          } else {
            this.$message.error(this.folderError || this.listError || '刷新失败，请稍后重试');
          }
        } catch (error) {
          if (showMessage) {
            this.$message.error(error?.message || '刷新失败，请稍后重试');
          }
        }
      },
      async createFolder() {
        if (this.folderMutating) return;
        const seed = this.folderPath ? `${this.folderPath}/新目录` : '新目录';
        try {
          const prompt = await this.$prompt('请输入目录路径（例如：项目A/一月）', '新建目录', {
            inputValue: seed,
            confirmButtonText: '创建',
            cancelButtonText: '取消',
            inputValidator: (value) => !!this.normalizeFolderPath(value) || '目录路径不能为空',
          });
          const path = this.normalizeFolderPath(prompt.value);
          if (!path) return;

          const existed = (this.folders || []).some((folder) => this.normalizeFolderPath(folder.path || folder.folderPath || '') === path);
          if (existed) {
            await this.selectFolder(path);
            this.$message.info('目录已存在，已切换到该目录');
            return;
          }

          const previousFolders = this.cloneFoldersSnapshot();
          const previousFolderPath = this.folderPath;

          this.folderMutating = true;
          this.folderMutatingAction = 'create';
          this.ensureFolderBranchLocal(path);
          this.folderPath = path;
          this.currentPage = 1;
          this.tableData = [];
          this.nextCursor = null;

          try {
            const response = await fetch('./api/manage/folders', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path }),
            }).then((r) => r.json());

            if (!response?.success) throw new Error(response?.error || '目录创建失败');

            this.$message.success('目录创建成功');
            this.clearFolderCache();
            await Promise.all([this.fetchFolders(), this.refreshFileList()]);
          } catch (error) {
            this.folders = previousFolders;
            this.folderPath = previousFolderPath;
            await this.refreshFileList();
            this.$message.error(error.message || '目录创建失败');
          } finally {
            this.folderMutating = false;
            this.folderMutatingAction = '';
          }
        } catch (error) {
          if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '目录创建失败');
        }
      },
      async renameCurrentFolder() {
        if (!this.folderPath || this.folderMutating) return;
        const parts = this.folderPath.split('/');
        const oldName = parts[parts.length - 1] || '';
        const prefix = parts.slice(0, -1).join('/');
        try {
          const prompt = await this.$prompt('请输入新的目录名称', '重命名目录', {
            inputValue: oldName,
            confirmButtonText: '保存',
            cancelButtonText: '取消',
            inputValidator: (value) => !!String(value || '').trim() || '目录名称不能为空',
          });
          const newName = String(prompt.value || '').trim();
          const targetPath = this.normalizeFolderPath(prefix ? `${prefix}/${newName}` : newName);
          if (!targetPath || targetPath === this.folderPath) return;

          const sourcePath = this.folderPath;
          const previousFolders = this.cloneFoldersSnapshot();
          this.folderMutating = true;
          this.folderMutatingAction = 'rename';
          this.renameFolderBranchLocal(sourcePath, targetPath);
          this.folderPath = targetPath;

          try {
            const res = await fetch('./api/manage/folders', {
              method: 'PUT',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sourcePath, targetPath }),
            }).then((r) => r.json());

            if (!res?.success) throw new Error(res?.error || '重命名失败');
            this.$message.success('目录重命名成功');
            this.clearFolderCache();
            await Promise.all([this.fetchFolders(), this.refreshFileList()]);
          } catch (error) {
            this.folders = previousFolders;
            this.folderPath = sourcePath;
            await this.refreshFileList();
            this.$message.error(error.message || '目录重命名失败');
          } finally {
            this.folderMutating = false;
            this.folderMutatingAction = '';
          }
        } catch (error) {
          if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '目录重命名失败');
        }
      },
      async deleteCurrentFolder() {
        if (!this.folderPath || this.folderMutating) return;
        try {
          await this.$confirm('确认删除该目录标记并将目录内文件移回根目录？文件直链不会失效。', '删除目录', {
            type: 'warning',
            confirmButtonText: '删除',
            cancelButtonText: '取消',
          });
          const target = this.folderPath;
          const parent = target.split('/').slice(0, -1).join('/');

          const previousFolders = this.cloneFoldersSnapshot();
          const previousFolderPath = this.folderPath;

          this.folderMutating = true;
          this.folderMutatingAction = 'delete';
          this.removeFolderBranchLocal(target);
          this.folderPath = this.normalizeFolderPath(parent);
          this.currentPage = 1;
          this.tableData = [];
          this.nextCursor = null;

          try {
            const response = await fetch(`./api/manage/folders?path=${encodeURIComponent(target)}&recursive=1`, {
              method: 'DELETE',
              credentials: 'include',
            }).then((r) => r.json());

            if (!response?.success) throw new Error(response?.error || '删除目录失败');
            this.clearFolderCache();
            await Promise.all([this.fetchFolders(), this.refreshFileList()]);
            this.$message.success('目录删除成功');
          } catch (error) {
            this.folders = previousFolders;
            this.folderPath = previousFolderPath;
            await this.refreshFileList();
            this.$message.error(error.message || '目录删除失败');
          } finally {
            this.folderMutating = false;
            this.folderMutatingAction = '';
          }
        } catch (error) {
          if (error !== 'cancel' && error !== 'close') this.$message.error(error.message || '目录删除失败');
        }
      },
      moveSelectedToFolder() {
        this.openMoveDialog(this.selectedFiles);
      },
      openMoveDialog(files = []) {
        const candidates = Array.isArray(files) ? files.filter(Boolean) : [];
        if (candidates.length === 0) {
          this.$message.warning('请先选择文件');
          return;
        }
        this.moveDialogFiles = candidates.slice();
        this.moveDialogTargetPath = this.normalizeFolderPath(this.folderPath || '');
        this.moveDialogFolderSearch = '';
        this.moveDialogNewFolderPath = this.moveDialogTargetPath ? `${this.moveDialogTargetPath}/新目录` : '新目录';
        this.moveDialogVisible = true;
      },
      async refreshMoveDialogFolders(showMessage = false) {
        if (this.moveDialogFoldersLoading) return;
        this.moveDialogFoldersLoading = true;
        try {
          const refreshed = await this.fetchFolders();
          if (showMessage && refreshed) this.$message.success('已获取最新后端目录');
          if (showMessage && !refreshed) this.$message.error('目录刷新失败，请稍后重试');
        } catch (error) {
          if (showMessage) this.$message.error(error?.message || '目录刷新失败');
        } finally {
          this.moveDialogFoldersLoading = false;
        }
      },
      selectMoveDialogFolder(path = '') {
        this.moveDialogTargetPath = this.normalizeFolderPath(path);
      },
      async createFolderAndMoveSelected() {
        const path = this.normalizeFolderPath(this.moveDialogNewFolderPath);
        if (!path) {
          this.$message.warning('请输入要新建的目录路径');
          return;
        }
        this.moveDialogLoading = true;
        const previousFolders = this.cloneFoldersSnapshot();
        let folderCreated = false;
        try {
          this.ensureFolderBranchLocal(path);
          const response = await fetch('./api/manage/folders', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          }).then((r) => r.json());
          if (!response?.success) throw new Error(response?.error || '目录创建失败');
          folderCreated = true;
          this.moveDialogTargetPath = path;
          const moved = await this.moveFilesToFolder(this.moveDialogFiles, path);
          if (moved) this.moveDialogVisible = false;
        } catch (error) {
          if (!folderCreated) {
            this.folders = previousFolders;
            this.sortFoldersLocal();
          }
          this.$message.error(error.message || '新建并移动失败');
        } finally {
          this.moveDialogLoading = false;
        }
      },
      async confirmMoveDialog() {
        this.moveDialogLoading = true;
        try {
          const moved = await this.moveFilesToFolder(this.moveDialogFiles, this.moveDialogTargetPath);
          if (moved) this.moveDialogVisible = false;
        } catch (error) {
          this.$message.error(error.message || '移动文件失败');
        } finally {
          this.moveDialogLoading = false;
        }
      },
      async moveFilesToFolder(files, targetFolderPathValue) {
        const selected = Array.isArray(files) ? files.filter(Boolean) : [];
        if (selected.length === 0) {
          throw new Error('请先选择文件');
        }
        const targetFolderPath = this.normalizeFolderPath(targetFolderPathValue || '');
        const filesPayload = selected.map((item) => this.getFileMovePayload(item));
        const ids = filesPayload.map((item) => item.id).filter(Boolean);
        const hasEffectiveMove = ids.some((id) => {
          const file = this.findFileByMoveId(id);
          const current = this.normalizeFolderPath(file?.metadata?.folderPath || '');
          return current !== targetFolderPath;
        });
        if (!hasEffectiveMove) {
          this.$message.info('所选文件已在目标目录');
          return false;
        }

        const idSet = new Set(ids);
        const previousRows = this.tableData.map((file) => ({
          ...file,
          metadata: { ...(file.metadata || {}) },
        }));
        const previousFolders = this.cloneFoldersSnapshot();
        const normalizedCurrentFolder = this.normalizeFolderPath(this.folderPath);
        const movedRows = this.tableData
          .filter((row) => this.isRowInMoveSet(row, idSet))
          .map((row) => ({
            name: this.getFileMoveId(row),
            sourceFolderPath: this.normalizeFolderPath(row?.metadata?.folderPath || ''),
          }));

        this.tableData = this.tableData
          .map((row) => {
            if (!this.isRowInMoveSet(row, idSet)) return row;
            return {
              ...row,
              metadata: {
                ...(row.metadata || {}),
                folderPath: targetFolderPath,
              },
              selected: false,
            };
          })
          .filter((row) => this.normalizeFolderPath(row?.metadata?.folderPath || '') === normalizedCurrentFolder);

        movedRows.forEach((moved) => {
          const sourceNode = (this.folders || []).find((folder) => {
            const candidate = this.normalizeFolderPath(folder.path || folder.folderPath || '');
            return candidate === moved.sourceFolderPath;
          });
          if (sourceNode && moved.sourceFolderPath !== targetFolderPath) {
            sourceNode.fileCount = Math.max(0, Number(sourceNode.fileCount || 0) - 1);
          }
        });
        if (targetFolderPath) {
          this.ensureFolderBranchLocal(targetFolderPath);
          const targetNode = (this.folders || []).find((folder) => {
            const candidate = this.normalizeFolderPath(folder.path || folder.folderPath || '');
            return candidate === targetFolderPath;
          });
          if (targetNode) {
            const addCount = movedRows.filter((item) => item.sourceFolderPath !== targetFolderPath).length;
            targetNode.fileCount = Number(targetNode.fileCount || 0) + addCount;
          }
        }
        this.sortFoldersLocal();
        this.updateStats();

        try {
          const result = await fetch('./api/manage/files/move-folder', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, files: filesPayload, targetFolderPath }),
          }).then((r) => r.json());
          if (!result.success) throw new Error(result.error || '移动失败');
          if (Number(result.moved || 0) === 0) {
            throw new Error('后端没有移动任何文件，请刷新列表后重试');
          }
          this.$message.success(`已移动 ${result.moved || 0} 个文件到 ${targetFolderPath || '根目录'}`);
          this.clearFolderCache();
          await this.fetchFolders();
          return true;
        } catch (error) {
          this.tableData = previousRows;
          this.folders = previousFolders;
          this.updateStats();
          throw error;
        }
      },
      resetViewConditions() {
        this.search = '';
        this.filterOption = 'all';
        this.storageFilter = 'all';
        this.fileType = 'all';
        this.folderPath = '';
        this.currentPage = 1;
        this.refreshFileList({ syncFolders: true });
        this.$message.success('已恢复默认筛选');
      },
      resolveDraggedIds(item) {
        if (!item || !item.name) return [];
        if (item.selected) {
          const selected = this.selectedFiles.map((file) => this.getFileMoveId(file)).filter(Boolean);
          if (selected.length > 0) return selected;
        }
        return [this.getFileMoveId(item)];
      },
      handleFileDragStart(item, event) {
        const ids = this.resolveDraggedIds(item);
        if (!ids.length) return;
        if (event?.currentTarget?.classList) {
          event.currentTarget.classList.add('dragging-file-card');
        }
        this.dragState.active = true;
        this.dragState.fileIds = ids;
        this.dragState.targetPath = null;
        document.body.classList.add('is-dragging-files');
        if (event && event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('application/x-kvault-files', JSON.stringify(ids));
          event.dataTransfer.setData('text/plain', ids.join(','));
          const dragGhost = document.createElement('div');
          dragGhost.textContent = ids.length > 1 ? `移动 ${ids.length} 个文件` : (item?.metadata?.fileName || item?.name || '移动文件');
          dragGhost.className = 'drag-ghost';
          document.body.appendChild(dragGhost);
          event.dataTransfer.setDragImage(dragGhost, 18, 16);
          requestAnimationFrame(() => dragGhost.remove());
        }
      },
      handleFileDragEnd() {
        if (this.dragState.leaveTimer) {
          clearTimeout(this.dragState.leaveTimer);
          this.dragState.leaveTimer = null;
        }
        if (this.dragState.rafId) {
          cancelAnimationFrame(this.dragState.rafId);
          this.dragState.rafId = null;
        }
        this.dragState.active = false;
        this.dragState.fileIds = [];
        this.dragState.targetPath = null;
        document.body.classList.remove('is-dragging-files');
        document.querySelectorAll('.dragging-file-card').forEach((node) => node.classList.remove('dragging-file-card'));
      },
      handleFolderSidebarDragOver(event) {
        if (!this.dragState.active) return;
        if (event?.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
        }
      },
      handleFolderDragOver(path, event) {
        if (!this.dragState.active) return;
        if (event && event.dataTransfer) {
          event.dataTransfer.dropEffect = 'move';
        }
        this.handleFolderDragEnter(path);
      },
      handleFolderDragEnter(path) {
        if (!this.dragState.active) return;
        const normalizedPath = this.normalizeFolderPath(path);
        if (this.dragState.leaveTimer) {
          clearTimeout(this.dragState.leaveTimer);
          this.dragState.leaveTimer = null;
        }
        if (this.dragState.targetPath === normalizedPath) return;
        if (this.dragState.rafId) {
          cancelAnimationFrame(this.dragState.rafId);
          this.dragState.rafId = null;
        }
        this.dragState.rafId = requestAnimationFrame(() => {
          this.dragState.targetPath = normalizedPath;
          this.dragState.rafId = null;
        });
      },
      handleFolderDragLeave(path, event) {
        if (!this.dragState.active) return;
        const currentTarget = event?.currentTarget;
        const relatedTarget = event?.relatedTarget;
        if (currentTarget && relatedTarget && currentTarget.contains(relatedTarget)) {
          return;
        }
        const normalizedPath = this.normalizeFolderPath(path);
        if (this.dragState.leaveTimer) {
          clearTimeout(this.dragState.leaveTimer);
        }
        this.dragState.leaveTimer = setTimeout(() => {
          if (this.dragState.targetPath === normalizedPath) {
            this.dragState.targetPath = null;
          }
          this.dragState.leaveTimer = null;
        }, 60);
      },
      extractDragIds(event) {
        if (this.dragState.fileIds.length > 0) return this.dragState.fileIds;
        const raw = event?.dataTransfer?.getData('application/x-kvault-files') || '';
        if (!raw) {
          const plain = event?.dataTransfer?.getData('text/plain') || '';
          return plain
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        }
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed.map((item) => String(item || '')).filter(Boolean) : [];
        } catch {
          return raw
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        }
      },
      async handleFolderDrop(path, event) {
        const targetFolderPath = this.normalizeFolderPath(path);
        this.dragState.targetPath = targetFolderPath;
        const ids = this.extractDragIds(event);
        if (!ids.length) {
          this.handleFileDragEnd();
          return;
        }
        const filesPayload = ids
          .map((id) => this.findFileByMoveId(id))
          .filter(Boolean)
          .map((file) => this.getFileMovePayload(file));

        const hasEffectiveMove = ids.some((id) => {
          const file = this.findFileByMoveId(id);
          const current = this.normalizeFolderPath(file?.metadata?.folderPath || '');
          return current !== targetFolderPath;
        });
        if (!hasEffectiveMove) {
          this.$message.info(`文件已在 ${targetFolderPath || '根目录'}`);
          this.handleFileDragEnd();
          return;
        }

        const idSet = new Set(ids);
        const previousRows = this.tableData.map((file) => ({
          ...file,
          metadata: { ...(file.metadata || {}) },
        }));
        const previousFolders = this.cloneFoldersSnapshot();
        const normalizedCurrentFolder = this.normalizeFolderPath(this.folderPath);
        const movedRows = this.tableData
          .filter((row) => this.isRowInMoveSet(row, idSet))
          .map((row) => ({
            name: this.getFileMoveId(row),
            sourceFolderPath: this.normalizeFolderPath(row?.metadata?.folderPath || ''),
          }));

        // 先本地更新，拖拽交互更流畅
        this.tableData = this.tableData
          .map((row) => {
            if (!this.isRowInMoveSet(row, idSet)) return row;
            return {
              ...row,
              metadata: {
                ...(row.metadata || {}),
                folderPath: targetFolderPath,
              },
              selected: false,
            };
          })
          .filter((row) => this.normalizeFolderPath(row?.metadata?.folderPath || '') === normalizedCurrentFolder);

        movedRows.forEach((moved) => {
          const sourceNode = (this.folders || []).find((folder) => {
            const candidate = this.normalizeFolderPath(folder.path || folder.folderPath || '');
            return candidate === moved.sourceFolderPath;
          });
          if (sourceNode && moved.sourceFolderPath !== targetFolderPath) {
            sourceNode.fileCount = Math.max(0, Number(sourceNode.fileCount || 0) - 1);
          }
        });
        if (targetFolderPath) {
          this.ensureFolderBranchLocal(targetFolderPath);
          const targetNode = (this.folders || []).find((folder) => {
            const candidate = this.normalizeFolderPath(folder.path || folder.folderPath || '');
            return candidate === targetFolderPath;
          });
          if (targetNode) {
            const addCount = movedRows.filter((item) => item.sourceFolderPath !== targetFolderPath).length;
            targetNode.fileCount = Number(targetNode.fileCount || 0) + addCount;
          }
        }
        this.sortFoldersLocal();
        this.updateStats();
        this.$message.info(`正在移动 ${ids.length} 个文件到 ${targetFolderPath || '根目录'}...`, { duration: 1200 });

        try {
          const result = await fetch('./api/manage/files/move-folder', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, files: filesPayload, targetFolderPath }),
          }).then((r) => r.json());
          if (!result.success) throw new Error(result.error || '拖拽移动失败');
          if (Number(result.moved || 0) === 0) {
            throw new Error('后端没有移动任何文件，请刷新列表后重试');
          }
          const folderLabel = targetFolderPath || '根目录';
          this.$message.success(`已移动 ${result.moved || 0} 个文件到 ${folderLabel}`);
          this.clearFolderCache();
          await this.fetchFolders();
        } catch (error) {
          this.tableData = previousRows;
          this.folders = previousFolders;
          this.updateStats();
          this.$message.error(error.message || '拖拽移动失败');
        } finally {
          this.handleFileDragEnd();
        }
      },
      goHome() { window.location.href = './'; },  // 返回首页
      refreshDashboard() { location.reload(); },  // 刷新页面
      startBatchDrag(event) {
        if (this.isMobileViewport) return;
        if (event.button !== 0) return;
        const toolbar = this.$refs.batchToolbar;
        if (!toolbar) return;
        const rect = toolbar.getBoundingClientRect();
        this.batchDragState.dragging = true;
        this.batchDragState.offsetX = event.clientX - rect.left;
        this.batchDragState.offsetY = event.clientY - rect.top;
        this.batchToolbarPosition.left = rect.left;
        this.batchToolbarPosition.top = rect.top;
        document.addEventListener('mousemove', this.onBatchDrag);
        document.addEventListener('mouseup', this.stopBatchDrag);
      },
      onBatchDrag(event) {
        if (!this.batchDragState.dragging) return;
        const toolbar = this.$refs.batchToolbar;
        if (!toolbar) return;
        const width = toolbar.offsetWidth;
        const height = toolbar.offsetHeight;
        const padding = 12;
        let left = event.clientX - this.batchDragState.offsetX;
        let top = event.clientY - this.batchDragState.offsetY;
        left = Math.max(padding, Math.min(left, window.innerWidth - width - padding));
        top = Math.max(padding, Math.min(top, window.innerHeight - height - padding));
        this.batchToolbarPosition.left = left;
        this.batchToolbarPosition.top = top;
      },
      stopBatchDrag() {
        if (this.isMobileViewport) return;
        if (!this.batchDragState.dragging) return;
        this.batchDragState.dragging = false;
        document.removeEventListener('mousemove', this.onBatchDrag);
        document.removeEventListener('mouseup', this.stopBatchDrag);
        this.snapBatchToolbarToBottom();
      },
      snapBatchToolbarToBottom() {
        if (this.isMobileViewport) {
          this.batchToolbarPosition.left = null;
          this.batchToolbarPosition.top = null;
          return;
        }
        const toolbar = this.$refs.batchToolbar;
        if (!toolbar) return;
        const padding = 12;
        const bottomOffset = 24;
        const width = toolbar.offsetWidth;
        const height = toolbar.offsetHeight;
        let left = this.batchToolbarPosition.left ?? (window.innerWidth - width) / 2;
        left = Math.max(padding, Math.min(left, window.innerWidth - width - padding));
        this.batchToolbarPosition.left = left;
        this.batchToolbarPosition.top = window.innerHeight - height - bottomOffset;
      },
      handleGlobalKeydown(event) {
        if (this.isMobileViewport && this.folderDrawerOpen) {
          if (event.key === 'Escape') {
            event.preventDefault();
            this.closeFolderDrawer();
            return;
          }
          if (event.key === 'Tab') {
            this.trapFolderDrawerFocus(event);
            return;
          }
        }
        if (this.selectedFiles.length === 0) return;
        const target = event.target;
        const isInput = target && (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        );
        if (isInput) return;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === 'c') {
          event.preventDefault();
          this.handleBatchCopy();
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          this.handleBatchDownload();
          return;
        }
        if (key === 'm') {
          event.preventDefault();
          this.moveSelectedToFolder();
          return;
        }
        if (key === 'delete' || key === 'backspace') {
          event.preventDefault();
          this.handleBatchDelete();
          return;
        }
        if (key === 'escape') {
          event.preventDefault();
          if (this.previewData) {
            this.closePreview();
          } else {
            this.clearSelection();
          }
        }
      },
      
      // 获取文件的实际类型（用于模板条件渲染）
      getActualFileType(fileName) {
        return memoFileValue(FILE_TYPE_CACHE, fileName, () => {
          const ext = String(fileName || '').split('.').pop().toLowerCase();
          if (this.fileConfig.image.exts.includes(ext)) return 'image';
          if (this.fileConfig.video.exts.includes(ext)) return 'video';
          if (this.fileConfig.audio.exts.includes(ext)) return 'audio';
          return 'document';  // 默认归类为文档
        });
      },
      
      // 打开预览 - 使用模态框（与首页保持一致，不跳转新标签页）
      openPreview(item) {
        this.revealPreview(item);
        const fileName = item.metadata?.fileName || item.name;
        const fileUrl = `${this.baseURL}/file/${item.name}`;
        const fileType = this.getActualFileType(item.name);

        // 图片类型 - 原生图片 Lightbox
        if (fileType === 'image') {
          this.previewData = {
            type: 'native-image',
            url: fileUrl,
            fileName: fileName,
            fileKey: item.name
          };
          return;
        }

        // 视频/音频/文档类型 - 使用本项目的 local preview iframe
        const previewParams = new URLSearchParams({
          url: fileUrl,
          title: fileName,
          autoplay: '0',
          embed: '1',
          size: String(item.metadata?.fileSize || 0),
          type: fileType
        });
        const iframeSrc = `${this.baseURL}/preview.html?${previewParams.toString()}`;

        this.previewData = {
          type: 'iframe',
          iframeUrl: iframeSrc,
          url: fileUrl,
          fileName: fileName,
          fileKey: item.name
        };
      },
      // 关闭预览弹窗
      closePreview() {
        if (this.$refs.previewIframe) {
          this.$refs.previewIframe.src = 'about:blank';
        }
        this.previewData = null;
      },
      // 关闭 el-image 大图查看器：范围切换时避免残留浮层遮挡新内容
      closeImageViewer() {
        const viewer = document.querySelector('.el-image-viewer__wrapper');
        if (!viewer) return;
        const closeBtn = viewer.querySelector('.el-image-viewer__close');
        if (closeBtn) closeBtn.click();
        else viewer.remove();
      },
      // 复制预览文件的直链
      copyPreviewLink() {
        if (!this.previewData) return;
        const link = this.previewData.url;
        const fallback = () => {
          this.copyToClipboardFallback(link);
          this.$message.success('直链已复制');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link)
            .then(() => this.$message.success('直链已复制'))
            .catch(() => fallback());
        } else {
          fallback();
        }
      },
      // 下载预览中的文件
      downloadPreviewFile() {
        if (!this.previewData) return;
        KVShared.downloadFile(this.previewData.url, this.previewData.fileName);
      },
      
      async handleLogout() {  // 退出登录
        try {
          const response = await fetch('./api/auth/logout', { method: 'POST', credentials: 'include' });
          // 清除本地存储的认证信息
          sessionStorage.clear();
          localStorage.removeItem('storageMode');
          // 退出后不再保留属于该会话的列表缓存。
          this.clearFolderCache();
          this.cacheOwner = '';
          
          // 尝试清除浏览器缓存的 Basic Auth 凭证
          // 通过发送一个带有错误凭证的请求来清除缓存
          try {
            await fetch('./api/manage/list', {
              method: 'GET',
              headers: { 'Authorization': 'Basic ' + btoa('logout:logout') },
              credentials: 'include'
            });
          } catch (e) { /* 忽略错误 */ }
          
          this.$message.success('已退出登录');
          // 跳转到登录页，禁止返回
          setTimeout(() => {
            window.location.replace('./login.html');
          }, 500);
        } catch (e) {
          this.$message.error('退出失败，请重试');
        }
      },
      handlePageChange(page) {
        this.currentPage = page;
        this.normalizeCurrentPage();
      },  // 切换页面
                  getListRequestLimit(forLoadMore = false) {
        const basePage = this.isMobileViewport ? 12 : 24;
        return forLoadMore ? basePage * 4 : basePage * 3;
      },
      buildListQueryParams({ cursor = null, limit = null, includeStats = true } = {}) {
        const params = new URLSearchParams();
        if (cursor !== null && cursor !== undefined && cursor !== '') {
          params.set('cursor', String(cursor));
        }
        params.set('limit', String(limit ?? this.getListRequestLimit(false)));
        if (includeStats) {
          params.set('includeStats', '1');
        }
        // 首屏优先取小文件，先让可见内容更快完成渲染
        params.set('sort', 'sizeAsc');
        params.set('folderPath', this.folderPath || '');
        if (this.storageFilter && this.storageFilter !== 'all') {
          params.set('storage', this.storageFilter);
        }
        return params;
      },
      // 切换排序方式
      // 切换筛选方式
      async switchStorageFilter(command) {
        this.storageFilter = command;
        this.currentPage = 1;
        await this.refreshFileList({ syncFolders: true });
      },  // 切换存储类型筛选
      async loadMore(options = {}) {
        const { silent = false, auto = false } = options;
        if (this.isLoadingMore || !this.nextCursor || !this.authReady || this.pageDisposed) return false;
        const scope = this.syncResourceScope();
        if (scope.key !== this.loadedScopeKey) return false;
        const seq = ++this.listRequestSeq;
        if (this.listAbortController) this.listAbortController.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        this.listAbortController = controller;
        this.isLoadingMore = true;
        const startCount = this.tableData.length;
        try {
          const params = this.buildListQueryParams({
            cursor: this.nextCursor,
            limit: this.getListRequestLimit(true),
            includeStats: true,
          });
          const result = await this.requestJson(`./api/manage/list?${params.toString()}`, {
            method: 'GET',
            controller,
          });
          if (!this.isCurrentListRequest(scope, seq)) return false;
          const mapped = (result.keys || []).map((file) => this.normalizeListItem(file));
          this.mergeListData(mapped);
          this.nextCursor = result.list_complete ? null : result.cursor;
          this.listComplete = Boolean(result.list_complete);
          this.applyEmptyPathMode(this.tableData);
          this.updateStats();
          this.writeFolderCache(this.getFolderCacheKey());
          this.normalizeCurrentPage();
          const loaded = Math.max(0, this.tableData.length - startCount);
          if (!silent) {
            if (this.nextCursor) {
              this.$message.success(`已补充 ${loaded} 条数据，可继续翻页`);
            } else if (!auto) {
              this.$message.success(`已加载剩余 ${loaded} 条`);
            }
          }
          return true;
        } catch (error) {
          if (this.pageDisposed || !this.isCurrentListRequest(scope, seq)) return false;
          if (error?.name === 'AbortError') return false;
          this.listError = error?.message || '加载更多失败，请稍后重试';
          this.listErrorPhase = 'more';
          this.handleResourceError(error);
          if (!silent) this.$message.error(this.listError);
          return false;
        } finally {
          if (seq === this.listRequestSeq) {
            this.isLoadingMore = false;
            if (this.listAbortController === controller) this.listAbortController = null;
          }
        }
      },
            formattedFileDetails(item) {
        const metadata = item.metadata;
        const rawDate = new Date(metadata.TimeStamp);
        const timestamp = detailTimeFormatter
          ? detailTimeFormatter.format(rawDate)
          : rawDate.toLocaleString('zh-CN');
        const storageType = this.getStorageType(item.name);
        const storageLabel = this.getStorageLabel(item.name);
        const fileSize = metadata.fileSize ? this.formatFileSize(metadata.fileSize) : '未知';
        const folderPath = this.normalizeFolderPath(metadata.folderPath || '');
        const esc = escapeDetailHtml;
        return `
          <div class="file-detail-card">
            <div><strong>ID：</strong>${esc(item.name)}</div>
            <div><strong>文件名：</strong>${esc(metadata.fileName || item.name)}</div>
            <div><strong>文件大小：</strong>${esc(fileSize)}</div>
            <div><strong>存储位置：</strong><span class="file-detail-storage storage-${esc(storageType)}">${esc(storageLabel)}</span></div>
            <div><strong>所在目录：</strong>${esc(folderPath || '根目录')}</div>
            <div><strong>上传时间：</strong>${esc(timestamp)}</div>
            <div><strong>状态：</strong>${esc(metadata.ListType || 'None')}</div>
          </div>
        `;
      },
      formatFileSize(bytes) {
        return KVShared.formatSize(bytes, { trim: true });
      },
      calculatePageSize() {  // 设置页面大小
        const config = {
          desktopMinSize: 20,
          desktopMaxSize: 25,
          mobileMinSize: 10,
          mobileMaxSize: 14,
          cardWidth: 240,
          ratio: 3/4, // 卡片高宽比
          gap: 20, // 卡片间距
          defaultWidth: 800,
          defaultHeaderHeight: 60 // 默认Dashboard高度
        };
        // 获取容器尺寸
        const content = document.querySelector('.disk-content') || document.querySelector('.content');
        const header = document.querySelector('.header-content');
        const width = content?.clientWidth || config.defaultWidth;
        const height = window.innerHeight - (header?.offsetHeight || config.defaultHeaderHeight);
        // 计算行列数
        const cols = Math.max(1, Math.floor(width / (config.cardWidth + config.gap)));
        const cardHeight = Math.max(120, (width / cols - config.gap) * config.ratio);
        const rows = Math.max(1, Math.floor(height / (cardHeight + config.gap)));
        const estimated = rows * cols;
        if (this.isMobileViewport) {
          this.pageSize = Math.max(config.mobileMinSize, Math.min(config.mobileMaxSize, estimated));
        } else {
          this.pageSize = Math.max(config.desktopMinSize, Math.min(config.desktopMaxSize, estimated));
        }
      },
            normalizeCurrentPage() {
        const totalPages = Math.max(1, Math.ceil((this.paginationTotal || 0) / this.pageSize));
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        if (this.currentPage < 1) this.currentPage = 1;
      },
      handleWindowResize() {
        this.updateViewportFlags();
        this.updateWindowWidth();
        this.normalizeCurrentPage();
        if (this.selectedFiles.length > 0 && !this.isMobileViewport) {
          this.$nextTick(() => this.snapBatchToolbarToBottom());
        }
      },
      updateStats() {
        this.Number = this.tableData.length;
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
            async refreshFileList(options = {}) {  // 不刷新页面，仅更新数据
        const { syncFolders = false, preferCache = false, force = false, silent = false } = options;
        if (!this.authReady || this.pageDisposed) return false;
        const scope = this.syncResourceScope();
        const cacheKey = scope.key;

        if (preferCache && !force) {
          const cached = this.readFolderCache(cacheKey);
          if (cached) {
            this.applyFolderCacheEntry(cached);
            this.currentPage = 1;
            this.refreshFileList({ syncFolders, force: true, silent: true }).catch(() => {});
            return true;
          }
        }

        const seq = ++this.listRequestSeq;
        if (this.listAbortController) this.listAbortController.abort();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        this.listAbortController = controller;
        this.listLoading = true;
        this.listError = '';
        this.listErrorPhase = '';
        this.listNeedsRefresh = false;
        try {
          const params = this.buildListQueryParams({
            limit: this.getListRequestLimit(false),
            includeStats: true,
          });
          const result = await this.requestJson(`./api/manage/list?${params.toString()}`, {
            method: 'GET',
            controller,
          });
          if (!this.isCurrentListRequest(scope, seq)) return false;
          const mapped = (result.keys || []).map((file) => this.normalizeListItem(file));
          this.tableData = mapped;
          this.nextCursor = result.list_complete ? null : result.cursor;
          this.listComplete = Boolean(result.list_complete);
          this.listLoaded = true;
          this.listFromCache = false;
          this.loadedScopeKey = cacheKey;
          this.applyEmptyPathMode(mapped);
          this.updateStats();
          this.calculatePageSize();
          this.sortData(this.tableData);
          this.normalizeCurrentPage();
          this.writeFolderCache(cacheKey);
          if (syncFolders) await this.fetchFolders({ silent });
          return true;
        } catch (error) {
          if (this.pageDisposed || !this.isCurrentListRequest(scope, seq)) return false;
          if (error?.name === 'AbortError') return false;
          this.listError = error?.message || '刷新文件列表失败，请检查网络连接';
          this.listErrorPhase = 'list';
          this.handleResourceError(error);
          if (!silent) this.$message.error(this.listError);
          return false;
        } finally {
          if (seq === this.listRequestSeq) {
            this.listLoading = false;
            if (this.listAbortController === controller) this.listAbortController = null;
          }
        }
      },
                  handleDelete(index, key) {
        const isR2 = key.startsWith('r2:');
        const storageInfo = isR2 ? 'R2 存储和 KV 记录' : 'KV 记录';
        this.$confirm(`此操作将永久删除该文件的 ${storageInfo}, 是否继续?`, '提示', {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning'
        }).then(() => {
          const encodedKey = encodeURIComponent(key);
          fetch(`./api/manage/delete/${encodedKey}`, { method: 'GET', credentials: 'include' })
            .then(response => {
              if (!response.ok) throw new Error('删除失败');
              return response.json();
            })
            .then(result => {
              if (result.success) {
                // 从本地数据中移除
                const fileIndex = this.tableData.findIndex(f => f.name === key);
                if (fileIndex !== -1) {
                  this.tableData.splice(fileIndex, 1);
                }
                this.updateStats();
                this.clearFolderCache();
                this.$message.success('删除成功！');
              } else {
                throw new Error(result.error || '删除失败');
              }
            })
            .catch(err => this.$message.error('删除失败: ' + err.message));
        }).catch(() => this.$message.info('已取消删除'));
      },
                        // 批处理相关
      handleBatchDelete() {  // 批量删除
        const r2Count = this.selectedFiles.filter(f => f.name.startsWith('r2:')).length;
        const tgCount = this.selectedFiles.length - r2Count;
        let msg = `此操作将永久删除这 ${this.selectedFiles.length} 个文件`;
        if (r2Count > 0 && tgCount > 0) {
          msg += ` (其中 ${r2Count} 个 R2 文件将完全删除, ${tgCount} 个 Telegram 文件仅删除 KV 记录)`;
        } else if (r2Count > 0) {
          msg += ` (将从 R2 存储和 KV 中完全删除)`;
        }
        msg += ', 是否继续?';
        
        this.$confirm(msg, '提示', {
          confirmButtonText: '确定',
          cancelButtonText: '取消',
          type: 'warning'
        }).then(() => {
          const promises = this.selectedFiles.map(file => {
            const encodedKey = encodeURIComponent(file.name);
            return fetch(`./api/manage/delete/${encodedKey}`, { method: 'GET', credentials: 'include' })
              .then(r => r.json())
              .then(result => ({ name: file.name, success: result.success }))
              .catch(() => ({ name: file.name, success: false }));
          });

          Promise.all(promises)
            .then(results => {
              let successCount = 0;
              let failedCount = 0;
              results.forEach(result => {
                if (result.success) {
                  const fileIndex = this.tableData.findIndex(file => file.name === result.name);
                  if (fileIndex !== -1) {
                    this.tableData.splice(fileIndex, 1);
                    successCount++;
                  }
                } else {
                  failedCount++;
                }
              });
              this.clearSelection();
              this.updateStats();
              if (successCount > 0 && failedCount === 0) {
                this.$message.success(`成功删除 ${successCount} 个文件!`);
              } else if (successCount > 0 && failedCount > 0) {
                this.$message.warning(`删除完成: ${successCount} 成功, ${failedCount} 失败`);
              } else {
                this.$message.error('删除失败');
              }
            })
            .catch(() => this.$message.error('批量删除失败，请检查网络连接'));
        }).catch(() => this.$message.info('已取消批量删除'));
      },
      handleBatchOperation(command) {
        // 全选操作不需要检查已选文件
        if (command === 'selectAll') {
          this.selectAllInPage();
          return;
        }
        if (command === 'selectAllLoaded') {
          this.selectAllLoaded();
          return;
        }
        if (this.selectedFiles.length === 0) { this.$message.warning('请先选择文件'); return; }
        switch (command) {
          case 'copy': this.handleBatchCopy(); break;
          case 'copyMarkdown': this.handleBatchCopyMarkdown(); break;
          case 'copyHtml': this.handleBatchCopyHtml(); break;
          case 'delete': this.handleBatchDelete(); break;
          case 'download': this.handleBatchDownload(); break;
          case 'moveFolder': this.moveSelectedToFolder(); break;
          case 'block': this.handleBatchBlockOrUnblock('Block'); break;
          case 'unblock': this.handleBatchBlockOrUnblock('White'); break;
        }
      },
      // 全选当前页
      selectAllInPage() {
        const newState = !this.isAllSelected;
        this.paginatedData.forEach(file => file.selected = newState);
        this.$message.success(newState ? `已选中当前页 ${this.paginatedData.length} 项` : '已取消选择');
      },
      // 全选已加载的所有数据
      selectAllLoaded() {
        const allSelected = this.tableData.every(f => f.selected);
        this.tableData.forEach(file => file.selected = !allSelected);
        this.$message.success(!allSelected ? `已选中全部 ${this.tableData.length} 项` : '已取消选择');
      },
      // 工具相关
      handleToolkit(command) {
        switch (command) {
          case 'selectAllInPage': this.selectAllInPage(); break;
          case 'checkBrokenFiles': this.checkBrokenFiles(); break;
          case 'editWebsites': this.editWebsites(); break;
          case 'openUploader': this.openUploader(); break;
          case 'exportLinks': this.exportAllLinks(); break;
          case 'manageApiTokens': this.openApiTokenDialog(); break;
          case 'checkStatus': this.checkConnectionStatus(); break;
        }
      },
      // 检查连接状态
      async checkConnectionStatus() {
        const loading = this.$message({ message: '正在检查连接状态...', duration: 0 });
        try {
          const response = await fetch('./api/status', { credentials: 'include' });
          const status = await response.json();
          this.systemStatus = {
            ...this.systemStatus,
            ...(status || {}),
            github: status?.github || this.systemStatus.github,
          };
          loading.close();
          
          // 显示详细状态对话框
          const statusHtml = `
            <div class="status-dialog">
              <p><i data-lucide="bot" class="status-icon"></i> <b>Telegram:</b>
                <span class="${status.telegram.connected ? 'status-ok' : 'status-fail'}">
                  ${status.telegram.connected ? '✓' : '✗'} ${status.telegram.message}
                </span>
              </p>
              <p><i data-lucide="database" class="status-icon"></i> <b>KV 存储:</b>
                <span class="${status.kv.connected ? 'status-ok' : 'status-fail'}">
                  ${status.kv.connected ? '✓' : '✗'} ${status.kv.message}
                </span>
              </p>
              <p><i data-lucide="cloud" class="status-icon"></i> <b>R2 存储:</b>
                <span class="${status.r2.connected ? 'status-ok' : (this.isUnconfiguredStatus(status.r2) ? 'status-unset' : 'status-fail')}">
                  ${status.r2.connected ? '✓' : (this.isUnconfiguredStatus(status.r2) ? '○' : '✗')} ${status.r2.message}
                </span>
              </p>
              <p><i data-lucide="database" class="status-icon status-icon--s3"></i> <b>S3 存储:</b>
                <span class="${status.s3?.connected ? 'status-ok' : (this.isUnconfiguredStatus(status.s3) ? 'status-unset' : 'status-fail')}">
                  ${status.s3?.connected ? '✓' : (this.isUnconfiguredStatus(status.s3) ? '○' : '✗')} ${status.s3?.message || '未知'}
                </span>
              </p>
              <p><i class="fab fa-discord status-icon status-icon--discord"></i> <b>Discord:</b>
                <span class="${status.discord?.connected ? 'status-ok' : (this.isUnconfiguredStatus(status.discord) ? 'status-unset' : 'status-fail')}">
                  ${status.discord?.connected ? '✓' : (this.isUnconfiguredStatus(status.discord) ? '○' : '✗')} ${status.discord?.message || '未知'}
                </span>
              </p>
              <p><i data-lucide="bot" class="status-icon status-icon--huggingface"></i> <b>HuggingFace:</b>
                <span class="${status.huggingface?.connected ? 'status-ok' : (this.isUnconfiguredStatus(status.huggingface) ? 'status-unset' : 'status-fail')}">
                  ${status.huggingface?.connected ? '✓' : (this.isUnconfiguredStatus(status.huggingface) ? '○' : '✗')} ${status.huggingface?.message || '未知'}
                </span>
              </p>
              <p><i class="fab fa-github status-icon status-icon--github"></i> <b>GitHub:</b>
                <span class="${status.github?.connected ? 'status-ok' : (this.isUnconfiguredStatus(status.github) ? 'status-unset' : 'status-fail')}">
                  ${status.github?.connected ? '✓' : (this.isUnconfiguredStatus(status.github) ? '○' : '✗')} ${status.github?.message || '未知'}
                </span>
              </p>
              <p><i data-lucide="lock" class="status-icon"></i> <b>身份验证:</b>
                <span class="${status.auth.enabled ? 'status-ok' : 'status-unset'}">
                  ${status.auth.enabled ? '✓' : '○'} ${status.auth.message}
                </span>
              </p>
            </div>
          `;
          
          this.$alert(statusHtml, '系统连接状态', {
            dangerouslyUseHTMLString: true,
            confirmButtonText: '确定'
          });
        } catch (error) {
          loading.close();
          this.$message.error('检查状态失败: ' + error.message);
        }
      },
                  switchFileType(type, showMessage = true) {  // 切换文件类型
        this.fileType = type;
        this.currentPage = 1;
        localStorage.setItem('fileType', type);
        if (showMessage) {
          this.$message({
            message: `已切换为${this.fileConfig[type].name}模式, 共${this.fileConfig[type].count}个文件`,
            type: 'success',
            duration: 1500
          });
        }
      },
      // 处理网站点击
            // 编辑快捷方式
            getFileIcon(filename) {
        return memoFileValue(FILE_ICON_CACHE, filename, () => KVShared.fileIconOf(filename));
      },
                  // 加载设置处理
      handleLoadSettings(command) {
        if (command === 'safeMode') {
          this.safeMode = !this.safeMode;
          localStorage.setItem('safeMode', this.safeMode);
          this.$message.success(this.safeMode ? '安全模式已开启' : '安全模式已关闭');
        } else if (command === 'loginBackground' || command === 'uiDesign') {
          this.showUiDesignSettingsPanel();
        } else {
          this.loadMode = command;
          localStorage.setItem('loadMode', command);
          const modeNames = { normal: '正常模式', dataSaver: '省流模式', noImage: '无图模式' };
          this.$message.success(`已切换为${modeNames[command]}`);
        }
      },
      getPreviewKey(item) {
        return String(item?.name || item?.metadata?.fileName || '');
      },
      isPreviewRevealed(item) {
        const key = this.getPreviewKey(item);
        return Boolean(key && this.revealedPreviewKeys[key]);
      },
      revealPreview(item) {
        const key = this.getPreviewKey(item);
        if (!key || this.isPreviewRevealed(item)) return;
        this.$set(this.revealedPreviewKeys, key, true);
      },
      isPreviewGated(item, explicitType = '') {
        return !this.isPreviewRevealed(item) && !this.shouldAutoLoadPreview(item, explicitType);
      },
      shouldAutoLoadPreview(item, explicitType = '') {
        if (!item) return false;
        if (this.isNsfwContent(item)) return false;
        if (this.loadMode === 'noImage') return false;

        const type = explicitType || this.getActualFileType(item.name);
        const size = Number(item.metadata?.fileSize || 0);

        if (type === 'video' || type === 'audio') {
          return false;
        }

        if (type === 'image') {
          const normalImageLimit = 12 * 1024 * 1024;
          const dataSaverLimit = 5 * 1024 * 1024;
          if (this.loadMode === 'dataSaver') return size > 0 && size <= dataSaverLimit;
          return size <= 0 || size <= normalImageLimit;
        }

        return false;
      },
      getPreviewGateTitle(item, explicitType = '') {
        if (this.isNsfwContent(item)) return '敏感预览已模糊';
        const type = explicitType || this.getActualFileType(item.name);
        const labels = {
          image: '点击唤醒图片预览',
          video: '点击唤醒视频预览',
          audio: '点击唤醒音频预览',
        };
        return labels[type] || '预览已暂停';
      },
      getPreviewGateSubtitle(item, explicitType = '') {
        const size = Number(item?.metadata?.fileSize || 0);
        const sizeLabel = size > 0 ? ` · ${this.formatFileSize(size)}` : '';
        const type = explicitType || this.getActualFileType(item?.name || '');
        if (this.isNsfwContent(item)) return `点击解除模糊并加载粗预览${sizeLabel}`;
        if (this.loadMode === 'noImage') return `无图模式，本次点击后加载${sizeLabel}`;
        if (type === 'video') return `先不读取媒体资源，点击后只加载元数据${sizeLabel}`;
        if (type === 'audio') return `先不读取音频资源，点击后加载播放器${sizeLabel}`;
        return `点击后再读取文件资源${sizeLabel}`;
      },
            // 检查是否为NSFW内容
      isNsfwContent(item) {
        return this.safeMode && item.metadata?.Label?.toLowerCase() === 'adult';
      }
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
        this.authReady = true;
        const identity = String(authData.username || authData.user || '').trim();
        // 缓存归属随身份变化，避免不同会话复用同一份列表缓存。
        this.cacheOwner = `${authData.authRequired ? 'auth' : 'open'}:${
          authData.authenticated ? (identity || 'session') : 'anonymous'
        }`;
      } catch (e) {
        this.authReady = false;
        this.$message.error('认证检查失败，请刷新页面');
        return;
      }

      window.addEventListener('resize', this.handleWindowResize);
      window.addEventListener('orientationchange', this.handleWindowResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', this.handleWindowResize);
      }
      window.addEventListener('keydown', this.handleGlobalKeydown);
      this.restoreFolderCache();
      this.updateViewportFlags();
      this.updateWindowWidth();
      this.$nextTick(() => {
        this.observeMobileNavHeight();
        this.queueMobileNavMetricsUpdate();
      });

      // 恢复设置
      this.sortOption = localStorage.getItem('sortOption') || this.sortOption;
      this.filterOption = localStorage.getItem('filterOption') || this.filterOption;
      this.fileType = localStorage.getItem('fileType') || this.fileType;
      this.loadMode = localStorage.getItem('loadMode') || this.loadMode;
      this.safeMode = localStorage.getItem('safeMode') !== 'false';
      const savedViewMode = localStorage.getItem('adminViewMode');
      if (savedViewMode === 'grid' || savedViewMode === 'list') this.viewMode = savedViewMode;
      this.viewMounted[this.viewMode] = true;
      if (this.viewMode === 'list') this.viewMounted.grid = false; // 恢复列表视图时跳过网格首挂载，避免双份初始渲染
      this.folderPath = this.normalizeFolderPath(localStorage.getItem('adminFolderPath') || '');

      // 获取文件列表数据
      try {
        await this.refreshFileList({ syncFolders: true });
        this.sortData(this.tableData);
        // 初始化时不显示切换消息
        this.switchFileType(this.fileType, false);
        if (this.tableData.length > 0 && this.filteredTableData.length === 0) {
          this.search = '';
          this.filterOption = 'all';
          this.storageFilter = 'all';
          this.fileType = 'all';
          this.folderPath = '';
          await this.refreshFileList({ syncFolders: true });
          this.$message.warning('检测到筛选条件无匹配，已自动恢复默认视图');
        }
      } catch {
        this.$message.error('同步数据时出错，请检查网络连接');
      }

      // 检查系统连接状态
      fetch('./api/status', { credentials: 'include' })
        .then(response => response.json())
        .then(status => {
          this.systemStatus = {
            ...this.systemStatus,
            ...(status || {}),
            github: status?.github || this.systemStatus.github,
          };
        })
        .catch(() => {});

      // 恢复快捷方式设置
      if (localStorage.getItem('quickWebsites')) {
        this.quickWebsites = JSON.parse(localStorage.getItem('quickWebsites'));
      }
    }
    ,
    beforeDestroy() {
      this.pageDisposed = true;
      this.invalidateListRequest();
      this.invalidateFolderRequest();
      this.requestTimers.forEach((timer) => clearTimeout(timer));
      this.requestTimers = [];
      this.managedControllers.forEach((controller) => {
        try { controller.abort(); } catch { /* 已结束的请求无需处理。 */ }
      });
      this.managedControllers = [];
      document.body.classList.remove('is-dragging-files');
      if (this.dragState.leaveTimer) {
        clearTimeout(this.dragState.leaveTimer);
        this.dragState.leaveTimer = null;
      }
      if (this.dragState.rafId) {
        cancelAnimationFrame(this.dragState.rafId);
        this.dragState.rafId = null;
      }
      document.removeEventListener('mousemove', this.onBatchDrag);
      document.removeEventListener('mouseup', this.stopBatchDrag);
      window.removeEventListener('keydown', this.handleGlobalKeydown);
      window.removeEventListener('resize', this.handleWindowResize);
      window.removeEventListener('orientationchange', this.handleWindowResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this.handleWindowResize);
      }
      this.unobserveMobileNavHeight();
      if (this.mobileNavMetricsRaf) {
        cancelAnimationFrame(this.mobileNavMetricsRaf);
        this.mobileNavMetricsRaf = 0;
      }
      document.documentElement.style.removeProperty('--nav-height');
      document.documentElement.style.removeProperty('--nav-offset');
    }
  });
