#!/usr/bin/env node
/**
 * 生成 icons-subset.js：只打包仓库真正用到的 Lucide 图标。
 *
 * 全量 lucide UMD 是 105 KB gzip，九个页面每页都在下载它，而实际用到的图标
 * 只有一百多个。本脚本扫描仓库里所有 HTML/JS 的字符串字面量，与 Lucide 导出名
 * 求交集，再把运行时 helper（createIcons / replaceElement 等）从官方源码原样
 * 抽出来，拼成一个同形状的 window.lucide。
 *
 * 因为形状一致（window.lucide.icons + createIcons），icons.js、theme-core.js、
 * admin.html 内联的 kv-icon 都不需要改。
 *
 * 用法：
 *   node scripts/build-icon-subset.cjs            # 增量：复用缓存的上游源码
 *   node scripts/build-icon-subset.cjs --refresh  # 重新下载上游源码
 *
 * 图标增删后重跑本脚本即可；CI 可用 --check 校验产物是否最新。
 */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const LUCIDE_VERSION = "1.49.0";
const UPSTREAM_URL = `https://cdn.jsdelivr.net/npm/lucide@${LUCIDE_VERSION}/dist/umd/lucide.js`;
const CACHE_FILE = path.join(ROOT, "node_modules", ".cache", `lucide-${LUCIDE_VERSION}.js`);
const OUT_FILE = path.join(ROOT, "icons-subset.js");

// 这些名字是动态拼出来的（三元 / 映射表 / 服务端下发），静态扫描可能漏，显式兜底。
const ALWAYS_INCLUDE = [
  "file",
  "folder",
  "folder-open",
  "bookmark",
  "bookmark-check",
  "sun",
  "moon",
  "circle-check",
  "circle-x",
  "circle-alert",
  "info",
  "triangle-alert",
  "clipboard",
  "clipboard-check",
  "loader-circle",
];

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`下载 ${url} 失败：HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", reject);
  });
}

async function loadUpstream(refresh) {
  if (!refresh && fs.existsSync(CACHE_FILE)) {
    return fs.readFileSync(CACHE_FILE, "utf8");
  }
  process.stderr.write(`下载 lucide@${LUCIDE_VERSION} 源码...\n`);
  const src = await download(UPSTREAM_URL);
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, src);
  return src;
}

/** 从官方源码里原样切出一段，保证运行时语义和上游完全一致。 */
function slice(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`上游源码里找不到 ${label} 的起始标记：${startMarker}`);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error(`上游源码里找不到 ${label} 的结束标记：${endMarker}`);
  return src.slice(start, end).replace(/\s+$/, "");
}

/**
 * 索引上游全部 `const Name = [ ... ];` 图标定义。
 * 定义既有单行也有多行写法，按方括号配平定位结尾。
 */
function indexIconDefinitions(src) {
  const defs = new Map();
  const re = /^ {2}const ([A-Z][A-Za-z0-9]*) = \[/gm;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf("[", m.index);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) break;
      } else if (ch === '"' || ch === "'") {
        // 跳过字符串，避免 path 数据里的方括号干扰配平
        const quote = ch;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\") i++;
          i++;
        }
      }
    }
    if (depth !== 0) throw new Error(`图标 ${m[1]} 的定义括号不配平`);
    const end = src.indexOf(";", i);
    defs.set(m[1], src.slice(m.index, end + 1));
  }
  return defs;
}

function collectUsedNames(iconExportNames) {
  // Lucide 的 toPascalCase 与 kv-icon 的 kebab->Pascal 规则一致，这里反查：
  // 建 PascalCase -> true 的集合，扫到的 kebab token 转成 Pascal 再判存在。
  const exported = new Set(iconExportNames);
  const toCamelCase = (string) => {
    let out = "";
    let upperNext = false;
    for (const ch of string) {
      if (ch === "-" || ch === "_" || ch <= " ") {
        upperNext = out.length > 0;
        continue;
      }
      out += out.length === 0 ? ch.toLowerCase() : upperNext ? ch.toUpperCase() : ch;
      upperNext = false;
    }
    return out;
  };
  const toPascalCase = (s) => {
    const c = toCamelCase(s);
    return c.charAt(0).toUpperCase() + c.slice(1);
  };

  const targets = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (/\.(html|js)$/.test(f) && f !== "icons-subset.js") targets.push(path.join(ROOT, f));
  }
  for (const d of ["functions", "server", "scripts"]) {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) continue;
    const walk = (p) =>
      fs.readdirSync(p, { withFileTypes: true }).forEach((e) => {
        if (e.name === "node_modules") return;
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else if (/\.(js|cjs|mjs|html)$/.test(e.name)) targets.push(fp);
      });
    walk(dir);
  }

  const used = new Map(); // kebab -> PascalCase
  const consider = (kebab) => {
    const pascal = toPascalCase(kebab);
    if (exported.has(pascal)) used.set(kebab, pascal);
  };

  for (const name of ALWAYS_INCLUDE) consider(name);
  for (const f of targets) {
    const src = fs.readFileSync(f, "utf8");
    for (const tok of src.match(/['"`][a-z0-9][a-z0-9-]*['"`]/g) || []) {
      consider(tok.slice(1, -1));
    }
    // data-lucide="x" / name="x" 即使没被引号 token 规则覆盖也兜一层
    for (const m of src.matchAll(/(?:data-lucide|\bname)="([a-z0-9][a-z0-9-]*)"/g)) {
      consider(m[1]);
    }
  }
  return used;
}

