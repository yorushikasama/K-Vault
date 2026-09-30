#!/usr/bin/env node
/**
 * One-shot FontAwesome -> Lucide migration for K-Vault.
 *
 * Handles the three real icon mechanisms found in this codebase:
 *   1. Static tags      <i class="fas fa-moon upload-icon"></i>
 *   2. Vue class binds  :class="x ? 'fas fa-folder-open' : 'fas fa-folder'"
 *   3. JS string icons  icon: 'fas fa-image',  and  '<i class="fas fa-spin"></i>'
 *
 * Brand icons (github/telegram/discord/android/markdown) are left untouched.
 * Custom classes and data-* attributes on the element are preserved via
 * data-lucide plus a class passthrough (createIcons drops plain classes).
 *
 * Usage:  node scripts/migrate-icons.js [--dry] [files...]
 */
const fs = require("fs");
const path = require("path");
const { lookup, isIconToken, isStyleToken } = require("./icon-map.js");

const dry = process.argv.includes("--dry");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const report = { files: 0, staticTags: 0, vueBinds: 0, jsStrings: 0, brands: 0, unknown: [] };

/**
 * Rewrite the contents of a FontAwesome class attribute into a data-lucide
 * attribute + preserved extra classes.
 *
 * "fas fa-moon data-theme-icon"      -> data-lucide="moon" data-icon-class="data-theme-icon"
 * "fab fa-telegram"                  -> unchanged (brand)
 * "fas fa-spinner fa-spin"           -> data-lucide="loader-circle" data-icon-class="spin"
 */
function rewriteClassAttr(classValue) {
  const toks = classValue.split(/\s+/).filter(Boolean);
  const iconToks = toks.filter(isIconToken);
  if (iconToks.length === 0) return null;

  const styleToks = toks.filter(isStyleToken);
  const isBrand = styleToks.some((t) => t === "fab" || t === "fa-brands");
  const extra = toks.filter((t) => !isIconToken(t) && !isStyleToken(t));

  // fa-spin is a FontAwesome animation helper -> Lucide uses a `spin` class.
  const spin = extra.includes("fa-spin");
  const extraClean = extra.filter((t) => t !== "fa-spin");

  const iconTok = iconToks[0];
  const res = lookup(iconTok);

  if (isBrand || res.brand) {
    report.brands++;
    return null; // leave FontAwesome alone
  }
  if (res.unknown) {
    report.unknown.push(iconTok);
    return null;
  }

  const classes = [...extraClean];
  if (spin) classes.push("spin");

  // lucide.createIcons() carries unknown attributes (data-theme-icon and any
  // data-*) onto the generated <svg>, so only the class list needs rescuing.
  let out = `data-lucide="${res.lucide}"`;
  if (classes.length) out += ` data-icon-class="${classes.join(" ")}"`;
  report.staticTags++;
  return out;
}

function migrateStaticTags(src) {
  // <i class="fas fa-moon upload-icon" ...>  ->  <i data-lucide="moon" data-icon-class="upload-icon" ...>
  // Split on the class attribute so any surrounding attributes are preserved
  // in their original order and position.
  return src.replace(/<i\b([^>]*)>/g, (m, attrs) => {
    // A Vue :class binding is rewritten separately; skip if class=" is absent.
    const cm = attrs.match(/(^|\s)class="([^"]*)"/);
    if (!cm) return m;
    const cls = cm[2];
    if (!/\bfa[bsr]?\b|fa-[a-z]/.test(cls)) return m;
    const rewritten = rewriteClassAttr(cls);
    if (rewritten === null) return m;
    const newAttrs = attrs.replace(/(^|\s)class="([^"]*)"/, "$1" + rewritten);
    return `<i${newAttrs}>`;
  });
}

function migrateJsStrings(src) {
  // 'fas fa-image'  /  "far fa-file-image"  ->  'data-lucide="image"'
  // Only touch strings that are purely FA style + icon tokens (JS icon fields).
  return src.replace(/(['"])((?:fas|far|fab|fa-solid|fa-regular|fa-brands))\s+(fa-[a-z0-9-]+(?:\s+fa-[a-z0-9-]+)*)\1/g, (m, q, style, names) => {
    const res = lookup(names.split(/\s+/)[0]);
    if (res.brand) { report.brands++; return m; }
    if (res.unknown) { report.unknown.push(names.split(/\s+/)[0]); return m; }
    report.jsStrings++;
    return `${q}${res.lucide}${q}`;
  });
}

function migrateVueBinds(src) {
  // :class="cond ? 'fas fa-a' : 'far fa-b'"  ->  :class="cond ? 'a' : 'b'"
  // Also rewrites the FontAwesome spin helper: { 'fa-spin': loading } -> { spin: loading }
  return src.replace(/:class="([^"]*)"/g, (m, expr) => {
    if (!/fa-/.test(expr)) return m;
    let next = expr;

    // Icon name bindings: 'fas fa-folder-open' -> 'folder-open'
    // The captured name already includes its "fa-" prefix.
    next = next.replace(/(['"])((?:fas|far|fab|fa-solid|fa-regular|fa-brands))\s+(fa-[a-z0-9-]+)((?:\s+[a-z0-9- ]*)?)\1/g,
      (mm, q, style, name, tail) => {
        const res = lookup(name);
        if (res.brand) { report.brands++; return mm; }
        if (res.unknown) { report.unknown.push(name); return mm; }
        report.vueBinds++;
        return `${q}${res.lucide}${tail}${q}`;
      });

    // Spin helper: 'fa-spin' as a class key -> 'spin'
    next = next.replace(/(['"])fa-spin\1/g, "$1spin$1");

    return `:class="${next}"`;
  });
}

for (const f of files) {
  if (!fs.existsSync(f)) { console.error("missing:", f); continue; }
  let src = fs.readFileSync(f, "utf8");
  const before = src;
  src = migrateStaticTags(src);
  src = migrateVueBinds(src);
  src = migrateJsStrings(src);
  if (src !== before) {
    report.files++;
    if (!dry) fs.writeFileSync(f, src);
    console.log(`${dry ? "[dry] " : ""}updated ${f}`);
  } else {
    console.log(`  no change ${f}`);
  }
}

console.log("\n=== report ===");
console.log(JSON.stringify(report, null, 2));
