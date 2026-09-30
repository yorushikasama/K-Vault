/**
 * FontAwesome -> Lucide icon name mapping (K-Vault icon migration).
 *
 * Brand icons (github / telegram / discord / android / markdown) have no
 * Lucide equivalent and stay on FontAwesome; they are marked with `null`
 * and the migration leaves those elements untouched.
 *
 * Keys are FontAwesome class names WITHOUT the "fa-" prefix.
 * Values are Lucide names, or null to keep the original FontAwesome icon.
 */
const BRAND = null;

const FA_TO_LUCIDE = {
  // navigation / chrome
  home: "house",
  house: "house",
  images: "images",
  image: "image",
  cog: "settings",
  "hard-drive": "hard-drive",
  hdd: "hard-drive",
  database: "database",
  cloud: "cloud",
  cloud_upload_alt: "cloud-upload",
  "cloud-upload-alt": "cloud-upload",
  "cloud-download-alt": "cloud-download",
  "sign-out-alt": "log-out",
  "sign-in-alt": "log-in",
  "user-clock": "user",
  "user-secret": "user-round",
  user: "user",
  robot: "bot",
  "folder-tree": "folder-tree",
  "map-marker-alt": "map-pin",
  "location-arrow": "navigation",
  globe: "globe",
  "external-link-alt": "external-link",
  link: "link",
  terminal: "terminal",
  code: "code",
  shield: "shield",
  "shield-alt": "shield",
  wrench: "wrench",
  toolbox: "wrench",
  hammer: "hammer",
  key: "key",
  lock: "lock",
  unlock: "lock-open",
  eye: "eye",
  "eye-slash": "eye-off",
  search: "search",
  filter: "funnel",
  "sliders-h": "sliders-horizontal",
  cog_: "settings",

  // theme toggle
  moon: "moon",
  sun: "sun",

  // actions
  upload: "upload",
  download: "download",
  copy: "copy",
  clone: "copy",
  paste: "clipboard",
  edit: "pencil",
  pencil: "pencil",
  trash: "trash",
  "trash-alt": "trash",
  save: "save",
  broom: "brush",
  redo: "redo",
  sync: "refresh-cw",
  rotate: "rotate-cw",
  expand: "expand",
  compress: "shrink",
  "compress-alt": "minimize",
  times: "x",
  check: "check",
  "check-circle": "circle-check",
  "check-square": "square-check",
  "check-double": "check-check",
  "square-check": "square-check",
  "clipboard-check": "clipboard-check",
  plus: "plus",
  minus: "minus",
  "folder-plus": "folder-plus",
  share: "share-2",

  // status / feedback
  info: "info",
  "info-circle": "info",
  "circle-info": "info",
  "exclamation-circle": "circle-alert",
  "exclamation-triangle": "triangle-alert",
  "triangle-exclamation": "triangle-alert",
  "times-circle": "circle-x",
  ban: "ban",
  spinner: "loader-circle",
  "circle-notch": "loader-circle",
  heartbeat: "activity",
  "chart-line": "chart-line",
  bolt: "zap",
  palettes: "palette",
  palette: "palette",
  magic: "wand-sparkles",
  history: "clock-arrow-down",
  clock: "clock",

  // media / file types
  film: "film",
  video: "video",
  music: "music",
  play: "play",
  "wave-square": "audio-waveform",
  water: "waves-ladder",
  "compact-disc": "disc",
  images_: "images",

  file: "file",
  "file-alt": "file-text",
  "file-lines": "file-text",
  "file-pdf": "file-text",
  "file-word": "file-text",
  "file-excel": "file-spreadsheet",
  "file-powerpoint": "presentation",
  "file-image": "file-image",
  "file-video": "file-video-camera",
  "file-audio": "audio-lines",
  "file-code": "file-code",
  "file-archive": "file-archive",
  "file-zipper": "file-archive",
  "file-export": "file-output",
  "file-upload": "file-up",
  "file-arrow-down": "file-down",
  "file-download": "file-down",
  "file-audio-2": "audio-lines",

  // objects / misc
  folder: "folder",
  "folder-open": "folder-open",
  bookmark: "bookmark",
  heart: "heart",
  star: "star",
  inbox: "inbox",
  list: "list",
  "list-ul": "list",
  "list-check": "list-checks",
  "th-large": "layout-grid",
  "layer-group": "layers",
  cube: "box",
  "diagram-project": "network",
  "drafting-compass": "compass",
  font: "type",
  markdown_: "file-code",
  weight: "weight",
  "weight-hanging": "weight",
  "grip-lines": "grip-horizontal",
  tasks: "list-todo",
  envelope: "mail",
  "sort-amount-down": "arrow-down-wide-narrow",
  "sort-alpha-up": "arrow-down-a-z",
  "arrow-left": "arrow-left",
  "arrow-right": "arrow-right",
  "arrow-up": "arrow-up",
  "arrow-down": "arrow-down",
  "angle-left": "chevron-left",
  "angle-right": "chevron-right",
  "angle-double-left": "chevrons-left",
  "angle-double-right": "chevrons-right",
  "chevron-down": "chevron-down",
  "chevron-up": "chevron-up",
  square: "square",
  circle: "circle",
  "dot-circle": "circle-dot",

  // brands: no Lucide equivalent, keep FontAwesome
  github: BRAND,
  telegram: BRAND,
  discord: BRAND,
  android: BRAND,
  markdown: BRAND,
};

/** Normalize a raw FA class token (e.g. "fa-cloud-upload-alt") to a map key. */
function key(faToken) {
  return faToken.replace(/^fa-/, "");
}

/**
 * Convert one FontAwesome class token to a Lucide name.
 * Returns:
 *   { lucide: "moon" }         -> migrate to Lucide
 *   { brand: true }            -> leave FontAwesome alone
 *   { unknown: true }          -> not in table (caller should report)
 */
function lookup(faToken) {
  const k = key(faToken);
  if (!(k in FA_TO_LUCIDE)) return { unknown: true };
  const v = FA_TO_LUCIDE[k];
  if (v === BRAND) return { brand: true };
  return { lucide: v };
}

/** True if a class token is a FontAwesome icon name (not a style/size helper). */
function isIconToken(tok) {
  if (["fas", "far", "fab", "fa", "fa-solid", "fa-regular", "fa-brands"].includes(tok)) return false;
  // FontAwesome modifier helpers. Note: bare "fa-rotate" IS a real icon, so the
  // rotation helpers must be anchored to their numeric/degree form.
  if (/^fa-(solid|regular|brands|fw|ul|li|border)$/.test(tok)) return false;
  if (/^fa-(spin|pulse|beat|fade|flash|flip|bounce|shake|spin-pulse|spin-reverse)$/.test(tok)) return false;
  if (/^fa-(xs|sm|lg|2x|3x|4x|5x|6x|7x|8x|9x|10x)$/.test(tok)) return false;
  if (/^fa-(pull-left|pull-right|rotate-[0-9]+|flip-(horizontal|vertical|both))$/.test(tok)) return false;
  return /^fa-[a-z0-9-]+$/.test(tok);
}

/** True if the class token is a FontAwesome style selector (fas/far/fab/fa-solid/...). */
function isStyleToken(tok) {
  return ["fas", "far", "fab", "fa", "fa-solid", "fa-regular", "fa-brands"].includes(tok);
}

module.exports = { FA_TO_LUCIDE, lookup, isIconToken, isStyleToken };
