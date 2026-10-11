/**
 * 两个后台页面共享的 Vue 选项。
 *
 * admin.html 与 admin-imgtc.html 之间曾有 24 个方法逐字重复（合计约 7.2 KB）。
 * 副本最典型的故障是「改了一处忘了另一处」——这个仓库没有打包步骤，
 * 没有编译器会提醒你两份已经不一致了，所以把逐字相同的部分收进这里。
 *
 * 用法（必须在 new Vue 之前加载）：
 *
 *   new Vue({
 *     el: '#app',
 *     data: { ... },
 *     methods: Object.assign({}, window.KVAdminShared.methods, {
 *       // 本页特有的方法
 *     }),
 *     computed: Object.assign({}, window.KVAdminShared.computed, { ... }),
 *     watch: Object.assign({}, window.KVAdminShared.watch, { ... }),
 *   });
 *
 * 注意：这里的方法通过 this 访问页面状态，但**不要求两页拥有相同的 data**：
 * 只引用两页都存在、且语义一致的字段（如 tableData / sortOption / filterOption）。
 * 往这里加方法前先确认这一点，否则会把只在某一页成立的假设带进另一页。
 *
 * 这两页还有一批「同名但实现已经不同」的方法（handleDelete、refreshFileList、
 * calculatePageSize 等），它们没有被收进来——合并它们会改变行为。要合并必须先
 * 确认差异是历史遗留还是真实需求。
 */
