/** 文件预览器的纯解析器（自 preview-app.js 拆出）。只被 preview.html 加载。
 *
 * 输入输出都是值，不触碰页面的 state/els/viewer——ZIP/TAR 目录读取、
 * OpenXML 解析、CSV/TSV 切表、邮件头正文提取、JSON 容错格式化全在这里；
 * 渲染成 DOM 的部分留在 preview-app.js。函数均为纯函数，可独立测试。 */
(function () {
  "use strict";

      function parseDelimited(text, delimiter) {
        const rows = [];
        let row = [];
        let cell = "";
        let quoted = false;
        const input = String(text || "");

        for (let index = 0; index < input.length; index += 1) {
          const char = input[index];
          const next = input[index + 1];

          if (char === '"' && quoted && next === '"') {
            cell += '"';
            index += 1;
            continue;
          }
          if (char === '"') {
            quoted = !quoted;
            continue;
          }
          if (!quoted && char === delimiter) {
            row.push(cell);
            cell = "";
            continue;
          }
          if (!quoted && (char === "\n" || char === "\r")) {
            if (char === "\r" && next === "\n") index += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
            continue;
          }
          cell += char;
        }

        row.push(cell);
        rows.push(row);
        return rows;
      }

      function stripJsonComments(text) {
        return String(text || "")
          .replace(/^\uFEFF/, "")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1")
          .replace(/,\s*([}\]])/g, "$1");
      }

      function tryFormatJson(text) {
        try {
          return JSON.stringify(JSON.parse(stripJsonComments(text)), null, 2);
        } catch {
          return text;
        }
      }

      function createTarSource(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const entries = [];
        let offset = 0;

        while (offset + 512 <= bytes.length) {
          const header = bytes.slice(offset, offset + 512);
          if (header.every((byte) => byte === 0)) break;

          const name = readTarString(header, 0, 100);
          const prefix = readTarString(header, 345, 155);
          const fullName = [prefix, name].filter(Boolean).join("/");
          const size = parseInt(readTarString(header, 124, 12).trim() || "0", 8) || 0;
          const typeFlag = String.fromCharCode(header[156] || 0);
          const dataStart = offset + 512;
          const isDirectory = typeFlag === "5" || fullName.endsWith("/");

          if (fullName) {
            entries.push({
              name: fullName,
              uncompressedSize: size,
              compressedSize: size,
              method: "tar",
              dataStart,
              isDirectory
            });
          }

          offset = dataStart + Math.ceil(size / 512) * 512;
        }

        return {
          entries: () => entries,
          bytes: async (name) => {
            const entry = entries.find((item) => item.name === name);
            if (!entry) return null;
            return bytes.slice(entry.dataStart, entry.dataStart + entry.uncompressedSize);
          }
        };
      }

      function readTarString(bytes, start, length) {
        return new TextDecoder("utf-8")
          .decode(bytes.slice(start, start + length))
          .replace(/\0.*$/g, "");
      }

      async function loadZip(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const view = new DataView(arrayBuffer);
        const eocd = findEndOfCentralDirectory(view);
        if (eocd < 0) throw new Error("文档不是有效的 ZIP/OpenXML 文件。");

        const totalEntries = view.getUint16(eocd + 10, true);
        const centralDirectoryOffset = view.getUint32(eocd + 16, true);
        const entries = new Map();
        let offset = centralDirectoryOffset;

        for (let index = 0; index < totalEntries; index += 1) {
          if (view.getUint32(offset, true) !== 0x02014b50) break;

          const flags = view.getUint16(offset + 8, true);
          const method = view.getUint16(offset + 10, true);
          const compressedSize = view.getUint32(offset + 20, true);
          const uncompressedSize = view.getUint32(offset + 24, true);
          const fileNameLength = view.getUint16(offset + 28, true);
          const extraLength = view.getUint16(offset + 30, true);
          const commentLength = view.getUint16(offset + 32, true);
          const localHeaderOffset = view.getUint32(offset + 42, true);
          const nameBytes = bytes.slice(offset + 46, offset + 46 + fileNameLength);
          const fileName = decodeZipName(nameBytes, flags);

          entries.set(fileName, {
            method,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            isDirectory: fileName.endsWith("/")
          });

          offset += 46 + fileNameLength + extraLength + commentLength;
        }

        async function bytesFor(name) {
          const entry = entries.get(name);
          if (!entry) return null;
          if (view.getUint32(entry.localHeaderOffset, true) !== 0x04034b50) {
            throw new Error(`ZIP 内部条目头缺失：${name}`);
          }

          const fileNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
          const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
          const start = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
          const compressed = bytes.slice(start, start + entry.compressedSize);

          if (entry.method === 0) return compressed;
          if (entry.method === 8) return inflateRaw(compressed);
          throw new Error(`不支持的 ZIP 压缩方式：${entry.method}`);
        }

        return {
          names: () => Array.from(entries.keys()),
          entries: () => Array.from(entries, ([name, entry]) => ({ name, ...entry })),
          bytes: bytesFor,
          text: async (name) => {
            const data = await bytesFor(name);
            return data ? new TextDecoder("utf-8").decode(data) : "";
          }
        };
      }

      function findEndOfCentralDirectory(view) {
        const min = Math.max(0, view.byteLength - 0xffff - 22);
        for (let offset = view.byteLength - 22; offset >= min; offset -= 1) {
          if (view.getUint32(offset, true) === 0x06054b50) return offset;
        }
        return -1;
      }

      function decodeZipName(bytes, flags) {
        const decoder = new TextDecoder((flags & 0x0800) ? "utf-8" : "utf-8");
        return decoder.decode(bytes);
      }

      async function inflateRaw(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }

      function parseXml(text) {
        const xml = new DOMParser().parseFromString(text, "application/xml");
        if (xml.getElementsByTagName("parsererror").length) {
          throw new Error("文档 XML 解析失败。");
        }
        return xml;
      }

      function collectText(node) {
        let output = "";
        const walk = (current) => {
          for (const child of current.childNodes || []) {
            const name = localName(child);
            if (name === "t") {
              output += child.textContent || "";
            } else if (name === "tab") {
              output += "\t";
            } else if (name === "br" || name === "cr") {
              output += "\n";
            } else {
              walk(child);
            }
          }
        };
        walk(node);
        return output;
      }

      function allByLocalName(root, name) {
        const found = [];
        const walk = (node) => {
          if (localName(node) === name) found.push(node);
          for (const child of node.childNodes || []) walk(child);
        };
        walk(root);
        return found;
      }

      function firstByLocalName(root, name) {
        return allByLocalName(root, name)[0] || null;
      }

      function elementChildren(node) {
        return Array.from(node.childNodes || []).filter((child) => child.nodeType === 1);
      }

      function localName(node) {
        return String(node?.localName || node?.nodeName || "").split(":").pop();
      }

      function attr(node, name) {
        if (!node) return "";
        return node.getAttribute(name)
          || node.getAttribute(`w:${name}`)
          || node.getAttribute(`r:${name}`)
          || node.getAttribute(`a:${name}`)
          || "";
      }

      function columnIndex(letters) {
        let value = 0;
        for (const char of String(letters || "").toUpperCase()) {
          const code = char.charCodeAt(0);
          if (code < 65 || code > 90) continue;
          value = value * 26 + (code - 64);
        }
        return Math.max(0, value - 1);
      }

      function compareNumberedPath(left, right) {
        const a = Number((left.match(/(\d+)(?=\.xml$)/) || [0, 0])[1]);
        const b = Number((right.match(/(\d+)(?=\.xml$)/) || [0, 0])[1]);
        return a - b;
      }

      async function readSharedStrings(zip) {
        const xmlText = await zip.text("xl/sharedStrings.xml");
        if (!xmlText) return [];
        const xml = parseXml(xmlText);
        return allByLocalName(xml, "si").map((node) => collectText(node));
      }

      function parseEmailMessage(raw) {
        const normalized = String(raw || "").replace(/\r\n/g, "\n");
        const splitIndex = normalized.search(/\n\n/);
        const headerText = splitIndex >= 0 ? normalized.slice(0, splitIndex) : "";
        const bodyText = splitIndex >= 0 ? normalized.slice(splitIndex + 2) : normalized;
        const headers = parseEmailHeaders(headerText);
        const contentType = headers["content-type"] || "";
        const boundary = (contentType.match(/boundary="?([^";]+)"?/i) || [])[1] || "";
        const attachments = [];
        let body = bodyText;

        if (boundary) {
          const parts = bodyText.split(`--${boundary}`);
          const readable = [];
          for (const part of parts) {
            const index = part.search(/\n\n/);
            if (index < 0) continue;
            const partHeaders = parseEmailHeaders(part.slice(0, index));
            const partBody = part.slice(index + 2).trim();
            const disposition = partHeaders["content-disposition"] || "";
            const partType = partHeaders["content-type"] || "";
            const fileName = extractMailFileName(disposition) || extractMailFileName(partType);

            if (/attachment/i.test(disposition) || fileName) {
              attachments.push({ name: fileName || "未命名附件", type: cleanContentType(partType) });
            } else if (/text\/plain/i.test(partType)) {
              readable.push(decodeTransferText(partBody, partHeaders["content-transfer-encoding"]));
            } else if (!readable.length && /text\/html/i.test(partType)) {
              readable.push(stripHtml(decodeTransferText(partBody, partHeaders["content-transfer-encoding"])));
            }
          }
          body = readable.filter(Boolean).join("\n\n");
        } else if (/text\/html/i.test(contentType)) {
          body = stripHtml(bodyText);
        }

        return {
          from: headers.from || "",
          to: headers.to || "",
          date: headers.date || "",
          subject: decodeMimeWords(headers.subject || ""),
          body: decodeTransferText(body.trim(), headers["content-transfer-encoding"]),
          attachments
        };
      }

      function parseEmailHeaders(text) {
        const headers = {};
        let current = "";
        for (const line of String(text || "").split("\n")) {
          if (/^\s/.test(line) && current) {
            headers[current] += ` ${line.trim()}`;
            continue;
          }
          const match = line.match(/^([^:]+):\s*(.*)$/);
          if (!match) continue;
          current = match[1].toLowerCase();
          headers[current] = match[2].trim();
        }
        return headers;
      }

      function extractMailFileName(value) {
        const encoded = String(value || "").match(/filename\*=UTF-8''([^;]+)/i);
        if (encoded) {
          try {
            return decodeURIComponent(encoded[1].replace(/^"|"$/g, ""));
          } catch {
            return encoded[1];
          }
        }
        const plain = String(value || "").match(/filename="?([^";]+)"?/i) || String(value || "").match(/name="?([^";]+)"?/i);
        return plain ? decodeMimeWords(plain[1]) : "";
      }

      function cleanContentType(value) {
        return String(value || "").split(";")[0].trim() || "附件";
      }

      function decodeTransferText(text, encoding = "") {
        const value = String(text || "").trim();
        if (/base64/i.test(encoding)) {
          try {
            const binary = atob(value.replace(/\s/g, ""));
            return new TextDecoder("utf-8").decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
          } catch {
            return value;
          }
        }
        if (/quoted-printable/i.test(encoding)) {
          return value
            .replace(/=\n/g, "")
            .replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        return value;
      }

      function decodeMimeWords(value) {
        return String(value || "").replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset, mode, text) => {
          try {
            if (mode.toUpperCase() === "B") {
              const binary = atob(text);
              return new TextDecoder(charset).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
            }
            const decoded = text.replace(/_/g, " ").replace(/=([A-Fa-f0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            return new TextDecoder(charset).decode(Uint8Array.from(decoded, (char) => char.charCodeAt(0)));
          } catch {
            return text;
          }
        });
      }

      function firstMboxMessage(text) {
        const normalized = String(text || "").replace(/\r\n/g, "\n");
        const parts = normalized.split(/\nFrom .*\n/g).filter((part) => part.trim());
        return parts[0] || normalized;
      }

      function stripHtml(html) {
        const template = document.createElement("template");
        template.innerHTML = String(html || "");
        template.content.querySelectorAll("script, style, iframe, object").forEach((node) => node.remove());
        return template.content.textContent.replace(/\n{3,}/g, "\n\n").trim();
      }

  window.KVPreviewParsers = {
    parseDelimited,
    stripJsonComments,
    tryFormatJson,
    createTarSource,
    readTarString,
    loadZip,
    findEndOfCentralDirectory,
    decodeZipName,
    inflateRaw,
    parseXml,
    collectText,
    allByLocalName,
    firstByLocalName,
    elementChildren,
    localName,
    attr,
    columnIndex,
    compareNumberedPath,
    readSharedStrings,
    parseEmailMessage,
    parseEmailHeaders,
    extractMailFileName,
    cleanContentType,
    decodeTransferText,
    decodeMimeWords,
    firstMboxMessage,
    stripHtml,
  };
})();
