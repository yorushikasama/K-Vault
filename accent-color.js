/**
 * 强调色派生：从壁纸算出一个色相，再派生出「必然可达标」的亮/暗两档颜色。
 *
 * 这里没有主题色。全站的强调色是壁纸给的：取壁纸里最有代表性的一族色相，
 * 派生出两种明度 —— 亮色档压在浅色底上、暗色档压在深色底上，各自满足
 * WCAG AA。没有壁纸时不取色，回退成纯单色（黑/白），页面就是黑白稿。
 *
 * 为什么是"取色相、自己定明度"而不是"直接用壁纸的颜色"：
 * 壁纸上的像素用什么明度都有，直接拿来当按钮底色必然有读不出来的组合。
 * 色相是"这张图看起来是什么颜色"的答案，明度只是可读性问题 —— 所以只继承
 * 色相，明度由对比度算法决定。饱和度和壁纸保持一致，取不到就退回一个
 * 温和的中间值。
 *
 * 同步双份：这份是浏览器脚本（挂 window），server 侧无需求。测试直接以
 * 文本方式读取本文件并在沙箱里求值，所以不要依赖任何外部全局。
 */
(function (global) {
  "use strict";

  // WCAG AA：正文 4.5:1。留一点余量，避免浮点误差让边界值擦线失败。
  var MIN_RATIO = 4.6;
  var MAX_STEPS = 100;

  function clamp255(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  }

  function hexToRgb(hex) {
    var text = String(hex || "").trim().replace(/^#/, "");
    if (text.length === 3) {
      text = text.split("").map(function (c) { return c + c; }).join("");
    }
    if (!/^[0-9a-f]{6}$/i.test(text)) return null;
    return [
      parseInt(text.slice(0, 2), 16),
      parseInt(text.slice(2, 4), 16),
      parseInt(text.slice(4, 6), 16),
    ];
  }

  function rgbToHex(rgb) {
    return "#" + rgb.map(function (v) {
      return clamp255(v).toString(16).padStart(2, "0");
    }).join("");
  }

  /** sRGB 相对亮度（WCAG 定义）。 */
  function luminance(rgb) {
    var channel = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  }

  function contrastRatio(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var d = max - min;
    var l = (max + min) / 2;
    var h = 0, s = 0;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) return [l * 255, l * 255, l * 255];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var convert = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [convert(h + 1 / 3) * 255, convert(h) * 255, convert(h - 1 / 3) * 255];
  }

  /**
   * 固定色相与饱和度，只调明度，直到对**每一个**底色都达到 MIN_RATIO。
   * 亮色档往深处走，暗色档往浅处走 —— 方向由 darken 决定。
   * 找不到就返回 null（调用方负责回退）。
   *
   * 为什么是一组底色而不是一个：强调色会落在卡片、下沉区、选中态等多个
   * 表面上，而中性面本身现在也带壁纸色度、明度各不相同。只对最白那个面
   * 达标是不够的 —— 实测按纯白搜索时，压在 93.5% 的选中态上有 294 个色相
   * 掉到 4.5:1 以下（最差 3.93）。必须让最不利的那个面也过。
   */
  function findAccessibleForAll(hue, sat, backgrounds, darken) {
    var list = backgrounds && backgrounds.length ? backgrounds : [[255, 255, 255]];
    for (var step = 0; step <= MAX_STEPS; step += 1) {
      var l = darken ? 0.5 - step / 200 : 0.5 + step / 200;
      if (l < 0.03 || l > 0.97) break;
      var rgb = hslToRgb(hue, sat, l);
      var ok = true;
      for (var i = 0; i < list.length; i += 1) {
        if (contrastRatio(rgb, list[i]) < MIN_RATIO) {
          ok = false;
          break;
        }
      }
      if (ok) return rgb;
    }
    return null;
  }

  /** 兼容单个色值 / 一组色值两种入参。 */
  function toBackgroundList(value, fallback) {
    var raw = Array.isArray(value) ? value : [value];
    var out = [];
    for (var i = 0; i < raw.length; i += 1) {
      var rgb = typeof raw[i] === "string" ? hexToRgb(raw[i]) : raw[i];
      if (rgb && rgb.length >= 3) out.push([rgb[0], rgb[1], rgb[2]]);
    }
    return out.length ? out : [fallback];
  }

  /**
   * 由色相派生完整的一套强调色 token。
   *
   * @param {number|null} hue 色相；null / 非数字 / NaN => 单色回退（黑白）
   * @param {{backgroundsLight?:string|Array, backgroundsDark?:string|Array,
   *          surfaceLight?:string, surfaceDark?:string,
   *          saturation?:number}} options
   */
  function buildAccent(hue, options) {
    var opts = options || {};

    // 必须显式判类型：isFinite(null) 在 JS 里是 true（Number(null) === 0），
    // 于是"没有壁纸"会被当成色相 0 派生出红色 —— 单色回退静默失效。
    var hasHue = typeof hue === "number" && isFinite(hue);
    if (!hasHue) {
      // 无壁纸 = 没有主题色：亮色档用纯黑、暗色档用纯白，页面就是黑白稿。
      return { light: "#000000", dark: "#ffffff", mono: true };
    }

    var sat = Math.max(0, Math.min(1, Number(opts.saturation)));
    if (!isFinite(sat) || sat <= 0) sat = 0.55;

    var lightBgs = toBackgroundList(
      opts.backgroundsLight !== undefined ? opts.backgroundsLight : opts.surfaceLight,
      [255, 255, 255]
    );
    var darkBgs = toBackgroundList(
      opts.backgroundsDark !== undefined ? opts.backgroundsDark : opts.surfaceDark,
      [17, 17, 17]
    );

    // 算不出来时也回退单色，而不是输出一个读不清的颜色。
    var lightAccent =
      findAccessibleForAll(hue, sat, lightBgs, true) ||
      findAccessibleForAll(hue, sat, lightBgs, false) ||
      [0, 0, 0];
    var darkAccent =
      findAccessibleForAll(hue, sat, darkBgs, false) ||
      findAccessibleForAll(hue, sat, darkBgs, true) ||
      [255, 255, 255];

    return {
      light: rgbToHex(lightAccent),
      dark: rgbToHex(darkAccent),
      mono: false,
    };
  }

  // 中性面的着色上限。这是对比度算出来的天花板而不是审美选择：
  // 0–360° 全色相、全部文字/底色组合在 20% 时最差 4.66:1，24% 就掉到
  // 4.46:1（亮色 muted 压在选中态上）。再高就开始读不清了。
  var TINT_MAX = 20;
  // 下限：extractHue 的饱和度下限是 0.34，正好落在这里。若把它映射成 0%，
  // 一张"勉强有点颜色"的壁纸会得到彻底灰白的页面 —— 取了色却看不见，
  // 等于没取。给一个能看出来、又不喧哗的起步值。
  var TINT_MIN = 5;

  /**
   * 中性面的着色强度：壁纸越鲜艳，页面越"染"上它的色相。
   * extractHue 的饱和度落在 [0.34, 0.72]，据此映射到 [TINT_MIN, TINT_MAX]。
   * 没有壁纸（sat 为 0 或非数字）时返回 0 —— CSS 里所有色度项随之塌成 0，
   * 页面就是纯灰阶。
   */
  function tintForSaturation(sat) {
    var value = Number(sat);
    if (!isFinite(value) || value <= 0) return 0;
    // 0.34 是 extractHue 的下限（低于它就算不上"有颜色"），从这里起步。
    var unit = Math.max(0, Math.min(1, (value - 0.34) / (0.72 - 0.34)));
    var tint = TINT_MIN + unit * (TINT_MAX - TINT_MIN);
    return Math.round(tint * 100) / 100;
  }
  /**
   * 把一组像素归纳成一个色相。
   *
   * 做法：按色相分桶，只统计"有颜色"的像素（低饱和度的灰阶投不出有意义的
   * 色相），取权重最高那一桶的加权平均色相。饱和度取该桶的平均值并夹到
   * 一个温和区间 —— 壁纸越鲜艳，强调色越贴近它，但不至于刺眼。
   *
   * @returns {{hue:number, sat:number, weight:number}|null} 取不到（纯灰阶图/空输入）返回 null
   */
  function extractHue(pixels, options) {
    var opts = options || {};
    var minSat = opts.minSaturation === undefined ? 0.18 : opts.minSaturation;
    var minAlpha = opts.minAlpha === undefined ? 200 : opts.minAlpha;

    var buckets = new Array(36); // 每 10° 一桶
    var total = 0;

    for (var i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < minAlpha) continue;
      var hsl = rgbToHsl([pixels[i], pixels[i + 1], pixels[i + 2]]);
      var hue = hsl[0], sat = hsl[1], light = hsl[2];
      // 近黑近白的像素色相没有意义，且往往是描边/阴影
      if (sat < minSat || light < 0.12 || light > 0.92) continue;

      var index = Math.floor(hue / 10) % 36;
      if (!buckets[index]) buckets[index] = { weight: 0, hueSin: 0, hueCos: 0, sat: 0 };
      var bucket = buckets[index];
      var rad = (hue * Math.PI) / 180;
      // 按饱和度加权：越鲜艳的像素越能代表这张图的颜色倾向
      var weight = sat * (1 - Math.abs(light - 0.5) * 1.2);
      if (weight <= 0) continue;
      bucket.weight += weight;
      bucket.hueSin += Math.sin(rad) * weight;
      bucket.hueCos += Math.cos(rad) * weight;
      bucket.sat += sat * weight;
      total += weight;
    }

    if (total <= 0) return null;

    var bestIndex = -1;
    for (var b = 0; b < 36; b += 1) {
      if (!buckets[b]) continue;
      if (bestIndex < 0 || buckets[b].weight > buckets[bestIndex].weight) bestIndex = b;
    }
    if (bestIndex < 0) return null;

    var winner = buckets[bestIndex];
    var hueDeg = (Math.atan2(winner.hueSin, winner.hueCos) * 180) / Math.PI;
    hueDeg = ((hueDeg % 360) + 360) % 360;

    // 饱和度夹到温和区间：太低会接近灰（失去"来自壁纸"的感觉），
    // 太高在实心按钮上会显得廉价。
    var sat = winner.sat / winner.weight;
    sat = Math.max(0.34, Math.min(0.72, sat));

    return { hue: hueDeg, sat: sat, weight: winner.weight / total };
  }

  /**
   * 全站调色板：一次算出色相、着色强度、两档强调色。
   *
   * 调用方（theme-effects.js）拿到结果后只写三个 CSS 变量：--ui-hue、
   * --ui-tint、--ui-brand（亮/暗两档写进 --ui-brand-light/-dark），
   * 其余中性色由 CSS 用 calc(--ui-tint * k) 自己展开。这样明度阶梯仍然
   * 只有一份（在样式表里），JS 不管明度。
   *
   * @param {{hue:number|null, sat:number}|null} extracted extractHue 的结果
   * @param {object} options 见 buildAccent
   */
  function buildPalette(extracted, options) {
    var opts = options || {};
    var hue = extracted && typeof extracted.hue === "number" ? extracted.hue : null;
    var tint = extracted ? tintForSaturation(extracted.sat) : 0;

    // tint 为 0 就等于"没有可用色相"：可能压根没壁纸，也可能是张灰阶图。
    // 两种情况都该退成单色 —— 否则会出现"页面全灰、按钮却红着"的割裂。
    var usable = hue !== null && tint > 0;
    var accent = buildAccent(usable ? hue : null, usable
      ? Object.assign({}, opts, { saturation: extracted.sat })
      : opts);

    return {
      hue: hue === null ? 0 : hue,
      tint: tint,
      accent: accent,
      mono: accent.mono,
      hasWallpaperHue: usable,
    };
  }

  var api = {
    MIN_RATIO: MIN_RATIO,
    TINT_MAX: TINT_MAX,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    luminance: luminance,
    contrastRatio: contrastRatio,
    rgbToHsl: rgbToHsl,
    hslToRgb: hslToRgb,
    extractHue: extractHue,
    tintForSaturation: tintForSaturation,
    buildAccent: buildAccent,
    buildPalette: buildPalette,
    findAccessibleForAll: findAccessibleForAll,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    global.KVAccentColor = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
