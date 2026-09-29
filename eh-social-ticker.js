/**
 * EasyHome – popup thông báo cho easyhome.vn (v3 – đơn web + đơn sàn thật)
 * Dán cuối <body>:  <script src="eh-social-ticker.js" defer></script>
 *
 * Nguyên tắc: mọi thứ hiện ra đều THẬT, và mỗi khách không thấy lại cùng 1 nội dung.
 * - Đơn thật: tối đa 2 cái/lượt, NHỚ qua các lần ghé (localStorage) -> không bao giờ lặp với cùng 1 khách.
 * - Số liệu tổng thật (tổng đơn, số tỉnh) – chỉ hiện khi đủ ngưỡng.
 * - Nội dung "thường xanh" mày tự điền: review Google thật, video mới, cam kết...
 * - Gợi ý sản phẩm random từ easyhome.requa.vn – kho vô tận, không bao giờ cạn.
 */
(function () {
  const CFG = {
    ORDERS_URL: 'https://script.google.com/macros/s/AKfycbzNCTkgEsahkjMN8Y-Y1AD0KdrEJcjsVruEAlrlpMClceI9oLQMlCG0uCR8H497ptJg/exec', // URL deploy eh-recent-orders.gs
    SHOP_URL: 'https://easyhome.requa.vn',
    FIRST_DELAY: [7000, 14000],
    GAP: [16000, 58000],
    SHOW_MS: [5500, 7500],
    MAX_PER_VISIT: 6,
    MAX_ORDERS_PER_VISIT: 3,    // tổng đơn web + đơn sàn mỗi lượt
    MAX_BEST_PER_VISIT: 1,      // popup "bán chạy" mỗi lượt
    STATS_MIN: { total: 30 },   // chưa đủ thì không khoe
    // Nội dung thật do mày tự điền (review copy nguyên từ Google Maps, video mới đăng...)
    EXTRA: [
      // { icon: '⭐', html: '<b>Chị Lan</b> đánh giá 5★ trên Google: "Hàng y hình, giao nhanh"', url: 'https://maps.app.goo.gl/...' },
      // { icon: '🎬', html: 'Video mới: <span class="pr">Mở hộp Hộp Inox Bà Ngoại</span>', url: 'https://youtube.com/...' },
      { icon: '📦', html: 'Được <b>kiểm tra hàng trước khi trả tiền</b> – không ưng không nhận', url: null },
      { icon: '🏪', html: 'Cửa hàng thật tại Hà Nội · <span class="pr">5.0★ trên Google</span>', url: null }
    ],
    // Gợi ý SP: 1 request tới Function cùng origin (?random=1 → 24 SP còn hàng ngẫu nhiên, không có giá).
    // Lỗi / quá 4s → [] (không gợi ý, không bịa).
    getProducts: function () {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 4000);
      return fetch('/api/search?random=1&limit=24', { signal: ac.signal })
        .then(r => r.ok ? r.json() : null).catch(() => null).finally(() => clearTimeout(to))
        .then(d => ((d && d.success && d.data && d.data.items) || [])
          .filter(p => p.product_name && p.link)
          .map(p => ({ name: p.product_name, url: p.link, img: p.thumbnail_url || '' })));   // product_name→name, link→url, thumbnail_url→img
    }
  };
  if (sessionStorage.getItem('eh_tk_off')) return;

  const rnd = (a, b) => a + Math.random() * (b - a);
  const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  const LS = 'eh_tk_seen';
  const seen = new Set(JSON.parse(localStorage.getItem(LS) || '[]'));
  const markSeen = k => { seen.add(k); try { localStorage.setItem(LS, JSON.stringify([...seen].slice(-200))); } catch (e) {} };

  let queue = [], products = [], shown = 0, timer, lastProd = '';

  function agoDate(t) {           // dữ liệu chỉ có ngày (đơn sàn)
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const d1 = new Date(t); d1.setHours(0, 0, 0, 0);
    const d = Math.round((d0 - d1) / 864e5);
    if (d <= 0) return 'hôm nay';
    if (d === 1) return 'hôm qua';
    return d < 14 ? d + ' ngày trước' : Math.round(d / 7) + ' tuần trước';
  }
  function ago(t) {
    const m = Math.max(1, Math.round((Date.now() - t) / 60000));
    if (m < 60) return m + ' phút trước';
    const h = Math.round(m / 60); if (h < 24) return h + ' giờ trước';
    const d = Math.round(h / 24); if (d === 1) return 'hôm qua';
    return d < 14 ? d + ' ngày trước' : Math.round(d / 7) + ' tuần trước';
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- UI ----------
  const css = `
  .ehtk{position:fixed;left:16px;bottom:88px;z-index:9998;max-width:340px;display:flex;gap:10px;align-items:center;
    padding:10px 36px 10px 10px;border-radius:16px;background:#12211C;color:#EAF4F0;font:500 13px/1.35 "Be Vietnam Pro",system-ui,sans-serif;
    border:1px solid rgba(95,169,140,.28);box-shadow:0 14px 34px -12px rgba(18,179,168,.45);
    transform:translateY(24px) scale(.96);opacity:0;pointer-events:none;
    transition:transform .45s cubic-bezier(.2,1.4,.4,1),opacity .3s}
  .ehtk.on{transform:none;opacity:1;pointer-events:auto}
  .ehtk .ic{flex:0 0 44px;height:44px;border-radius:12px;background:#1B3A30 center/cover;display:grid;place-items:center;font-size:20px;position:relative}
  .ehtk .dot{position:absolute;right:-3px;top:-3px;width:10px;height:10px;border-radius:50%;background:#1FD17A}
  .ehtk .dot::after{content:"";position:absolute;inset:0;border-radius:50%;background:#1FD17A;animation:ehtkPing 1.6s infinite}
  .ehtk b{color:#fff;font-weight:700}.ehtk .pr{color:#5FE3C8;font-weight:700}
  .ehtk small{display:block;color:#8FB3A6;font-size:11.5px;margin-top:2px}
  .ehtk a{color:inherit;text-decoration:none}
  .ehtk .x{position:absolute;right:6px;top:6px;width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:#8FB3A6;cursor:pointer;font-size:15px}
  .ehtk .x:hover{background:rgba(255,255,255,.08)}
  @keyframes ehtkPing{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(2.6);opacity:0}}
  @media (max-width:520px){.ehtk{left:10px;right:10px;max-width:none;bottom:calc(84px + env(safe-area-inset-bottom))}}
  @media (prefers-reduced-motion:reduce){.ehtk{transition:opacity .2s;transform:none}.ehtk .dot::after{animation:none}}`;
  document.head.insertAdjacentHTML('beforeend', '<style>' + css + '</style>');
  const box = document.createElement('div');
  box.className = 'ehtk'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
  document.body.appendChild(box);

  let hovering = false, hideT;
  box.addEventListener('mouseenter', () => { hovering = true; clearTimeout(hideT); });
  box.addEventListener('mouseleave', () => { hovering = false; hideT = setTimeout(hide, 2500); });
  function hide() { box.classList.remove('on'); }

  function render(item) {
    const live = item.live ? '<span class="dot"></span>' : '';
    const icon = item.img ? `<div class="ic" style="background-image:url('${item.img}')">${live}</div>`
                          : `<div class="ic">${item.icon || '🏠'}${live}</div>`;
    const body = item.url ? `<a href="${item.url}" target="_blank" rel="noopener">${item.html}</a>` : item.html;
    box.innerHTML = icon + '<div>' + body + '</div><button class="x" aria-label="Tắt thông báo">×</button>';
    box.querySelector('.x').onclick = () => { sessionStorage.setItem('eh_tk_off', 1); hide(); clearTimeout(timer); };
    box.classList.add('on');
    hideT = setTimeout(() => { if (!hovering) hide(); }, rnd(...CFG.SHOW_MS));
  }

  // ---------- Dựng hàng đợi cho lượt ghé này ----------
  function buildQueue(data) {
    const q = [];
    const fresh = (arr, prefix) => (arr || []).map(x => ({ x, k: prefix + x.id })).filter(o => !seen.has(o.k));

    // 1) Đơn thật: trộn đơn web (có tên, tỉnh) + đơn sàn đã giao, ưu tiên mới nhất
    const web = fresh(data.items, 'w:').map(({ x, k }) => ({ key: k, t: x.t, live: true, url: CFG.SHOP_URL,
      html: `<b>${esc(x.name)}</b>${x.place ? ' (' + esc(x.place) + ')' : ''} ${Date.now() - x.t < 3 * 36e5 ? 'vừa đặt' : 'đã đặt'} <span class="pr">${esc(x.product)}</span><small>${ago(x.t)} · đặt trên web</small>` }));
    const shop = fresh(data.shop, 's:').map(({ x, k }) => ({ key: k, t: x.t, live: true, icon: '✅', url: null,   // dữ liệu sàn: SP có thể không có trên web -> không gắn link
      html: `Khách ${esc(x.platform)} đã nhận <span class="pr">${esc(x.product)}</span>${x.qty > 1 ? ' ×' + x.qty : ''}<small>${agoDate(x.t)} · giao thành công</small>` }));
    // lấy mới nhất nhưng xen kẽ web/sàn cho đa dạng
    web.sort((a, b) => b.t - a.t); shop.sort((a, b) => b.t - a.t);
    const mixed = [];
    while ((web.length || shop.length) && mixed.length < CFG.MAX_ORDERS_PER_VISIT) {
      const takeWeb = web.length && (!shop.length || Math.random() < 0.5);
      // đơn sàn nhiều -> random trong ~10 đơn mới nhất để mỗi khách thấy khác nhau
      mixed.push(takeWeb ? web.shift() : shop.splice(Math.floor(Math.random() * Math.min(10, shop.length)), 1)[0]);
    }
    q.push(...mixed);

    // 2) Sản phẩm bán chạy (số lượng thật 30 ngày)
    fresh(data.best, 'b:').sort(() => Math.random() - 0.5).slice(0, CFG.MAX_BEST_PER_VISIT)
      .forEach(({ x, k }) => q.push({ key: k, icon: '🔥', url: null,   // dữ liệu sàn: không gắn link
        html: `<span class="pr">${esc(x.product)}</span> đã giao <b>${x.qty} chiếc</b> trên sàn<small>trong ${x.days} ngày qua</small>` }));

    // 3) Số liệu tổng – mỗi khách 1 lần/ngày, chọn 1 trong 2 kiểu
    const s = data.stats || {}, sk = 's:' + new Date().toDateString();
    if (!seen.has(sk) && s.total >= CFG.STATS_MIN.total) {
      const opts = [`Đã giao thành công <b>${s.totalRounded}+ đơn</b><small>trên web & các sàn</small>`];
      if (s.last7 >= 10) opts.push(`<b>${s.last7} đơn</b> giao thành công trong 7 ngày qua<small>Số liệu cập nhật tự động</small>`);
      q.push({ key: sk, icon: '🚚', html: opts[Math.floor(Math.random() * opts.length)] });
    }

    // 4) Nội dung thật tự điền
    shuffle(CFG.EXTRA).map(e => ({ ...e, key: 'e:' + e.html.slice(0, 40) }))
      .sort((a, b) => seen.has(a.key) - seen.has(b.key))
      .slice(0, 2).forEach(e => q.push(e));

    return shuffle(q);
  }

  function nextProduct() {
    if (!products.length) return null;
    let p, n = 0; do { p = products[Math.floor(Math.random() * products.length)]; } while (p.name === lastProd && ++n < 5);
    lastProd = p.name;
    return { img: p.img, url: p.url || CFG.SHOP_URL,
      html: `✨ Gợi ý cho bạn: <span class="pr">${esc(p.name)}</span><small>Xem chi tiết trên web EasyHome ›</small>` };
  }

  function next() {
    // Xen kẽ: ~40% gợi ý SP (vô tận), còn lại lấy từ hàng đợi thật
    let item = (Math.random() < 0.4 || !queue.length) ? nextProduct() : null;
    if (!item) item = queue.shift();
    if (!item) return false;
    if (item.key) markSeen(item.key);
    render(item); return true;
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.hidden) return schedule(rnd(4000, 9000));
      if (shown >= CFG.MAX_PER_VISIT) return;
      if (next()) shown++; else return;
      schedule(Math.random() < 0.2 ? rnd(9000, 15000) : rnd(...CFG.GAP));
    }, delay);
  }

  // ---------- Tải dữ liệu ----------
  let data = {};
  Promise.allSettled([
    /XXXX/.test(CFG.ORDERS_URL) ? Promise.resolve() : fetch(CFG.ORDERS_URL).then(r => r.json()).then(d => { data = d || {}; }),   // chưa điền URL /exec → bỏ qua
    CFG.getProducts ? Promise.resolve(CFG.getProducts()).then(a => { products = a || []; }) : Promise.resolve()
  ]).then(() => {
    queue = buildQueue(data);
    if (queue.length || products.length) schedule(rnd(...CFG.FIRST_DELAY));
  });
})();
