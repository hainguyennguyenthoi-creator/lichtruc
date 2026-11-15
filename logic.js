// logic.js – Các hàm tính toán thuần, KHÔNG phụ thuộc Firebase (test độc lập được bằng Node).
// Quy ước:
//   - Ngày dạng 'YYYY-MM-DD', tháng dạng 'YYYY-MM', ngày trong tháng dạng 'DD' (2 chữ số).
//   - months[m] = { shifts: {'01': doctorId, ...}, holidays: ['02', ...], status: 'published'|'locked' }
//   - Giao dịch (tx): { type, legs:[{date, from, to}], status, confirmedAt, expiresAt, buyer, reversed, ... }

export const THU = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const pad = n => String(n).padStart(2, '0');

// Chuẩn hóa tên: Unicode NFC, bỏ khoảng trắng thừa, chữ thường → so khớp tên có dấu ổn định
export const norm = s => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

// Ngày hôm nay theo giờ Việt Nam (UTC+7)
export function vnToday(now = Date.now()) {
  const d = new Date(now + 7 * 3600e3);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export const monthOf = date => date.slice(0, 7);
export function daysIn(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
// Thứ trong tuần: 0 = CN, 1 = T2 ... 6 = T7
export function dow(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function addMonth(m, k) {
  let [y, mo] = m.split('-').map(Number);
  mo += k;
  while (mo > 12) { mo -= 12; y++; }
  while (mo < 1) { mo += 12; y--; }
  return `${y}-${pad(mo)}`;
}
export const fmtDate = date => `${THU[dow(date)]} ${date.slice(8)}/${date.slice(5, 7)}`;

// Chủ nhật hoặc ngày lễ (trực 24h)
export function isCnLe(date, months) {
  const mo = months[monthOf(date)];
  return dow(date) === 0 || !!(mo && (mo.holidays || []).includes(date.slice(8)));
}
// Giờ bắt đầu ca (ms): ngày thường 16h, CN/lễ 7h – giờ VN
export function shiftStart(date, months) {
  return new Date(`${date}T${isCnLe(date, months) ? '07' : '16'}:00:00+07:00`).getTime();
}
export const hoursOf = (date, months) => (isCnLe(date, months) ? 24 : 15);

// Người nhận ca của 1 leg (bán công khai: to = null, người mua nằm ở tx.buyer)
export const legTo = (t, l) => l.to || t.buyer || null;

// Đổi Timestamp Firestore / số / null → mili-giây
export const tsMs = v => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
};

// Tính lịch hiện hành của tháng m = lịch gốc + giao dịch confirmed theo thứ tự thời gian xác nhận
export function computeSchedule(m, months, txs) {
  const mon = months[m];
  if (!mon) return null;
  const base = { ...(mon.shifts || {}) };
  const holder = { ...base };
  const hist = {};
  const conf = txs
    .filter(t => t.status === 'confirmed')
    .sort((a, b) => tsMs(a.confirmedAt) - tsMs(b.confirmedAt));
  for (const t of conf) {
    for (const l of t.legs || []) {
      if (monthOf(l.date) !== m) continue;
      const dd = l.date.slice(8);
      const to = legTo(t, l);
      if (!to) continue;
      (hist[dd] ||= []).push({ tx: t, from: holder[dd] || null, to, mismatch: !!l.from && holder[dd] !== l.from });
      holder[dd] = to;
    }
  }
  return { base, holder, hist };
}

// Các ngày đang có yêu cầu chờ (chưa hết hạn) → { date: tx }
export function activePendingByDate(txs, now = Date.now()) {
  const map = {};
  for (const t of txs) {
    if (t.status === 'pending' && tsMs(t.expiresAt) > now) for (const l of t.legs || []) map[l.date] = t;
  }
  return map;
}

// Danh sách ca mà BS docId có thể đổi/bán: đang giữ, chưa tới giờ bắt đầu, không đang chờ, tháng chưa khóa
export function eligibleShifts(docId, months, txs, now = Date.now()) {
  if (!docId) return [];
  const pend = activePendingByDate(txs, now);
  const cur = monthOf(vnToday(now));
  const out = [];
  for (const m of Object.keys(months).sort()) {
    if (m < cur || months[m].status === 'locked') continue;
    const sch = computeSchedule(m, months, txs);
    for (const dd of Object.keys(sch.holder).sort()) {
      const date = `${m}-${dd}`;
      if (sch.holder[dd] === docId && shiftStart(date, months) > now && !pend[date]) out.push(date);
    }
  }
  return out;
}

// Thống kê tháng m cho từng BS
export function monthStats(m, months, txs, doctorIds = []) {
  const sch = computeSchedule(m, months, txs);
  if (!sch) return null;
  const st = {};
  const get = id => (st[id] ||= { thuong: 0, cnle: 0, gio: 0, goc: 0, doiDi: 0, doiDen: 0, ban: 0, mua: 0, adj: 0, thay: 0, nho: 0 });
  const soldCover = new Set(txs.filter(t => t.type === 'DEBT_TO_SELL' && t.status === 'confirmed' && !t.reversed).map(t => t.refId));
  doctorIds.forEach(get);
  for (const id of Object.values(sch.base)) if (id) get(id).goc++;
  for (const [dd, id] of Object.entries(sch.holder)) {
    if (!id) continue;
    const date = `${m}-${dd}`;
    const s = get(id);
    if (isCnLe(date, months)) s.cnle++; else s.thuong++;
    s.gio += hoursOf(date, months);
  }
  for (const t of txs) {
    if (t.status !== 'confirmed' || t.reversed || t.type === 'REVERSAL') continue;
    for (const l of t.legs || []) {
      if (monthOf(l.date) !== m) continue;
      const to = legTo(t, l);
      if (t.type === 'SWAP2' || t.type === 'SWAP3') { if (l.from) get(l.from).doiDi++; if (to) get(to).doiDen++; }
      else if (t.type === 'SELL' || t.type === 'SELL_OPEN') { if (l.from) get(l.from).ban++; if (to) get(to).mua++; }
      else if (t.type === 'ADMIN_ADJUST') { if (to) get(to).adj++; }
      else if (t.type === 'COVER') {
        if (soldCover.has(t.id)) { if (l.from) get(l.from).ban++; if (to) get(to).mua++; }
        else { if (l.from) get(l.from).nho++; if (to) get(to).thay++; }
      }
    }
  }
  return st;
}

// Nợ tua từ giao dịch trực thay (COVER): trả bằng REPAY hoặc chuyển thành bán bằng DEBT_TO_SELL (confirmed, refId = id COVER)
// Trả về danh sách { id, cover, debtor, creditor, date, cnle, status: 'open'|'repaid'|'sold', pendingTx }
export function debts(txs, months) {
  const byRef = {};
  for (const t of txs) if ((t.type === 'REPAY' || t.type === 'DEBT_TO_SELL') && t.refId) (byRef[t.refId] ||= []).push(t);
  return txs
    .filter(t => t.type === 'COVER' && t.status === 'confirmed' && !t.reversed && t.legs?.length)
    .map(c => {
      const l = c.legs[0];
      const rel = byRef[c.id] || [];
      const done = rel.find(t => t.status === 'confirmed');
      const pendingTx = rel.find(t => t.status === 'pending' && tsMs(t.expiresAt) > Date.now());
      return { id: c.id, cover: c, debtor: l.from, creditor: l.to, date: l.date, cnle: isCnLe(l.date, months),
        status: done ? (done.type === 'REPAY' ? 'repaid' : 'sold') : 'open', pendingTx, doneTx: done };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Sinh lịch theo vòng xoay: order = [id...], startId = BS trực ngày 1
export function rotation(m, order, startId) {
  const n = daysIn(m);
  const i0 = Math.max(0, order.indexOf(startId));
  const rows = {};
  for (let d = 1; d <= n; d++) rows[pad(d)] = order[(i0 + d - 1) % order.length];
  return rows;
}

// Đọc mã LT v1. doctors = [{id, name, active}]
// Trả { month, holidays, rows, errors[], warnings[] }
export function parseLT(text, doctors) {
  const errors = [], warnings = [];
  const lines = String(text || '').normalize('NFC').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length || !/^#LT\s+v1$/i.test(lines[0])) errors.push('Dòng đầu phải là "#LT v1".');
  const byName = {};
  doctors.forEach(d => { byName[norm(d.name)] = d; });
  let month = null, holidays = [], tong = null, end = null, count = 0;
  const rows = {}, thuOf = {}, nameOf = {};
  for (const raw of lines.slice(1)) {
    let mm;
    if ((mm = raw.match(/^THANG\s+(\d{4})-(\d{1,2})$/i))) { month = `${mm[1]}-${pad(+mm[2])}`; continue; }
    if (/^LE(\s|$)/i.test(raw)) {
      holidays = raw.slice(2).trim().split(/[\s,]+/).filter(Boolean).map(x => pad(+x));
      continue;
    }
    if (/^VT(\s|$)/i.test(raw)) continue; // tương thích bản nháp cũ
    if (/^TONG(\s|$)/i.test(raw)) {
      tong = {};
      for (const x of raw.slice(4).matchAll(/([^=]+?)=(\d+)/g)) tong[norm(x[1])] = +x[2];
      continue;
    }
    if ((mm = raw.match(/^#END\s+(\d+)$/i))) { end = +mm[1]; continue; }
    if ((mm = raw.match(/^(\d{1,2})\s+(T[2-7]|CN)\s+(.+)$/i))) {
      const dd = pad(+mm[1]);
      const name = mm[3].trim();
      count++;
      if (dd in rows) { errors.push(`Ngày ${dd} bị lặp.`); continue; }
      thuOf[dd] = mm[2].toUpperCase();
      nameOf[dd] = name;
      if (name === '?') { errors.push(`Ngày ${dd} còn "?" – cần sửa.`); rows[dd] = null; continue; }
      const d = byName[norm(name)];
      if (!d) { errors.push(`Ngày ${dd}: tên "${name}" không có trong danh sách BS.`); rows[dd] = null; continue; }
      if (d.active === false) errors.push(`Ngày ${dd}: BS ${d.name} đang ngừng hoạt động.`);
      rows[dd] = d.id;
      continue;
    }
    errors.push(`Không hiểu dòng: "${raw}"`);
  }
  if (!month) errors.push('Thiếu dòng THANG YYYY-MM.');
  else {
    const n = daysIn(month);
    for (let d = 1; d <= n; d++) {
      const dd = pad(d);
      if (!(dd in rows)) errors.push(`Thiếu ngày ${dd}.`);
      else if (THU[dow(`${month}-${dd}`)] !== thuOf[dd]) errors.push(`Ngày ${dd}: ghi ${thuOf[dd]} nhưng thực tế là ${THU[dow(`${month}-${dd}`)]}.`);
    }
    for (const dd of Object.keys(rows)) if (+dd < 1 || +dd > n) errors.push(`Ngày ${dd} không tồn tại trong tháng.`);
    for (const h of holidays) if (+h < 1 || +h > n) errors.push(`Ngày lễ ${h} không hợp lệ.`);
  }
  if (tong) {
    const cnt = {};
    Object.values(nameOf).forEach(nm => { cnt[norm(nm)] = (cnt[norm(nm)] || 0) + 1; });
    const keys = new Set([...Object.keys(cnt), ...Object.keys(tong)]);
    keys.delete('?');
    for (const k of keys) if ((cnt[k] || 0) !== (tong[k] || 0)) errors.push(`TONG lệch: "${k}" ghi ${tong[k] || 0}, đếm được ${cnt[k] || 0}.`);
  } else warnings.push('Không có dòng TONG – bỏ qua kiểm tra tổng.');
  if (end === null) warnings.push('Không có dòng #END.');
  else if (end !== count) errors.push(`#END ghi ${end} nhưng có ${count} dòng ca.`);
  return { month, holidays: [...new Set(holidays)].sort(), rows, errors, warnings };
}