(function () {
  "use strict";

  /** 与页面状态配合的方法。this 指向调用它的 Vue 实例。 */
  var methods = {
  copyToClipboardFallback(text) {
    // 具体实现收口在 kv-shared.js（Clipboard API 优先、隐藏 textarea 回退）；
    // 这里保留方法名是因为两个后台页的既有调用点都走 this.copyToClipboardFallback。
    return KVShared.copyToClipboard(text);
  },
  mergeListData(files) {
    const map = new Map(this.tableData.map((item) => [item.name, item]));
    files.forEach((item) => {
      if (!item || !item.name) return;
      const prev = map.get(item.name);
      map.set(item.name, prev ? { ...prev, ...item, selected: prev.selected || item.selected } : item);
    });
    this.tableData = Array.from(map.values());
  },
  normalizeListItem(file) {
    return {
      ...file,
      selected: false,
      metadata: {
        ...file.metadata,
        liked: file.metadata?.liked ?? false,
        fileName: file.metadata?.fileName ?? file.name,
        fileSize: file.metadata?.fileSize ?? 0,
      },
    };
  },
  sortData(data) {
    return this.sortOption === 'nameAsc' ? data.sort((a, b) => a.name.localeCompare(b.name)) :
      this.sortOption === 'sizeDesc' ? data.sort((a, b) => b.metadata.fileSize - a.metadata.fileSize) :
      data.sort((a, b) => b.metadata.TimeStamp - a.metadata.TimeStamp);
  },
  toggleSelect(index, name) {
    const fileIndex = this.tableData.findIndex(file => file.name === name);
    this.tableData[fileIndex].selected = !this.tableData[fileIndex].selected;
  },
  getFileType(filename) {
    const ext = filename.split('.').pop();
    return `${ext.toUpperCase()}`;
  },
  openUploader() {  // 打开上传中心
    window.open('./', '_blank');
  },
  filter(command) { this.filterOption = command; },
  // 处理网站点击
  handleWebsite(url) { window.open(url, '_blank'); },
  sort(command) { this.sortOption = command; },
  // 编辑快捷方式
  editWebsites() {
    const websiteText = this.quickWebsites
      .map(site => `${site.name}|${site.url}|${site.icon}`)
      .join('\n');

    this.$prompt('', '编辑快捷方式', {
      inputType: 'textarea',
      inputValue: websiteText,
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      dangerouslyUseHTMLString: true,
      customClass: 'website-edit-dialog',
      message: `
        <div>
          每行一个网站，格式：名称|网址|图标类名<br>
          图标需在 <a href="https://lucide.dev/icons/" target="_blank" class="msg-link">Lucide</a> 中选择
        </div>
      `,
      inputValidator: (value) => {
        const lines = value.split('\n');
        if (lines.length > 10) return '不能超过10行';
        for (let line of lines) {
          if (!line.trim()) continue;
          const [name, url, icon = 'link'] = line.split('|');
          if (!name || !url) return '名称和网址不能为空：' + line;
          if (!(/^https?:\/\/.+/.test(url) || /^\.\/.*/.test(url))) return '网址格式错误：'+line;
          if (!/^(?:[a-z0-9]+(?:-[a-z0-9]+)*|(?:fab|fa-brands)\s+fa-[a-z0-9-]+|(?:fas|far|fa-solid|fa-regular)\s+fa-[a-z0-9-]+)$/.test(icon)) {
            return '图标类名格式错误：' + line;
          }
        }
        return true;
      }
    }).then(({ value }) => {
      const newSites = value.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [name, url, icon = 'link'] = line.split('|');
          return { name, url, icon };
        });
      this.quickWebsites = newSites;
      localStorage.setItem('quickWebsites', JSON.stringify(newSites));
      this.$message.success('保存成功');
    }).catch(() => {});
  },
  toggleLike(index, name) {
    console.log(`Toggling like for : ${name}`);
    const fileIndex = this.tableData.findIndex(file => file.name === name);
    // 乐观更新收藏状态
    this.tableData[fileIndex].metadata.liked = !(this.tableData[fileIndex].metadata.liked ?? false);
    // 发送请求更新服务器数据
    var requestOptions = { method: 'GET', redirect: 'follow', credentials: 'include' };
    fetch(`./api/manage/toggleLike/${name}`, requestOptions)
      .then(response => response.json())
      .then(result => {
        if (!result.success) {  // 如果服务器更新失败，将状态还原
          this.tableData[fileIndex].metadata.liked = !this.tableData[fileIndex].metadata.liked;
          this.$message({message: '更新收藏状态失败，请稍后重试', type: 'error'});
        } else {
          this.$message.success(this.tableData[fileIndex].metadata.liked ? '收藏成功' : '取消收藏');
        }
      })
      .catch(error => { // 如果服务器响应错误，将状态还原
        this.tableData[fileIndex].metadata.liked = !this.tableData[fileIndex].metadata.liked;
        this.$message({message: '同步服务器失败，请检查网络连接', type: 'error'});
      });
  },
  handleEditName(item) {
    this.$prompt('', '修改文件名', {
      inputValue: item.metadata?.fileName || item.name,
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValidator: (value) => {
        if (!value) return '文件名不能为空';
        if (value.length > 64) return '文件名不能超过64个字符';
        return true;
      }
    }).then(({ value }) => {
      fetch(`./api/manage/editName/${item.name}?newName=${encodeURIComponent(value)}`, {
        method: 'GET',
        credentials: 'include'
      })
      .then(response => response.json())
      .then(result => {
        if (result.success) {
          item.metadata.fileName = value;
          this.$message.success('文件名修改成功');
        } else {
          this.$message.error('文件名修改失败');
        }
      })
      .catch(() => this.$message.error('修改文件名时出错，请检查网络连接'));
    }).catch(() => {});
  },
  handleQuickCopy(format, key) {  // 快速复制不同格式
    const url = `${this.baseURL}/file/${key}`;
    const file = this.tableData.find(f => f.name === key);
    const name = file?.metadata?.fileName || key;
    const link = KVShared.formatLink(url, name, format);

    (navigator.clipboard?.writeText(link) || this.copyToClipboardFallback(link))
      .then(() => this.$message.success(`${format.toUpperCase()} 格式链接已复制~`))
      .catch(() => this.$message.error('复制失败'));
  },
  exportAllLinks() {  // 导出全部链接
    const loading = this.$message({ message: '正在生成链接列表...', duration: 0 });
    const links = this.tableData.map(file => `${document.location.origin}/file/${file.name}`);
    const linksText = links.join('\n');

    // 创建下载文件
    const blob = new Blob([linksText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `image-links-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    loading.close();
    this.$message.success(`已导出 ${links.length} 个链接`);
  },
  handleBatchCopyHtml() {  // 批量复制HTML格式
    const links = this.selectedFiles.map(file => {
      const url = `${document.location.origin}/file/${file.name}`;
      const name = file.metadata?.fileName || file.name;
      return KVShared.formatLink(url, name, 'html');
    }).join('\n');
    (navigator.clipboard?.writeText(links) || this.copyToClipboardFallback(links))
      .then(() => this.$message.success('HTML格式链接已复制~'));
  },
  handleBatchCopyMarkdown() {  // 批量复制Markdown格式
    const links = this.selectedFiles.map(file => {
      const url = `${document.location.origin}/file/${file.name}`;
      const name = file.metadata?.fileName || file.name;
      return KVShared.formatLink(url, name, 'markdown');
    }).join('\n');
    (navigator.clipboard?.writeText(links) || this.copyToClipboardFallback(links))
      .then(() => this.$message.success('Markdown格式链接已复制~'));
  },
  handleBatchCopy() {  // 批量复制链接
    const links = this.selectedFiles.map(file => `${document.location.origin}/file/${file.name}`).join('\n');
    (navigator.clipboard?.writeText(links) || this.copyToClipboardFallback(links))
      .then(() => this.$message.success('批量复制链接成功~'));
  },
  handleCopy(index, key) {
    const link = `${this.baseURL}/file/${key}`;
    (navigator.clipboard?.writeText(link) || this.copyToClipboardFallback(link))
      .then(() => this.$message.success('复制文件链接成功~'))
      .catch(() => this.$message.error('自动复制失败，请手动复制链接：' + link));
  },
  handleBatchDownload() {  // 批量下载
    this.$message.info(`正在下载 ${this.selectedFiles.length} 个文件`, { duration: 1000 });
    this.selectedFiles.forEach((file, index) => {
      setTimeout(() => {
        KVShared.downloadFile(`/file/${file.name}`, file.metadata.fileName || file.name);
      }, index * 800);
    });
    this.clearSelection();
  },
  handleBatchBlockOrUnblock(type) {  // 批量加入黑/白名单
    if (type !== 'Block' && type !== 'White') { this.$message.error('无效的操作类型'); return; }
    const typeToName = { Block: '黑名单', White: '白名单' };
    this.$confirm(`确定要将这 ${this.selectedFiles.length} 个文件加入${typeToName[type]}吗?`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      const promises = this.selectedFiles.map(file => fetch(`./api/manage/${type.toLowerCase()}/${file.name}`, { method: 'GET', credentials: 'include' }));

      Promise.all(promises)
        .then(responses => {
          responses.forEach((response, index) => {
            if (response.ok) {
              const fileIndex = this.tableData.findIndex(item => item.name === this.selectedFiles[index].name);
              if (fileIndex !== -1) {
                this.tableData[fileIndex].metadata.ListType = type;
              }
            }
          });
          this.$message.success(`批量加入${typeToName[type]}成功`);
          this.clearSelection();
        })
        .catch(() => this.$message.error(`操作失败，请检查网络连接`));
    });
  },
  clearSelection() {  // 取消全部选择
    // 必须清底层的 file.selected，不能只写 this.selectedFiles = []：
    // 模板上的勾选态绑定的是 item.selected（el-checkbox 的 v-model、
    // 卡片的 :class="{ selected: item.selected }"），而 selectedFiles 只是
    // 由 watch:tableData(deep) 回填出来的派生副本。只清副本的话勾选标记还在，
    // 而且 tableData 下次有任何深层变动，watch 会按底层 true 值把它重新填回来
    // ——表现就是「取消选择后又自己选上了」。
    this.tableData.forEach(file => { file.selected = false; });
  },
  checkBrokenFiles() {  // 检测失效文件
    // 依赖的 data 字段：tableData、baseURL、pageDisposed、brokenCheckSeq/
    // brokenCheckController/brokenCheckMessage（后三者两页 data 都要声明）。
    // 采用 admin.html 的重写版：空列表直接提示、可取消（AbortController）、
    // 正确按 item 记账——admin-imgtc 的旧版用 tableData 下标去索引
    // selectedFiles[index].name，未全选时必然 TypeError。
    const targets = this.tableData.slice();
    if (targets.length === 0) {
      this.$message.info('当前没有可检测的已加载文件');
      return;
    }
    this.cancelBrokenCheck();
    const seq = ++this.brokenCheckSeq;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    this.brokenCheckController = controller;
    this.brokenCheckMessage = this.$message({ message: '正在检测失效文件...', duration: 0 });

    let brokenCount = 0;
    const promises = targets.map((item) => new Promise((resolve) => {
      fetch(`${this.baseURL}/file/${item.name}`, {
        method: 'HEAD',
        cache: 'no-cache',  // 避免缓存影响检测结果
        signal: controller ? controller.signal : undefined
      })
        .then(response => {
          if (!response.ok) {
            brokenCount++;
            item.selected = true;
          }
          resolve();
        })
        .catch(() => {
          if (controller && controller.signal.aborted) { resolve(); return; }
          brokenCount++;
          item.selected = true;
          resolve();
        });
    }));

    Promise.all(promises).then(() => {
      if (seq !== this.brokenCheckSeq || this.pageDisposed) return;
      this.brokenCheckController = null;
      if (this.brokenCheckMessage) {
        this.brokenCheckMessage.close();
        this.brokenCheckMessage = null;
      }
      if (brokenCount > 0) {
        this.$message({
          dangerouslyUseHTMLString: true,
          message: `检测到 ${brokenCount} 个失效文件，已自动选中。<br>您可以使用批量删除功能移除它们。`,
          type: 'warning',
          duration: 5000
        });
      } else {
        this.$message({
          message: '未检测到失效文件',
          type: 'success'
        });
      }
    });
  },
  // 取消进行中的失效检测：范围切换或重新检测时调用，避免旧结果回填
  cancelBrokenCheck() {
    this.brokenCheckSeq += 1;
    if (this.brokenCheckController) {
      try { this.brokenCheckController.abort(); } catch { /* 请求已结束。 */ }
      this.brokenCheckController = null;
    }
    if (this.brokenCheckMessage) {
      this.brokenCheckMessage.close();
      this.brokenCheckMessage = null;
    }
  },
  updateWindowWidth() {  // 动态调整页面大小
    this.windowWidth = window.innerWidth;
    this.calculatePageSize();
  },
  };

  /** 计算属性。依赖的 data 字段两页同名同义。 */
  var computed = {
  filterIcon() {
    return this.filterOption === 'all' ? 'funnel' :
    this.filterOption === 'favorites' ? 'bookmark' :
    this.filterOption === 'blocked' ? 'lock' :
    this.filterOption === 'unblocked' ? 'lock-open' :
    this.filterOption === 'adult' ? 'user-round' : '';
  },
  paginatedTableData() {
    return this.sortData(this.filteredTableData)
      .slice((this.currentPage - 1) * this.pageSize, this.currentPage * this.pageSize);
  },
  sortIcon() { return `arrow-down-${this.sortOption === 'dateDesc' ? 'wide-narrow' : 'a-z'}`; },
  };

  /** 监听器。sortOption 变化时写回 localStorage，两页行为一致。 */
  var watch = {
  sortOption(newOption) { localStorage.setItem('sortOption', newOption); },
  };

  window.KVAdminShared = {
    methods: methods,
    computed: computed,
    watch: watch,
  };
})();
