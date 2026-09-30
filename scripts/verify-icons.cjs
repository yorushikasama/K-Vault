/**
 * 验证 Lucide 图标迁移：在真实 Chrome 里逐页统计
 *   - 已渲染的 <svg class="lucide ...">
 *   - 未转换的 [data-lucide] 占位符（应为 0）
 *   - 残留的 FontAwesome <i class="fa-...">（只应剩品牌图标）
 *
 * 用法: node scripts/verify-icons.cjs
 * 前置: Chrome 以 --remote-debugging-port=9222 启动，dev server 跑在 8080。
 */
const PORT = Number(process.env.CDP_PORT || 9222);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const PAGES = [
  '/',
  '/login.html',
  '/gallery.html',
  '/webdav.html',
  '/admin-waterfall.html',
  '/block-img.html',
  '/whitelist-on.html',
  '/admin.html',
  '/admin-imgtc.html',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) return pg;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error('CDP target not found on port ' + PORT);
}

const PROBE = `JSON.stringify({
  svgs: document.querySelectorAll('svg.lucide').length,
  pending: document.querySelectorAll('[data-lucide]:not(svg)').length,
  faLeft: Array.prototype.slice.call(document.querySelectorAll('i[class*="fa-"]'))
            .filter(function(e){ return !e.className.match(/fa-brands|fab/); }).length,
  brand: document.querySelectorAll('.fab, .fa-brands').length
})`;

(async () => {
  const pg = await getPageTarget();
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const send = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      const h = (m) => {
        const j = JSON.parse(m.data);
        if (j.id === myId) { ws.removeEventListener('message', h); resolve(j); }
      };
      ws.addEventListener('message', h);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  await send('Page.enable', {});

  let failures = 0;
  console.log('page'.padEnd(24), 'svgs', 'pending', 'faLeft', 'brand');
  for (const p of PAGES) {
    await send('Page.navigate', { url: BASE + p });
    // The Lucide bundle is remote (CDN) and can take seconds; poll until the
    // runtime is present and every placeholder has been converted, rather than
    // sampling on a fixed delay.
    let res, raw;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      res = await send('Runtime.evaluate', {
        expression:
          "JSON.stringify({ready: typeof window.lucide !== 'undefined' && typeof window.KVIcons !== 'undefined'," +
          " pending: document.querySelectorAll('[data-lucide]:not(svg)').length})",
        returnByValue: true,
      });
      const probe = res.result && res.result.result && res.result.result.value;
      if (probe) {
        const q = JSON.parse(probe);
        if (q.ready && q.pending === 0) break;
      }
    }
    res = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    raw = res.result && res.result.result && res.result.result.value;
    if (!raw) { console.log(p.padEnd(24), 'PROBE FAILED'); failures++; continue; }
    const o = JSON.parse(raw);
    // A page is healthy when nothing is left unconverted and no stray FA remains.
    const ok = o.pending === 0 && o.faLeft === 0;
    if (!ok) failures++;
    console.log(
      p.padEnd(24),
      String(o.svgs).padStart(4),
      String(o.pending).padStart(7),
      String(o.faLeft).padStart(6),
      String(o.brand).padStart(5),
      ok ? '' : '  <-- CHECK'
    );
  }
  ws.close();
  console.log(failures === 0 ? '\nALL PAGES OK' : `\n${failures} PAGE(S) NEED ATTENTION`);
  process.exit(failures === 0 ? 0 : 1);
})();
