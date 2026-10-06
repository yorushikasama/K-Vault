#!/usr/bin/env node
/**
 * 给页面里本地 CSS/JS 的引用打上内容哈希版本串。
 *
 * 为什么需要：静态资源要想设 `Cache-Control: immutable`（一年强缓存），URL 必须
 * 随内容变化。手写 `?v=20260305` 这种日期串靠人记得改，一旦忘了，用户就会拿着
 * 旧 CSS 一年——这比没有缓存更糟。改成内容哈希后，忘记重跑会被 CI 拦住，而不是
 * 静默地把陈旧资源推给用户。
 *
 * 仓库没有打包步骤，所以这里沿用 build-icon-subset.cjs 的模式：手动运行、产物入库、
 * CI 用 --check 校验同步。
 *
 * 用法：
 *   node scripts/stamp-asset-versions.cjs          # 改写 HTML
 *   node scripts/stamp-asset-versions.cjs --check  # 只校验，不落盘
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");

/** 带内容哈希的资源引用形如 /index.css?v=a1b2c3d4 */
const REFERENCE_RE = /((?:href|src)=")(\.?\/)([a-z0-9][a-z0-9.-]*\.(?:css|js))(\?v=[A-Za-z0-9]+)?(")/g;

function shortHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  const hashes = new Map();
  const stale = [];
  let rewritten = 0;

  for (const page of pages) {
    const pagePath = path.join(ROOT, page);
    const original = fs.readFileSync(pagePath, "utf8");
    const updated = original.replace(REFERENCE_RE, (match, attr, prefix, file, _version, tail) => {
      const assetPath = path.join(ROOT, file);
      if (!fs.existsSync(assetPath)) {
        // 引用了不存在的文件：不是本脚本该修的问题，但也不能静默打上哈希。
        stale.push(`${page} 引用了不存在的 ${file}`);
        return match;
      }
      if (!hashes.has(file)) hashes.set(file, shortHash(assetPath));
      return `${attr}${prefix}${file}?v=${hashes.get(file)}${tail}`;
    });

    if (updated === original) continue;
    rewritten += 1;
    if (checkOnly) stale.push(`${page} 的资源版本串过期`);
    else fs.writeFileSync(pagePath, updated);
  }

  if (checkOnly) {
    if (stale.length) {
      process.stderr.write(`${stale.join("\n")}\n请重跑 node scripts/stamp-asset-versions.cjs\n`);
      process.exit(1);
    }
    process.stdout.write(`资源版本串是最新的（${hashes.size} 个文件）\n`);
    return;
  }

  if (stale.length) process.stderr.write(`${stale.join("\n")}\n`);
  process.stdout.write(`已更新 ${rewritten} 个页面，覆盖 ${hashes.size} 个本地资源\n`);
  for (const [file, hash] of [...hashes].sort()) {
    process.stdout.write(`  ${file} -> ${hash}\n`);
  }
}

main();