async function main() {
  const refresh = process.argv.includes("--refresh");
  const checkOnly = process.argv.includes("--check");
  const upstream = await loadUpstream(refresh);

  // 运行时 helper：defaultAttributes -> replaceElement 结束（紧接第一个图标定义之前）
  const runtime = slice(upstream, "const defaultAttributes = {", "  const AArrowDown = [", "运行时 helper");
  const createIcons = slice(upstream, "  const createIcons = ({", "  exports.AArrowDown", "createIcons");

  // 上游的 iconAndAliases 表：PascalCase 名 -> 实现名（含 XCircle: CircleX 这类别名）
  const aliasTable = slice(
    upstream,
    "  var iconAndAliases = /*#__PURE__*/Object.freeze",
    "  const createIcons = ({",
    "别名表"
  );
  const aliasPairs = [...aliasTable.matchAll(/^\s{4}([A-Za-z0-9]+):\s*([A-Za-z0-9]+),?$/gm)].map((m) => [
    m[1],
    m[2],
  ]);
  if (!aliasPairs.length) throw new Error("别名表解析失败，上游产物结构可能变了");
  const aliasOf = new Map(aliasPairs);

  const used = collectUsedNames(aliasOf.keys());
  if (!used.size) throw new Error("没扫到任何图标名，扫描逻辑可能坏了");

  // 一次性索引上游所有图标定义。定义有单行和多行两种写法，用方括号配平来切，
  // 不能用固定的结束标记（会把后面的定义一起吞掉）。
  const allDefs = indexIconDefinitions(upstream);

  // 需要内联的图标实现（去重后的底层 const 名）
  const impls = new Map(); // implName -> 定义源码
  for (const pascal of used.values()) {
    const impl = aliasOf.get(pascal);
    if (impls.has(impl)) continue;
    const def = allDefs.get(impl);
    if (!def) throw new Error(`上游源码里找不到图标实现：${impl}`);
    impls.set(impl, def);
  }

  // 多个 kebab 写法可能落到同一个 PascalCase 键（例如 "folder" 和 "folder-"），按键去重。
  const sortedUsed = [...new Set(used.values())].sort((a, b) => a.localeCompare(b));
  const iconEntries = sortedUsed.map((pascal) => `    ${pascal}: ${aliasOf.get(pascal)},`).join("\n");

  const banner = `/**
 * Lucide ${LUCIDE_VERSION} 子集 — 由 scripts/build-icon-subset.cjs 生成，请勿手改。
 *
 * 只包含仓库实际用到的 ${sortedUsed.length} 个图标（全量 2117 个）。
 * 暴露形状与官方 UMD 一致（window.lucide.icons / createIcons / 具名导出），
 * 因此 icons.js、theme-core.js、admin.html 的 kv-icon 都无需改动。
 *
 * 图标增删后重跑：node scripts/build-icon-subset.cjs
 *
 * 上游 ISC 协议，版权归 Lucide Contributors。
 */`;

  const out = `${banner}
(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined"
    ? factory(exports)
    : typeof define === "function" && define.amd
      ? define(["exports"], factory)
      : ((global = typeof globalThis !== "undefined" ? globalThis : global || self), factory((global.lucide = {})));
})(this, function (exports) {
  "use strict";

${runtime}

${[...impls.values()].join("\n\n")}

  // 常量名必须叫 iconAndAliases：上游 createIcons 的默认参数是 \`icons = iconAndAliases\`，
  // 而 icons.js 正是不传参调用 createIcons({ root }) 的。改名会让它在运行时抛 ReferenceError。
  const iconAndAliases = /*#__PURE__*/ Object.freeze({
    __proto__: null,
${iconEntries}
  });

${createIcons}
  exports.icons = iconAndAliases;
  exports.createIcons = createIcons;
  exports.createElement = createElement;
  for (const key of Object.keys(iconAndAliases)) {
    exports[key] = iconAndAliases[key];
  }
});
`;

  if (checkOnly) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
    if (current !== out) {
      process.stderr.write("icons-subset.js 与源码不同步，请重跑 node scripts/build-icon-subset.cjs\n");
      process.exit(1);
    }
    process.stdout.write(`icons-subset.js 是最新的（${sortedUsed.length} 个图标）\n`);
    return;
  }

  fs.writeFileSync(OUT_FILE, out);
  const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
  process.stdout.write(`已写入 icons-subset.js：${sortedUsed.length} 个图标，${impls.size} 份实现，${kb} KB\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
