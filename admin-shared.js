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
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.style.position = 'fixed';
    textarea.style.clip = 'rect(0 0 0 0)';
    textarea.style.top = '10px';
    textarea.value = text;
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
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
          图标需在 <a href="https://lucide.dev/icons/" target="_blank" style="color: #409EFF; text-decoration: underline">Lucide</a> 中选择
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
    let link = url;

    switch (format) {
      case 'markdown':
        link = `![${name}](${url})`;
        break;
      case 'html':
        link = `<img src="${url}" alt="${name}">`;
        break;
      case 'bbcode':
        link = `[img]${url}[/img]`;
        break;
      default:
        link = url;
    }

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
      return `<img src="${url}" alt="${name}">`;
    }).join('\n');
    (navigator.clipboard?.writeText(links) || this.copyToClipboardFallback(links))
      .then(() => this.$message.success('HTML格式链接已复制~'));
  },
  handleBatchCopyMarkdown() {  // 批量复制Markdown格式
    const links = this.selectedFiles.map(file => {
      const url = `${document.location.origin}/file/${file.name}`;
      const name = file.metadata?.fileName || file.name;
      return `![${name}](${url})`;
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
