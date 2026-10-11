const fs = require('fs');
const NAMES = [
  'parseDelimited', 'stripJsonComments', 'tryFormatJson', 'createTarSource', 'readTarString',
  'loadZip', 'findEndOfCentralDirectory', 'decodeZipName', 'inflateRaw', 'parseXml',
  'collectText', 'allByLocalName', 'firstByLocalName', 'elementChildren', 'localName',
  'attr', 'columnIndex', 'compareNumberedPath', 'readSharedStrings', 'parseEmailMessage',
  'parseEmailHeaders', 'extractMailFileName', 'cleanContentType', 'decodeTransferText',
  'decodeMimeWords', 'firstMboxMessage', 'stripHtml',
];

function extractBlock(lines, name) {
  const head = new RegExp('^[ \\t]*(?:async )?function ' + name + '\\s*\\(');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) { start = i; break; }
  }
  if (start === -1) throw new Error(name + ' 未找到');
  let depth = 0, began = false, end = start;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; began = true; }
      if (ch === '}') depth--;
    }
    if (began && depth === 0) { end = i; break; }
  }
  // 收编紧邻的前置注释与上方空行
  let cutStart = start;
  while (cutStart > 0 && /^[ \t]*\/\//.test(lines[cutStart - 1])) cutStart--;
  while (cutStart > 0 && lines[cutStart - 1].trim() === '' && /^[ \t]*(?:\/\/|function)/.test(lines[cutStart])) cutStart--;
  const block = lines.slice(cutStart, end + 1);
  lines.splice(cutStart, end - cutStart + 1);
  return block;
}

const lines = fs.readFileSync('preview-app.js', 'utf8').split('\n');
const blocks = NAMES.map((name) => {
  const block = extractBlock(lines, name);
  console.log('提取 ' + name + '（' + block.length + ' 行）');
  return block.join('\n');
});
fs.writeFileSync('preview-app.js', lines.join('\n'));

const content = [
  '/** 文件预览器的纯解析器（自 preview-app.js 拆出）。只被 preview.html 加载。',
   ' *',
   ' * 这一组的共同点：输入输出都是值（文本/二进制/结构化数据），不触碰页面的',
   ' * state/els/viewer——ZIP 与 TAR 目录读取、OpenXML 解析、CSV/TSV 切表、',
   ' * 邮件头正文提取、JSON 容错格式化全在这里；渲染成 DOM 的部分留在',
   ' * preview-app.js。函数均为纯函数，可独立测试。 */',
  '(function () {',
  '  "use strict";',
  '',
  blocks.join('\n\n'),
  '',
  '  window.KVPreviewParsers = {',
  NAMES.map((n) => '    ' + n + ',').join('\n'),
  '  };',
  '})();',
  '',
].join('\n');
fs.writeFileSync('preview-parsers.js', content);
console.log('preview-parsers.js 已生成');
