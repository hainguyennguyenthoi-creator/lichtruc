// app.js – Giao diện + thao tác Firebase cho web Lịch trực.
// Nguyên tắc: lịch gốc bất biến; mọi thay đổi là 1 giao dịch (transactions) có truy vết.
// Đổi số v khi sửa config.js / logic.js để điện thoại tải bản mới
import { firebaseConfig, MAIL_URL, APP_TITLE } from './config.js?v=2';
import * as L from './logic.js?v=2';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, updateDoc, deleteDoc, runTransaction,
  serverTimestamp, Timestamp, writeBatch, getDoc, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

// ===================== TRẠNG THÁI =====================
const S = {
  authReady: false, user: null, member: undefined, subscribed: false, unsub: [],
  doctors: {}, members: {}, months: {}, txs: [], locks: {},
  tab: 'lich', view: 'current', month: L.vnToday().slice(0, 7),
  form: {}, ed: null, editDoc: null, adj: {}, busy: false, _sch: {},
  setupDone: undefined, logs: [], tkMode: 'thang', logFilter: '', newMem: { email: '', role: 'viewer' },
};

// ===================== TIỆN ÍCH =====================
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const myEmail = () => (S.user?.email || '').toLowerCase();
const myDoc = () => S.member?.doctorId || '';
const isAdmin = () => S.member?.role === 'admin' && S.member?.active === true;
const dname = id => (id ? S.doctors[id]?.name || '(không rõ)' : '—');
const dcolor = id => S.doctors[id]?.color || '#333';
const doctorList = (activeOnly = true) =>
  Object.values(S.doctors).filter(d => !activeOnly || d.active !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const sched = m => (S._sch[m] ??= L.computeSchedule(m, S.months, S.txs));
const pendMap = () => L.activePendingByDate(S.txs);
const holderOf = date => sched(L.monthOf(date))?.holder[date.slice(8)];
const fmtTime = v => { const ms = L.tsMs(v); return ms ? new Date(ms).toLocaleString('vi-VN', { hour12: false }) : ''; };
const TYPE = { SWAP2: 'Đổi 2 người', SWAP3: 'Đổi 3 người', SELL: 'Bán đích danh', SELL_OPEN: 'Bán công khai', COVER: 'Trực thay (trả sau)', REPAY: 'Trả nợ trực thay', DEBT_TO_SELL: 'Chuyển nợ thành bán', ADMIN_ADJUST: 'Admin chỉnh', REVERSAL: 'Đảo ngược' };
const STATUS = { pending: 'Đang chờ', confirmed: 'Đã xác nhận', rejected: 'Bị từ chối', cancelled: 'Đã hủy', expired: 'Hết hạn' };

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + (ok ? 'ok' : 'err');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ''), 3500);
}
function errMsg(e) {
  const m = e?.message || String(e);
  if (/permission|insufficient/i.test(m)) return 'Không có quyền thực hiện (hoặc đã quá giờ bắt đầu ca).';
  return m;
}
function modal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet"><button class="x" data-act="closeModal">✕</button>${html}</div>`;
  m.classList.remove('hidden');
}
const closeModal = () => $('#modal').classList.add('hidden');
const opt = (v, t, sel) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(t)}</option>`;
const select = (attr, name, items, val, ph = '— chọn —') =>
  `<select ${attr}="${name}"><option value="">${ph}</option>${items.map(([v, t]) => opt(v, t, val)).join('')}</select>`;

// Mô tả giao dịch thành các dòng chữ
function coverById(id) { return S.txs.find(x => x.id === id); }
function legLines(t) {
  if (t.type === 'DEBT_TO_SELL') {
    const c = coverById(t.refId), l = c?.legs?.[0];
    return [l ? `Ca ${L.fmtDate(l.date)}: ${dname(l.from)} bán cho ${dname(l.to)} (thay vì nợ)` : '(không tìm thấy giao dịch gốc)'];
  }
  const extra = t.type === 'REPAY' && coverById(t.refId) ? ` (trả nợ ca ${L.fmtDate(coverById(t.refId).legs[0].date)})` : '';
  return (t.legs || []).map((l, i) => {
    const to = L.legTo(t, l);
    return `${L.fmtDate(l.date)}: ${dname(l.from)} → ${to ? dname(to) : '(ai nhận trước)'}${i === 0 ? extra : ''}`;
  });
}
function describe(t) {
  if (t.counterOf) return `<b>Đề nghị đổi ngày khác</b> – từ BS ${esc(dname(t.creatorDoctor))}<br>${legLines(t).map(esc).join('<br>')}`;
  return `<b>${TYPE[t.type] || t.type}</b> – tạo bởi BS ${esc(dname(t.creatorDoctor))}<br>${legLines(t).map(esc).join('<br>')}`;
}
const participants = t => [...new Set([t.creatorDoctor, ...(t.invitees || []), t.buyer, ...(t.legs || []).flatMap(l => [l.from, l.to])].filter(Boolean))];

// ===================== EMAIL (qua Google Apps Script) =====================
async function mail(docIds, subject, lines) {
  return mailTo([...new Set(docIds.map(id => S.doctors[id]?.email).filter(Boolean))], subject, lines);
}
async function mailTo(list, subject, lines) {
  if (!MAIL_URL) return;
  const emails = [...new Set(list.filter(Boolean).map(e => e.toLowerCase()))].filter(e => e !== myEmail());
  if (!emails.length) return;
  try {
    const idToken = await auth.currentUser.getIdToken();
    await fetch(MAIL_URL, {
      method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ idToken, to: emails, subject, body: lines.join('\n') + `\n\nMở web: ${location.origin + location.pathname}` }),
    });
  } catch (e) { console.warn('Gửi mail lỗi', e); }
}

// ===================== ĐĂNG NHẬP & ĐỒNG BỘ DỮ LIỆU =====================
onAuthStateChanged(auth, u => {
  S.unsub.forEach(f => f());
  S.unsub = []; S.subscribed = false;
  S.authReady = true; S.user = u; S.member = undefined;
  render();
  if (!u) return;
  S.unsub.push(onSnapshot(doc(db, 'members', myEmail()), s => {
    S.member = s.exists() ? s.data() : null;
    if (S.member?.active) subscribeAll();
    if (!S.member) {
      // Chưa là thành viên: kiểm tra hệ thống đã khởi tạo chưa (lần đầu → cho tạo admin)
      getDoc(doc(db, 'meta', 'setup')).then(m => { S.setupDone = m.exists(); render(); }).catch(() => { S.setupDone = true; render(); });
    }
    render();
  }, () => { S.member = null; render(); }));
});

function subscribeAll() {
  if (S.subscribed) return;
  S.subscribed = true;
  const on = (name, fn) => S.unsub.push(onSnapshot(collection(db, name), snap => { fn(snap); afterData(); }, e => console.error(name, e)));
  on('doctors', s => { S.doctors = {}; s.forEach(d => (S.doctors[d.id] = { id: d.id, ...d.data() })); });
  on('members', s => { S.members = {}; s.forEach(d => (S.members[d.id] = d.data())); });
  on('months', s => { S.months = {}; s.forEach(d => (S.months[d.id] = { id: d.id, ...d.data() })); });
  on('transactions', s => { S.txs = []; s.forEach(d => S.txs.push({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })); S.txLoaded = true; });
  on('locks', s => { S.locks = {}; s.forEach(d => (S.locks[d.id] = d.data())); });
  if (isAdmin()) {
    S.unsub.push(onSnapshot(query(collection(db, 'logs'), orderBy('at', 'desc'), limit(300)), s => {
      S.logs = []; s.forEach(d => S.logs.push({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })); render();
    }, e => console.error('logs', e)));
  }
}

// Ghi nhật ký admin vào cùng batch
const LOGTYPE = { doctor: 'Bác sĩ', member: 'Tài khoản', month: 'Lịch tháng' };
function logAct(b, kind, text) {
  b.set(doc(collection(db, 'logs')), { kind, text, by: myEmail(), at: serverTimestamp() });
}

function afterData() {
  if (!S.monthPicked && Object.keys(S.months).length) {
    S.monthPicked = true;
    if (!S.months[S.month]) {
      const later = Object.keys(S.months).filter(m => m > S.month).sort()[0];
      const earlier = Object.keys(S.months).filter(m => m < S.month).sort().pop();
      S.month = later || earlier || S.month;
    }
  }
  render();
  clearTimeout(afterData._t);
  afterData._t = setTimeout(cleanup, 1500);
}
// Mỗi phút: vẽ lại (cập nhật trạng thái hết hạn) + dọn yêu cầu quá giờ
setInterval(() => { if (S.subscribed) { render(); cleanup(); } }, 60000);

// Dọn dẹp: yêu cầu pending đã quá giờ bắt đầu ca → expired; khóa ca mồ côi → xóa
async function cleanup() {
  if (!S.subscribed || !S.member?.active) return;
  const now = Date.now();
  for (const t of S.txs) {
    if (t.status !== 'pending' || L.tsMs(t.expiresAt) > now - 5000) continue;
    try {
      let done = false;
      await runTransaction(db, async tr => {
        const s = await tr.get(doc(db, 'transactions', t.id));
        if (!s.exists() || s.data().status !== 'pending') return;
        tr.update(s.ref, { status: 'expired', closedAt: serverTimestamp() });
        s.data().legs.forEach(l => tr.delete(doc(db, 'locks', l.date)));
        done = true;
      });
      if (done) mail(participants(t), 'Yêu cầu đổi/bán trực đã hết hạn', ['Yêu cầu sau đã hết hạn vì tới giờ bắt đầu ca mà chưa được xác nhận:', ...legLines(t)]);
    } catch (e) { console.warn('expire', e); }
  }
  if (!S.txLoaded) return;
  for (const [date, lk] of Object.entries(S.locks)) {
    const t = S.txs.find(x => x.id === lk.tx);
    if ((!t && now - L.tsMs(lk.at) > 120000) || (t && t.status !== 'pending')) deleteDoc(doc(db, 'locks', date)).catch(() => {});
  }
}

// ===================== GIAO DỊCH =====================
// Tạo yêu cầu (pending) + khóa các ngày liên quan, nguyên tử
async function createTx(data) {
  const dates = data.legs.map(l => l.date);
  const pend = pendMap();
  for (const d of dates) {
    if (pend[d]) throw new Error(`Ca ${L.fmtDate(d)} đang có yêu cầu khác chờ xử lý.`);
    if (L.shiftStart(d, S.months) <= Date.now()) throw new Error(`Ca ${L.fmtDate(d)} đã tới giờ bắt đầu, không đổi được.`);
    if (S.months[L.monthOf(d)]?.status === 'locked') throw new Error(`Tháng của ca ${L.fmtDate(d)} đã khóa.`);
  }
  for (const l of data.legs) if (l.from && holderOf(l.date) !== l.from) throw new Error(`Ca ${L.fmtDate(l.date)} không còn do BS ${dname(l.from)} giữ.`);
  const exp = dates.length ? Math.min(...dates.map(d => L.shiftStart(d, S.months))) : Date.now() + 7 * 86400e3;
  const ref = doc(collection(db, 'transactions'));
  await runTransaction(db, async tr => {
    const ls = await Promise.all(dates.map(d => tr.get(doc(db, 'locks', d))));
    if (ls.some(s => s.exists())) throw new Error('Có ca vừa được người khác tạo yêu cầu, vui lòng thử lại.');
    tr.set(ref, {
      ...data, status: 'pending', accepted: [], createdBy: myEmail(), creatorDoctor: myDoc(),
      createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(exp),
    });
    dates.forEach(d => tr.set(doc(db, 'locks', d), { tx: ref.id, by: myEmail(), at: serverTimestamp() }));
  });
  return ref.id;
}

// Người nhận đồng ý / từ chối
async function respond(id, accept, quiet = false) {
  const ref = doc(db, 'transactions', id);
  const me = myDoc();
  let res;
  await runTransaction(db, async tr => {
    const s = await tr.get(ref);
    const t = s.data();
    if (!s.exists() || t.status !== 'pending') throw new Error('Yêu cầu không còn hiệu lực (đã có người nhận, đã hủy hoặc hết hạn).');
    if (L.tsMs(t.expiresAt) <= Date.now()) throw new Error('Đã tới giờ bắt đầu ca, yêu cầu hết hạn.');
    const upd = { respondedAt: serverTimestamp() };
    if (!accept) { upd.status = 'rejected'; upd.rejectedBy = me; }
    else {
      upd.accepted = [...(t.accepted || []), me];
      if (t.openToAll) { upd.buyer = me; upd.status = 'confirmed'; }
      else upd.status = upd.accepted.length >= t.invitees.length ? 'confirmed' : 'pending';
      if (upd.status === 'confirmed') upd.confirmedAt = serverTimestamp();
    }
    tr.update(ref, upd);
    if (upd.status !== 'pending') t.legs.forEach(l => tr.delete(doc(db, 'locks', l.date)));
    res = { id, ...t, ...upd };
  });
  if (res.status === 'confirmed') mail(participants(res), 'Đổi/bán trực đã được xác nhận', ['Giao dịch đã có hiệu lực:', ...legLines(res)]);
  else if (res.status === 'rejected' && !quiet) mail(participants(res), 'Yêu cầu đổi/bán trực bị từ chối', [`BS ${dname(me)} đã từ chối:`, ...legLines(res)]);
  return res.status;
}

// Người tạo (hoặc admin) hủy yêu cầu đang chờ
async function cancelTx(id) {
  const ref = doc(db, 'transactions', id);
  let t;
  await runTransaction(db, async tr => {
    const s = await tr.get(ref);
    t = s.data();
    if (!s.exists() || t.status !== 'pending') throw new Error('Yêu cầu không còn ở trạng thái chờ.');
    tr.update(ref, { status: 'cancelled', closedAt: serverTimestamp() });
    t.legs.forEach(l => tr.delete(doc(db, 'locks', l.date)));
  });
  mail(participants(t), 'Yêu cầu đổi/bán trực đã bị hủy', ['Yêu cầu sau đã được hủy:', ...legLines(t)]);
}

// Admin: tạo giao dịch confirmed ngay (điều chỉnh / đảo ngược)
async function adminTx(data) {
  for (const l of data.legs) {
    if (S.months[L.monthOf(l.date)]?.status === 'locked') throw new Error(`Tháng của ca ${L.fmtDate(l.date)} đã khóa.`);
    if (pendMap()[l.date]) throw new Error(`Ca ${L.fmtDate(l.date)} đang có yêu cầu chờ – hủy yêu cầu đó trước.`);
  }
  const ref = doc(collection(db, 'transactions'));
  const b = writeBatch(db);
  b.set(ref, {
    invitees: [], accepted: [], openToAll: false, ...data, status: 'confirmed',
    createdBy: myEmail(), creatorDoctor: myDoc(), createdAt: serverTimestamp(), confirmedAt: serverTimestamp(),
  });
  if (data.refId) b.update(doc(db, 'transactions', data.refId), { reversed: true, reversedBy: ref.id });
  await b.commit();
}

// ===================== HÀNH ĐỘNG (bấm nút) =====================
const ACT = {
  login: async () => {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    try { await signInWithPopup(auth, p); } catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') await signInWithRedirect(auth, p);
      else if (e.code !== 'auth/popup-closed-by-user') throw e;
    }
  },
  logout: () => signOut(auth),
  tab: d => { S.tab = d.t; window.scrollTo(0, 0); },
  mprev: () => { S.month = L.addMonth(S.month, -1); },
  mnext: () => { S.month = L.addMonth(S.month, 1); },
  view: d => { S.view = d.v; },
  closeModal: () => closeModal(),
  cell: d => openCell(d.date),
  png: () => exportPng(),
  ics: () => exportIcs(),
  icsOne: d => { if (holderOf(d.date) !== myDoc()) throw new Error('Ca này không phải của bạn.'); exportIcs(d.date); },
  backup: () => exportBackup(),

  accept: async d => {
    const t = S.txs.find(x => x.id === d.id);
    if (!confirm(`Đồng ý?\n${legLines(t).join('\n')}`)) return;
    const st = await respond(d.id, true);
    toast(st === 'confirmed' ? 'Đã xác nhận – lịch đã cập nhật.' : 'Đã đồng ý, chờ người còn lại.');
  },
  reject: async d => { if (!confirm('Từ chối yêu cầu này?')) return; await respond(d.id, false); toast('Đã từ chối.'); },
  cancel: async d => { if (!confirm('Hủy yêu cầu này?')) return; await cancelTx(d.id); toast('Đã hủy yêu cầu.'); },

  doSwap2: async () => {
    const f = S.form, A = myDoc();
    if (!f.swapMine || !f.swapPeer || !f.swapPeerShift) throw new Error('Chọn đủ ca của bạn, người nhận đổi và ca của họ.');
    const legs = [{ date: f.swapMine, from: A, to: f.swapPeer }, { date: f.swapPeerShift, from: f.swapPeer, to: A }];
    if (!confirm(`Gửi yêu cầu đổi trực?\n${legLines({ legs }).join('\n')}`)) return;
    await createTx({ type: 'SWAP2', legs, invitees: [f.swapPeer], openToAll: false });
    mail([f.swapPeer], `BS ${dname(A)} đề nghị đổi trực với bạn`, ['Yêu cầu đổi trực:', ...legLines({ legs }), 'Vào web để Đồng ý / Từ chối.']);
    S.form = {}; toast('Đã gửi yêu cầu đổi trực.');
  },
  doSwap3: async () => {
    const f = S.form, A = myDoc();
    if (!f.s3Mine || !f.s3B || !f.s3BShift || !f.s3C || !f.s3CShift) throw new Error('Chọn đủ 3 người và 3 ca.');
    if (f.s3B === f.s3C) throw new Error('Người thứ 2 và thứ 3 phải khác nhau.');
    const legs = [
      { date: f.s3Mine, from: A, to: f.s3B },
      { date: f.s3BShift, from: f.s3B, to: f.s3C },
      { date: f.s3CShift, from: f.s3C, to: A },
    ];
    if (!confirm(`Gửi yêu cầu đổi vòng 3 người?\n${legLines({ legs }).join('\n')}`)) return;
    await createTx({ type: 'SWAP3', legs, invitees: [f.s3B, f.s3C], openToAll: false });
    mail([f.s3B, f.s3C], `BS ${dname(A)} đề nghị đổi trực vòng 3 người`, ['Yêu cầu đổi vòng (cần cả 2 người đồng ý):', ...legLines({ legs }), 'Vào web để Đồng ý / Từ chối.']);
    S.form = {}; toast('Đã gửi yêu cầu đổi 3 người.');
  },
  doSell: async () => {
    const f = S.form, A = myDoc();
    if (!f.sellMine) throw new Error('Chọn ca muốn bán.');
    const open = f.sellMode === 'open';
    if (!open && !f.sellBuyer) throw new Error('Chọn người mua.');
    const legs = [{ date: f.sellMine, from: A, to: open ? null : f.sellBuyer }];
    if (!confirm(`${open ? 'Đăng bán công khai' : 'Gửi yêu cầu bán'} ca ${L.fmtDate(f.sellMine)}?`)) return;
    await createTx({ type: open ? 'SELL_OPEN' : 'SELL', legs, invitees: open ? [] : [f.sellBuyer], openToAll: open });
    const to = open ? doctorList().map(d => d.id).filter(id => id !== A && holderOf(f.sellMine) !== id) : [f.sellBuyer];
    mail(to, `BS ${dname(A)} ${open ? 'cần bán' : 'muốn bán cho bạn'} ca trực ${L.fmtDate(f.sellMine)}`,
      [open ? 'Ca trực đang bán công khai – ai nhận trước sẽ được:' : 'Đề nghị bán ca trực cho bạn:', `${L.fmtDate(f.sellMine)} (${L.hoursOf(f.sellMine, S.months)}h)`, 'Vào web để nhận ca.']);
    S.form = {}; toast(open ? 'Đã đăng bán công khai.' : 'Đã gửi yêu cầu bán.');
  },
  s3toggle: () => { S.form.s3open = !S.form.s3open; },

  // ----- Trực thay / nợ tua -----
  doCover: async () => {
    const f = S.form, A = myDoc();
    if (!f.covMine || !f.covPeer) throw new Error('Chọn ca của bạn và người trực thay.');
    const legs = [{ date: f.covMine, from: A, to: f.covPeer }];
    if (!confirm(`Nhờ BS ${dname(f.covPeer)} trực thay ${L.fmtDate(f.covMine)}?\nBạn sẽ nợ lại 1 ca ${L.isCnLe(f.covMine, S.months) ? 'CN/lễ' : 'thường'}.`)) return;
    await createTx({ type: 'COVER', legs, invitees: [f.covPeer], openToAll: false });
    mail([f.covPeer], `BS ${dname(A)} nhờ bạn trực thay ${L.fmtDate(f.covMine)} (trả sau)`, ['Yêu cầu trực thay, người nhờ sẽ nợ lại 1 ca:', ...legLines({ legs }), 'Vào web để Đồng ý / Từ chối.']);
    S.form = {}; toast('Đã gửi yêu cầu trực thay.');
  },
  repayPick: d => { S.form.repay = d.id; S.form.repayShift = ''; S.form.toSell = null; },
  doRepay: async () => {
    const f = S.form, me = myDoc();
    const debt = L.debts(S.txs, S.months).find(x => x.id === f.repay);
    if (!debt || debt.status !== 'open') throw new Error('Khoản nợ không còn mở.');
    if (debt.pendingTx) throw new Error('Khoản nợ này đang có yêu cầu chờ xử lý.');
    if (!f.repayShift) throw new Error('Chọn ca để trả nợ.');
    const other = me === debt.debtor ? debt.creditor : debt.debtor;
    const legs = [{ date: f.repayShift, from: debt.creditor, to: debt.debtor }];
    const kindOk = L.isCnLe(f.repayShift, S.months) === debt.cnle;
    if (!confirm(`${me === debt.debtor ? 'Trả nợ' : 'Nhờ trả nợ'}: BS ${dname(debt.debtor)} trực ${L.fmtDate(f.repayShift)} thay BS ${dname(debt.creditor)}?` + (kindOk ? '' : '\nLưu ý: loại ca (thường / CN-lễ) khác với ca đã nợ.'))) return;
    await createTx({ type: 'REPAY', legs, invitees: [other], openToAll: false, refId: debt.id });
    mail([other], `Trả nợ trực thay – ca ${L.fmtDate(f.repayShift)}`, legLines({ type: 'REPAY', legs, refId: debt.id }).concat('Vào web để Đồng ý / Từ chối.'));
    S.form = {}; toast('Đã gửi yêu cầu trả nợ.');
  },
  toSell: async d => {
    const me = myDoc();
    const debt = L.debts(S.txs, S.months).find(x => x.id === d.id);
    if (!debt || debt.status !== 'open') throw new Error('Khoản nợ không còn mở.');
    if (debt.pendingTx) throw new Error('Khoản nợ này đang có yêu cầu chờ xử lý.');
    const other = me === debt.debtor ? debt.creditor : debt.debtor;
    if (!confirm(`Chuyển khoản nợ ca ${L.fmtDate(debt.date)} thành BÁN TUA (BS ${dname(debt.debtor)} bán cho BS ${dname(debt.creditor)})?\nCần BS ${dname(other)} đồng ý. Tiền hai bên tự thỏa thuận.`)) return;
    await createTx({ type: 'DEBT_TO_SELL', legs: [], invitees: [other], openToAll: false, refId: debt.id });
    mail([other], 'Đề nghị chuyển nợ trực thay thành bán tua', [`BS ${dname(me)} đề nghị: ca ${L.fmtDate(debt.date)} tính là ${dname(debt.debtor)} bán cho ${dname(debt.creditor)}, không trả ca nữa.`, 'Vào web để Đồng ý / Từ chối.']);
    toast('Đã gửi đề nghị chuyển thành bán.');
  },

  // ----- Admin -----
  goadjust: d => { closeModal(); S.tab = 'admin'; S.adj = { date: d.date }; setTimeout(() => $('#adj')?.scrollIntoView(), 50); },
  doAdjust: async () => {
    const { date, to, reason } = S.adj;
    if (!date || !to) throw new Error('Chọn ngày và người trực thực tế.');
    if (!reason?.trim()) throw new Error('Nhập lý do.');
    const from = holderOf(date);
    if (from === to) throw new Error('Người này đang trực ngày đó rồi.');
    if (!confirm(`Admin chỉnh ${L.fmtDate(date)}: ${dname(from)} → ${dname(to)}?`)) return;
    await adminTx({ type: 'ADMIN_ADJUST', legs: [{ date, from, to }], reason: reason.trim() });
    mail([from, to], `Admin điều chỉnh ca trực ${L.fmtDate(date)}`, [`${L.fmtDate(date)}: ${dname(from)} → ${dname(to)}`, `Lý do: ${reason}`]);
    S.adj = {}; toast('Đã điều chỉnh.');
  },
  reverse: async d => {
    const t = S.txs.find(x => x.id === d.id);
    const legs = t.legs.map(l => ({ date: l.date, from: L.legTo(t, l), to: l.from }));
    const lech = legs.filter(l => holderOf(l.date) !== l.from);
    let msg = `Đảo ngược giao dịch này?\n${legLines({ legs }).join('\n')}`;
    if (lech.length) msg += `\n\nCẢNH BÁO: các ca ${lech.map(l => L.fmtDate(l.date)).join(', ')} đã thay đổi tiếp sau giao dịch này.`;
    const reason = prompt(msg + '\n\nNhập lý do:');
    if (!reason) return;
    await adminTx({ type: 'REVERSAL', legs, refId: t.id, reason });
    mail(participants(t), 'Admin đã đảo ngược 1 giao dịch đổi/bán trực', [...legLines({ legs }), `Lý do: ${reason}`]);
    closeModal(); toast('Đã đảo ngược.');
  },
  lockMonth: async d => {
    const lock = d.v === 'lock';
    if (!confirm(lock ? `Khóa tháng ${d.m}? Sau khi khóa không ai thay đổi được.` : `Mở khóa tháng ${d.m}?`)) return;
    const b = writeBatch(db);
    b.update(doc(db, 'months', d.m), { status: lock ? 'locked' : 'published', lockedAt: serverTimestamp(), lockedBy: myEmail() });
    logAct(b, 'month', `${lock ? 'Khóa' : 'Mở khóa'} tháng ${d.m}`);
    await b.commit();
    toast(lock ? 'Đã khóa tháng.' : 'Đã mở khóa.');
  },

  // Lịch gốc
  edOpen: () => {
    const m = S.ed?.month || S.month;
    const mon = S.months[m];
    // Tháng mới: tự chọn sẵn BS trực ngày 1 nối tiếp tua gốc tháng trước
    const auto = !mon ? nextFromPrev(m)?.id || '' : '';
    S.ed = { month: m, rows: { ...(mon?.shifts || {}) }, holidays: [...(mon?.holidays || [])], lt: '', start: S.ed?.start || auto, source: mon?.source || 'rotation', open: true, errs: [] };
  },
  edCont: () => {
    const nx = nextFromPrev(S.ed.month);
    if (!nx) throw new Error('Chưa có lịch gốc tháng trước (hoặc BS trong đó đều đã ngừng).');
    S.ed.start = nx.id;
    ACT.edRot();
    toast(`Nối tiếp tua gốc: ngày 1 = BS ${dname(nx.id)} (sau BS ${dname(nx.prev)} ngày ${nx.day}).`);
  },
  edRot: () => {
    const order = doctorList().map(d => d.id);
    if (!order.length) throw new Error('Chưa có bác sĩ.');
    if (!S.ed.start) throw new Error('Chọn BS trực ngày 1.');
    S.ed.rows = L.rotation(S.ed.month, order, S.ed.start);
    S.ed.source = 'rotation'; S.ed.errs = [];
  },
  edLT: () => {
    const p = L.parseLT(S.ed.lt, Object.values(S.doctors));
    S.ed.errs = [...p.errors, ...p.warnings.map(w => '(lưu ý) ' + w)];
    if (p.errors.length) { toast('Mã LT có lỗi – xem danh sách bên dưới.', false); return; }
    S.ed.month = p.month; S.ed.rows = p.rows; S.ed.holidays = p.holidays; S.ed.source = 'LT';
    toast('Đọc mã LT thành công. Kiểm tra rồi bấm Lưu.');
  },
  edSave: async () => {
    const e = S.ed, m = e.month, n = L.daysIn(m), old = S.months[m];
    if (old?.status === 'locked') throw new Error('Tháng đã khóa.');
    for (let d = 1; d <= n; d++) if (!e.rows[L.pad(d)]) throw new Error(`Ngày ${L.pad(d)} chưa có người trực.`);
    let reason = '';
    if (old) {
      const sch = sched(m);
      const changed = Object.keys(e.rows).filter(dd => e.rows[dd] !== old.shifts?.[dd]);
      const warn = changed.filter(dd => sch?.hist[dd]?.length);
      reason = prompt(`Lịch gốc tháng ${m} đã có. Đổi ${changed.length} ô.` +
        (warn.length ? `\nCẢNH BÁO: ngày ${warn.join(', ')} đã có giao dịch đổi/bán.` : '') + '\nNhập lý do sửa:');
      if (!reason) return;
    }
    const b = writeBatch(db);
    if (old) { const { id, ...rest } = old; b.set(doc(db, 'months', m, 'versions', String(old.version || 1)), { ...rest, archivedAt: serverTimestamp() }); }
    b.set(doc(db, 'months', m), {
      shifts: e.rows, holidays: [...new Set(e.holidays)].sort(), status: 'published', source: e.source,
      lt: e.source === 'LT' ? e.lt : '', version: (old?.version || 0) + 1,
      updatedAt: serverTimestamp(), updatedBy: myEmail(), reason,
    });
    logAct(b, 'month', `${old ? 'Sửa' : 'Tạo'} lịch gốc tháng ${m} (${e.source === 'LT' ? 'mã LT' : 'vòng xoay'}, ngày lễ: ${e.holidays.join(' ') || 'không'})${reason ? ' – ' + reason : ''}`);
    await b.commit();
    S.month = m; S.ed = null; toast(`Đã lưu lịch gốc tháng ${m}.`);
  },
  edClose: () => { S.ed = null; },

  // Bác sĩ
  docNew: () => {
    // Màu mặc định khác nhau cho từng BS
    const pal = ['#1565c0', '#2e7d32', '#6a1b9a', '#ef6c00', '#00838f', '#ad1457', '#5d4037', '#283593', '#558b2f', '#c62828'];
    const used = new Set(Object.values(S.doctors).map(d => d.color));
    S.editDoc = { id: null, name: '', email: '', color: pal.find(c => !used.has(c)) || pal[0], admin: false };
  },
  docEdit: d => {
    const x = S.doctors[d.id];
    S.editDoc = { id: x.id, name: x.name, email: x.email || '', color: x.color || '#1565c0', admin: S.members[x.email]?.role === 'admin' };
  },
  docCancel: () => { S.editDoc = null; },
  docSave: async () => {
    const e = S.editDoc;
    const name = (e.name || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    const email = (e.email || '').trim().toLowerCase();
    if (!name) throw new Error('Nhập tên BS.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Gmail không hợp lệ.');
    for (const d of Object.values(S.doctors)) {
      if (d.id === e.id) continue;
      if (L.norm(d.name) === L.norm(name)) throw new Error(`Tên "${name}" đã có. Thêm chữ phân biệt (vd "${name} A").`);
      if ((d.email || '').toLowerCase() === email) throw new Error('Gmail này đã gắn với BS khác.');
    }
    const self = email === myEmail();
    const role = e.admin || self || (!e.id && S.members[email]?.role === 'admin') ? 'admin' : 'doctor';
    const b = writeBatch(db);
    if (!e.id) {
      const ref = doc(collection(db, 'doctors'));
      const order = Math.max(0, ...Object.values(S.doctors).map(d => d.order || 0)) + 1;
      b.set(ref, { name, email, color: e.color, order, active: true, createdAt: serverTimestamp() });
      b.set(doc(db, 'members', email), { email, role, doctorId: ref.id, active: true });
      logAct(b, 'doctor', `Thêm BS ${name} (${email}${role === 'admin' ? ', admin' : ''})`);
      if (!self) mailTo([email], 'Bạn được mời vào web Lịch trực', [`Admin đã thêm bạn (BS ${name}) vào nhóm trực.`, 'Đăng nhập bằng chính Gmail này để xem lịch và đổi/bán trực.']);
    } else {
      const old = S.doctors[e.id];
      if (old.email && old.email !== email) {
        if (old.email === myEmail()) throw new Error('Không đổi Gmail của chính bạn tại đây.');
        b.delete(doc(db, 'members', old.email));
      }
      b.update(doc(db, 'doctors', e.id), { name, email, color: e.color });
      b.set(doc(db, 'members', email), { email, role, doctorId: e.id, active: old.active !== false });
      logAct(b, 'doctor', `Sửa BS ${old.name}${old.name !== name ? ' → ' + name : ''}${old.email !== email ? `, Gmail ${old.email} → ${email}` : ''}, quyền ${role}`);
    }
    await b.commit();
    S.editDoc = null; toast('Đã lưu bác sĩ.');
  },
  docMove: async d => {
    const list = doctorList(false);
    const i = list.findIndex(x => x.id === d.id), j = i + (+d.dir);
    if (j < 0 || j >= list.length) return;
    const b = writeBatch(db);
    b.update(doc(db, 'doctors', list[i].id), { order: list[j].order ?? j });
    b.update(doc(db, 'doctors', list[j].id), { order: list[i].order ?? i });
    logAct(b, 'doctor', `Đổi thứ tự vòng xoay: ${list[i].name} ${+d.dir < 0 ? 'lên' : 'xuống'}`);
    await b.commit();
  },
  docToggle: async d => {
    const x = S.doctors[d.id];
    const toActive = x.active === false;
    if (!toActive) {
      if (x.email === myEmail()) throw new Error('Không thể tự ngừng hoạt động tài khoản của bạn.');
      const busy = futureShifts(x.id);
      if (busy.length) throw new Error(`BS ${x.name} còn giữ ca: ${busy.map(L.fmtDate).join(', ')}. Chuyển các ca này trước (Admin điều chỉnh).`);
      if (S.txs.some(t => t.status === 'pending' && participants(t).includes(x.id))) throw new Error('BS này đang có yêu cầu chờ – hủy trước.');
      if (!confirm(`Ngừng hoạt động BS ${x.name}? Lịch sử vẫn giữ nguyên.`)) return;
    }
    const b = writeBatch(db);
    b.update(doc(db, 'doctors', x.id), { active: toActive });
    if (x.email && S.members[x.email]) b.update(doc(db, 'members', x.email), { active: toActive });
    logAct(b, 'doctor', `${toActive ? 'Kích hoạt lại' : 'Ngừng hoạt động'} BS ${x.name}`);
    await b.commit();
    toast(toActive ? 'Đã kích hoạt lại.' : 'Đã ngừng hoạt động.');
  },
  docDel: async d => {
    const x = S.doctors[d.id];
    if (x.email === myEmail()) throw new Error('Không thể xóa chính bạn.');
    const used = Object.values(S.months).some(m => Object.values(m.shifts || {}).includes(x.id)) ||
      S.txs.some(t => participants(t).includes(x.id));
    if (used) throw new Error('BS đã có ca trong lịch sử → không xóa hẳn được. Dùng "Ngừng".');
    if (!confirm(`Xóa hẳn BS ${x.name}?`)) return;
    const b = writeBatch(db);
    b.delete(doc(db, 'doctors', x.id));
    if (x.email) b.delete(doc(db, 'members', x.email));
    logAct(b, 'doctor', `Xóa hẳn BS ${x.name} (${x.email || ''})`);
    await b.commit();
    toast('Đã xóa.');
  },
};

// ----- Khởi tạo lần đầu & tài khoản không phải BS -----
ACT.setup = async () => {
  if (!confirm(`Khởi tạo hệ thống với ${myEmail()} là admin đầu tiên?`)) return;
  const b = writeBatch(db);
  b.set(doc(db, 'members', myEmail()), { email: myEmail(), role: 'admin', doctorId: '', active: true });
  b.set(doc(db, 'meta', 'setup'), { by: myEmail(), at: serverTimestamp() });
  await b.commit();
  toast('Đã khởi tạo. Vào tab Admin để thêm bác sĩ.');
};
ACT.memAdd = async () => {
  const email = (S.newMem.email || '').trim().toLowerCase(), role = S.newMem.role || 'viewer';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Gmail không hợp lệ.');
  if (S.members[email]) throw new Error('Gmail này đã có tài khoản.');
  const b = writeBatch(db);
  b.set(doc(db, 'members', email), { email, role, doctorId: '', active: true });
  logAct(b, 'member', `Thêm tài khoản ${email} (${role === 'admin' ? 'admin' : 'chỉ xem'})`);
  await b.commit();
  mailTo([email], 'Bạn được cấp quyền xem web Lịch trực', ['Admin đã thêm Gmail này vào web Lịch trực.', 'Đăng nhập bằng chính Gmail này để xem lịch.']);
  S.newMem = { email: '', role: 'viewer' }; toast('Đã thêm tài khoản.');
};
ACT.memToggle = async d => {
  const m = S.members[d.e];
  if (d.e === myEmail()) throw new Error('Không tự khóa tài khoản của bạn.');
  const b = writeBatch(db);
  b.update(doc(db, 'members', d.e), { active: !m.active });
  logAct(b, 'member', `${m.active ? 'Khóa' : 'Mở'} tài khoản ${d.e}`);
  await b.commit();
};
ACT.memRole = async d => {
  const m = S.members[d.e];
  if (d.e === myEmail()) throw new Error('Không tự đổi quyền của bạn.');
  const role = m.role === 'admin' ? 'viewer' : 'admin';
  const b = writeBatch(db);
  b.update(doc(db, 'members', d.e), { role });
  logAct(b, 'member', `Đổi quyền ${d.e} → ${role === 'admin' ? 'admin' : 'chỉ xem'}`);
  await b.commit();
};
ACT.memDel = async d => {
  if (d.e === myEmail()) throw new Error('Không tự xóa tài khoản của bạn.');
  if (!confirm(`Xóa tài khoản ${d.e}?`)) return;
  const b = writeBatch(db);
  b.delete(doc(db, 'members', d.e));
  logAct(b, 'member', `Xóa tài khoản ${d.e}`);
  await b.commit();
};
ACT.tkMode = d => { S.tkMode = d.v; };

// Tìm BS trực ngày 1 của tháng m để nối tiếp vòng xoay theo LỊCH GỐC tháng trước:
// lấy người trực gốc ngày cuối tháng trước (bỏ qua BS đã ngừng), rồi lấy người kế tiếp theo thứ tự ▲▼
function nextFromPrev(m) {
  const pm = S.months[L.addMonth(m, -1)];
  if (!pm) return null;
  const order = doctorList().map(d => d.id);
  if (!order.length) return null;
  const days = Object.keys(pm.shifts || {}).sort().reverse();
  for (const dd of days) {
    const id = pm.shifts[dd], i = order.indexOf(id);
    if (i >= 0) return { id: order[(i + 1) % order.length], prev: id, day: `${dd}/${L.addMonth(m, -1).slice(5)}` };
  }
  return null;
}

// Ca từ hôm nay trở đi mà BS đang giữ (tháng chưa khóa)
function futureShifts(id) {
  const today = L.vnToday(), out = [];
  for (const m of Object.keys(S.months)) {
    if (S.months[m].status === 'locked') continue;
    const sch = sched(m);
    for (const [dd, h] of Object.entries(sch.holder)) if (h === id && `${m}-${dd}` >= today) out.push(`${m}-${dd}`);
  }
  return out.sort();
}

// ===================== SỰ KIỆN =====================
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) { if (e.target.id === 'modal') closeModal(); return; }
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (S.busy) return;
  document.activeElement?.blur?.(); // iPhone: bấm nút không tự rời ô nhập
  S.busy = true; document.body.classList.add('busy');
  try { await fn(el.dataset, el); } catch (err) { console.error(err); toast(errMsg(err), false); }
  finally { S.busy = false; document.body.classList.remove('busy'); render(); }
});

// Thay đổi ô nhập: data-f (form BS), data-ed (trình sửa lịch), data-edrow / data-edle, data-adj, data-dd (sửa BS)
const DEPS = { swapPeer: ['swapPeerShift'], sellMode: ['sellBuyer'], s3B: ['s3BShift'], s3C: ['s3CShift'], covPeer: [] };
function onField(e, doRender) {
  const t = e.target, ds = t.dataset;
  const val = t.type === 'checkbox' ? t.checked : t.value;
  if (ds.f) { S.form[ds.f] = val; (DEPS[ds.f] || []).forEach(k => delete S.form[k]); }
  else if (ds.ed) {
    S.ed[ds.ed] = val;
    if (ds.ed === 'month' && doRender) { const mon = S.months[val]; S.ed.rows = { ...(mon?.shifts || {}) }; S.ed.holidays = [...(mon?.holidays || [])]; }
  }
  else if (ds.edrow) S.ed.rows[ds.edrow] = val;
  else if (ds.edle) {
    const h = new Set(S.ed.holidays);
    t.checked ? h.add(ds.edle) : h.delete(ds.edle);
    S.ed.holidays = [...h].sort();
  }
  else if (ds.adj) { S.adj[ds.adj] = val; if (ds.adj === 'date') delete S.adj.to; }
  else if (ds.dd) S.editDoc[ds.dd] = val;
  else if (ds.nm) S.newMem[ds.nm] = val;
  else if (ds.lf !== undefined) S.logFilter = val;
  else return;
  if (doRender) render();
}
// Ô chữ: chỉ lưu giá trị, KHÔNG vẽ lại (tránh mất ô đang gõ khi chuyển ô); select/checkbox: vẽ lại
const TEXT = 'input[type=text],input[type=email],textarea';
document.addEventListener('change', e => onField(e, !e.target.matches(TEXT)));
document.addEventListener('input', e => { if (e.target.matches(TEXT)) onField(e, false); });
document.addEventListener('focusout', () => { if (S.dirty) { S.dirty = false; setTimeout(render, 0); } });

// ===================== GIAO DIỆN =====================
function render() {
  // Đang gõ chữ thì hoãn vẽ lại để không mất con trỏ
  const a = document.activeElement;
  if (a && a.matches?.('input[type=text],input[type=email],textarea')) { S.dirty = true; return; }
  S._sch = {};
  const root = $('#app');
  if (!S.authReady || (S.user && S.member === undefined)) { root.innerHTML = '<div class="center">Đang tải…</div>'; return; }
  if (!S.user) {
    root.innerHTML = `<div class="center login"><div class="logo">${ICON.lich}</div><h1>${esc(APP_TITLE)}</h1>
      <p>Lịch luôn cập nhật · Đổi &amp; bán trực · Thống kê</p>
      <button class="btn big" data-act="login"><svg viewBox="0 0 24 24" class="g"><path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"/><path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z"/><path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z"/></svg>Đăng nhập bằng Google</button>
      <small>Chỉ Gmail đã được admin thêm mới vào được.</small></div>`;
    return;
  }
  if (!S.member && S.setupDone === undefined) { root.innerHTML = '<div class="center">Đang kiểm tra…</div>'; return; }
  if (!S.member && S.setupDone === false) {
    root.innerHTML = `<div class="center"><h2>Thiết lập lần đầu</h2><p>Hệ thống chưa có admin.<br>Tài khoản <b>${esc(S.user.email)}</b> sẽ là admin đầu tiên.</p>
      <button class="btn big" data-act="setup">Khởi tạo – tôi là admin</button><button class="link" data-act="logout">Đăng xuất</button></div>`;
    return;
  }
  if (!S.member || !S.member.active) {
    root.innerHTML = `<div class="center"><h2>Chưa có quyền truy cập</h2><p>Tài khoản <b>${esc(S.user.email)}</b> chưa được mời hoặc đã ngừng hoạt động.<br>Liên hệ admin.</p>
      <button class="btn" data-act="logout">Đăng xuất</button></div>`;
    return;
  }
  const inbox = inboxItems().length;
  const tabs = [['lich', 'Lịch', inbox], ['doi', 'Đổi/Bán', 0], ['tk', 'Thống kê', 0]];
  if (isAdmin()) tabs.push(['admin', 'Admin', 0]);
  const body = { lich: viewLich, doi: viewDoi, tk: viewTk, admin: viewAdmin }[S.tab] || viewLich;
  root.innerHTML = `
    <header><div><b>${esc(APP_TITLE)}</b><small>${esc(myDoc() ? 'BS ' + dname(myDoc()) : S.user.email)}${isAdmin() ? ' · admin' : S.member.role === 'viewer' ? ' · chỉ xem' : ''}</small></div>
      <button class="link" data-act="logout">Thoát</button></header>
    <main>${body()}</main>
    <nav>${tabs.map(([k, t, n]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${ICON[k]}<span>${t}</span>${n ? `<i>${n}</i>` : ''}</button>`).join('')}</nav>`;
}

const ICON = {
  lich: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  doi: '<svg viewBox="0 0 24 24"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>',
  tk: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  admin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

function monthNav() {
  const m = S.month;
  return `<div class="mnav"><button data-act="mprev">‹</button><b>Tháng ${m.slice(5)}/${m.slice(0, 4)}</b><button data-act="mnext">›</button></div>`;
}

function inboxItems() {
  const me = myDoc(), now = Date.now();
  if (!me) return [];
  return S.txs.filter(t => t.status === 'pending' && L.tsMs(t.expiresAt) > now && t.creatorDoctor !== me &&
    ((t.invitees || []).includes(me) && !(t.accepted || []).includes(me)
      || (t.openToAll && !(t.legs || []).some(l => holderOf(l.date) === me))));
}

// Khung "Đổi ngày khác": người nhận chọn 1 ca khác của mình để đề nghị lại
function counterBox(t) {
  const me = myDoc(), A = t.creatorDoctor;
  const aLeg = t.legs.find(l => l.from === A);          // ca của người gửi (giữ nguyên)
  const mineAsked = t.legs.find(l => l.from === me);    // ca của tôi mà họ muốn lấy
  const opts = L.eligibleShifts(me, S.months, S.txs).filter(d => d !== mineAsked?.date && d !== aLeg?.date)
    .map(d => [d, `${L.fmtDate(d)}${L.isCnLe(d, S.months) ? ' (24h)' : ''}`]);
  return `<div class="form"><b>Đề nghị BS ${esc(dname(A))} lấy ca khác của bạn</b>
    <p class="muted">Bạn vẫn nhận ca ${L.fmtDate(aLeg.date)} của BS ${esc(dname(A))}, nhưng đưa lại ngày khác thay cho ${L.fmtDate(mineAsked.date)}. Yêu cầu cũ sẽ được từ chối, BS ${esc(dname(A))} nhận đề nghị mới để Đồng ý / Từ chối.</p>
    ${opts.length ? `<label>Ca khác của tôi (${esc(dname(me))})${select('data-f', 'ctrShift', opts, S.form.ctrShift)}</label>
    <div class="row"><button class="btn" data-act="ctrSend" data-id="${t.id}">Gửi đề nghị</button><button class="btn ghost" data-act="ctrClose">Đóng</button></div>`
    : '<p class="muted">Bạn không còn ca nào khác có thể đổi.</p><button class="btn ghost" data-act="ctrClose">Đóng</button>'}</div>`;
}
ACT.ctrOpen = d => { S.form.ctr = d.id; S.form.ctrShift = ''; };
ACT.ctrClose = () => { S.form.ctr = null; };
ACT.ctrSend = async d => {
  const t = S.txs.find(x => x.id === d.id), me = myDoc();
  if (!t || t.status !== 'pending') throw new Error('Yêu cầu không còn hiệu lực.');
  const A = t.creatorDoctor, aLeg = t.legs.find(l => l.from === A), newDate = S.form.ctrShift;
  if (!newDate) throw new Error('Chọn ca khác của bạn.');
  if (holderOf(aLeg.date) !== A) throw new Error(`Ca ${L.fmtDate(aLeg.date)} không còn do BS ${dname(A)} giữ.`);
  const legs = [{ date: newDate, from: me, to: A }, { date: aLeg.date, from: A, to: me }];
  if (!confirm(`Từ chối yêu cầu cũ và đề nghị lại:\n${legLines({ legs }).join('\n')}`)) return;
  await respond(t.id, false, true);                // từ chối yêu cầu cũ (nhả khóa ca), không gửi mail từ chối
  t.status = 'rejected'; S._sch = {};               // cập nhật ngay trên máy, không chờ đồng bộ
  await createTx({ type: 'SWAP2', legs, invitees: [A], openToAll: false, counterOf: t.id });
  mail([A], `BS ${dname(me)} đề nghị đổi ngày khác`, [`BS ${dname(me)} chưa đổi được ngày bạn chọn, đề nghị lại:`, ...legLines({ legs }), 'Vào web để Đồng ý / Từ chối.']);
  S.form = {}; toast('Đã gửi đề nghị đổi ngày khác.');
};

function viewLich() {
  let h = '';
  const inbox = inboxItems();
  if (inbox.length) {
    h += `<section class="card inbox"><h3>Yêu cầu chờ bạn trả lời (${inbox.length})</h3>${inbox.map(t => `
      <div class="req">${describe(t)}<small>Hết hạn: ${fmtTime(t.expiresAt)}</small>
        <div class="row">${t.openToAll
          ? `<button class="btn ok" data-act="accept" data-id="${t.id}">Nhận ca</button>`
          : `<button class="btn ok" data-act="accept" data-id="${t.id}">Đồng ý</button><button class="btn no" data-act="reject" data-id="${t.id}">Từ chối</button>${t.type === 'SWAP2' ? `<button class="btn ghost" data-act="ctrOpen" data-id="${t.id}">Đổi ngày khác</button>` : ''}`}</div>
        ${S.form.ctr === t.id ? counterBox(t) : ''}
      </div>`).join('')}</section>`;
  }
  const mon = S.months[S.month];
  h += `<section class="card">${monthNav()}`;
  if (!mon) return h + '<p class="muted">Chưa có lịch tháng này.</p></section>';
  h += `<div class="seg"><button class="${S.view === 'current' ? 'on' : ''}" data-act="view" data-v="current">Lịch hiện hành</button>
    <button class="${S.view === 'goc' ? 'on' : ''}" data-act="view" data-v="goc">Lịch gốc</button></div>`;
  if (mon.status === 'locked') h += '<p class="badge">🔒 Tháng đã khóa</p>';
  h += calendarHtml(S.month);
  h += `<div class="legend"><span class="lg cnle">CN/Lễ 24h</span><span class="lg pending">Đang chờ</span><span class="lg sale">Đang bán</span><span class="lg changed">Đã thay đổi</span><span class="lg mine">Ca của tôi</span></div>
    <div class="row"><button class="btn" data-act="png">Xuất ảnh ${S.view === 'goc' ? 'lịch gốc' : 'lịch hiện hành'}</button>
    ${myDoc() ? '<button class="btn ghost" data-act="ics">Ca của tôi → lịch điện thoại</button>' : ''}</div></section>`;
  return h;
}

function calendarHtml(m) {
  const sch = sched(m), pend = pendMap(), n = L.daysIn(m), off = (L.dow(`${m}-01`) + 6) % 7;
  const goc = S.view === 'goc';
  let h = '<div class="cal">' + ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(x => `<div class="hd">${x}</div>`).join('');
  for (let i = 0; i < off; i++) h += '<div class="cell empty"></div>';
  for (let d = 1; d <= n; d++) {
    const dd = L.pad(d), date = `${m}-${dd}`;
    const id = goc ? sch.base[dd] : sch.holder[dd];
    const cls = [];
    const tags = []; // nhiều nhãn xếp dọc: chờ/bán (ưu tiên) → Lễ → adm
    if (L.isCnLe(date, S.months)) cls.push('cnle');
    if (!goc) {
      const p = pend[date];
      const hs = sch.hist[dd] || [];
      if (hs.length) cls.push('changed');
      if (p) { cls.push(p.type.startsWith('SELL') ? 'sale' : 'pending'); tags.push(`<em class="st">${p.type.startsWith('SELL') ? 'bán' : 'chờ'}</em>`); }
    }
    if ((S.months[m].holidays || []).includes(dd)) tags.push('<em>Lễ</em>');
    if (!goc && !pend[date] && (sch.hist[dd] || []).at(-1)?.tx.type === 'ADMIN_ADJUST') tags.push('<em>adm</em>');
    if (id && id === myDoc()) cls.push('mine');
    h += `<div class="cell ${cls.join(' ')}" data-act="cell" data-date="${date}" style="--dc:${esc(dcolor(id))}"><span class="dd">${d}</span>
      <span class="nm">${esc(dname(id))}</span><span class="tags">${tags.join('')}</span></div>`;
  }
  return h + '</div>';
}

function openCell(date) {
  const m = L.monthOf(date), dd = date.slice(8), sch = sched(m);
  if (!sch) return;
  const hist = sch.hist[dd] || [], p = pendMap()[date];
  let h = `<h3>${L.fmtDate(date)}/${m.slice(0, 4)}</h3>
    <p class="muted">${L.isCnLe(date, S.months) ? 'Chủ nhật/Lễ – 24h (7h → 7h hôm sau)' : 'Ngày thường – 16h → 7h hôm sau'}</p>
    <p>Lịch gốc: <b>${esc(dname(sch.base[dd]))}</b><br>Hiện hành: <b>${esc(dname(sch.holder[dd]))}</b></p>`;
  if (hist.length) {
    h += '<h4>Chuỗi thay đổi</h4><ol class="hist">' + hist.map(x => `<li>${TYPE[x.tx.type]}: ${esc(dname(x.from))} → <b>${esc(dname(x.to))}</b>
      <small>${fmtTime(x.tx.confirmedAt)}${x.tx.reason ? ' · ' + esc(x.tx.reason) : ''}${x.tx.reversed ? ' · đã đảo ngược' : ''}</small>
      ${isAdmin() && !x.tx.reversed && x.tx.type !== 'REVERSAL' && S.months[m].status !== 'locked' ? `<button class="mini" data-act="reverse" data-id="${x.tx.id}">Đảo ngược</button>` : ''}</li>`).join('') + '</ol>';
  }
  const dd0 = L.debts(S.txs, S.months).find(x => x.date === date);
  if (dd0) h += `<p class="muted">Ca này là trực thay: BS ${esc(dname(dd0.debtor))} ${dd0.status === 'open' ? 'đang nợ' : dd0.status === 'repaid' ? 'đã trả nợ' : 'đã chuyển thành bán cho'} BS ${esc(dname(dd0.creditor))}.</p>`;
  if (p) h += `<div class="warn">Đang chờ: ${describe(p)}</div>`;
  if (myDoc() && sch.holder[dd] === myDoc()) h += `<button class="btn ghost" data-act="icsOne" data-date="${date}">Thêm ca này vào lịch điện thoại</button>`;
  if (isAdmin() && S.months[m].status !== 'locked') h += `<button class="btn" data-act="goadjust" data-date="${date}">Admin điều chỉnh ca này</button>`;
  modal(h);
}

function viewDoi() {
  const me = myDoc();
  if (!me) return `<section class="card"><p>${S.member.role === 'viewer' ? 'Tài khoản chỉ xem – không tham gia đổi/bán trực.' : 'Tài khoản của bạn chưa gắn với bác sĩ nào. Nếu bạn cũng trực, vào Admin → Thêm bác sĩ với Gmail của bạn.'}</p></section>`;
  const f = S.form;
  const el = id => L.eligibleShifts(id, S.months, S.txs).map(d => [d, `${L.fmtDate(d)}${L.isCnLe(d, S.months) ? ' (24h)' : ''}`]);
  const mine = el(me);
  const peers = doctorList().filter(d => d.id !== me).map(d => [d.id, d.name]);
  const noShift = mine.length ? '' : '<p class="muted">Bạn không có ca nào có thể đổi/bán (ca phải chưa tới giờ bắt đầu, không đang chờ, tháng chưa khóa).</p>';
  const MY = `Ca của tôi (${esc(dname(me))})`;
  let h = `<section class="card"><h3>Đổi trực (2 người)</h3>${noShift}
    <label>${MY}${select('data-f', 'swapMine', mine, f.swapMine)}</label>
    <label>Đổi với BS${select('data-f', 'swapPeer', peers, f.swapPeer)}</label>
    <label>Lấy ca của BS đó${select('data-f', 'swapPeerShift', f.swapPeer ? el(f.swapPeer) : [], f.swapPeerShift)}</label>
    <button class="btn" data-act="doSwap2">Gửi yêu cầu đổi</button></section>`;

  h += `<section class="card"><h3>Bán trực</h3>
    <label>${MY} – ca muốn bán${select('data-f', 'sellMine', mine, f.sellMine)}</label>
    <label>Cách bán<select data-f="sellMode">${opt('direct', 'Bán đích danh', f.sellMode || 'direct')}${opt('open', 'Bán công khai (ai nhận trước được)', f.sellMode)}</select></label>
    ${f.sellMode === 'open' ? '' : `<label>Người mua${select('data-f', 'sellBuyer', peers, f.sellBuyer)}</label>`}
    <button class="btn" data-act="doSell">${f.sellMode === 'open' ? 'Đăng bán công khai' : 'Gửi yêu cầu bán'}</button></section>`;

  h += `<section class="card"><button class="link fold" data-act="s3toggle">${f.s3open ? '▾' : '▸'} Đổi vòng 3 người (ít dùng)</button>`;
  if (f.s3open) {
    const peersC = peers.filter(([id]) => id !== f.s3B);
    h += `<p class="muted">Bạn (A) → ca của A cho B; ca của B cho C; ca của C cho A. Cần cả B và C đồng ý.</p>
      <label>${MY} (A)${select('data-f', 's3Mine', mine, f.s3Mine)}</label>
      <label>Người B${select('data-f', 's3B', peers, f.s3B)}</label>
      <label>Ca của B${select('data-f', 's3BShift', f.s3B ? el(f.s3B) : [], f.s3BShift)}</label>
      <label>Người C${select('data-f', 's3C', peersC, f.s3C)}</label>
      <label>Ca của C${select('data-f', 's3CShift', f.s3C ? el(f.s3C) : [], f.s3CShift)}</label>`;
    if (f.s3Mine && f.s3B && f.s3BShift && f.s3C && f.s3CShift) {
      h += `<div class="warn">Sau khi đổi:<br>• BS ${esc(dname(f.s3B))} trực ${L.fmtDate(f.s3Mine)}<br>• BS ${esc(dname(f.s3C))} trực ${L.fmtDate(f.s3BShift)}<br>• Bạn trực ${L.fmtDate(f.s3CShift)}</div>`;
    }
    h += '<button class="btn" data-act="doSwap3">Gửi yêu cầu đổi 3 người</button>';
  }
  h += '</section>';

  // --- Trực thay trả sau + nợ tua ---
  h += `<section class="card"><h3>Nhờ trực thay (trả sau)</h3><p class="muted">Người kia trực giúp ca này, bạn nợ lại 1 ca. Trả nợ hoặc chuyển thành bán ở khung "Nợ tua" bên dưới.</p>
    <label>${MY}${select('data-f', 'covMine', mine, f.covMine)}</label>
    <label>Người trực thay${select('data-f', 'covPeer', peers, f.covPeer)}</label>
    <button class="btn" data-act="doCover">Gửi yêu cầu trực thay</button></section>`;
  const myDebts = L.debts(S.txs, S.months).filter(x => x.status === 'open' && (x.debtor === me || x.creditor === me));
  h += `<section class="card"><h3>Nợ tua của tôi</h3>`;
  if (!myDebts.length) h += '<p class="muted">Không có khoản nợ nào.</p>';
  for (const x of myDebts) {
    const iOwe = x.debtor === me;
    h += `<div class="req"><b>${iOwe ? `Bạn nợ BS ${esc(dname(x.creditor))}` : `BS ${esc(dname(x.debtor))} nợ bạn`}</b> 1 ca ${x.cnle ? 'CN/lễ (24h)' : 'thường'}
      <small>Từ ca ${L.fmtDate(x.date)}/${x.date.slice(0, 4)} – ${fmtTime(x.cover.confirmedAt)}</small>`;
    if (x.pendingTx) h += `<small>Đang chờ: ${TYPE[x.pendingTx.type]}</small>`;
    else if (f.repay === x.id) {
      const credShifts = el(x.creditor);
      h += `<label>${iOwe ? `Chọn ca của BS ${esc(dname(x.creditor))} mà bạn sẽ trực thay` : `Chọn ca của bạn để BS ${esc(dname(x.debtor))} trực trả`}${select('data-f', 'repayShift', credShifts, f.repayShift)}</label>
        <div class="row"><button class="btn" data-act="doRepay">${iOwe ? 'Gửi yêu cầu trả nợ' : 'Gửi yêu cầu nhờ trả'}</button><button class="btn ghost" data-act="repayPick" data-id="">Đóng</button></div>`;
    } else h += `<div class="row"><button class="btn ghost" data-act="repayPick" data-id="${x.id}">${iOwe ? 'Trả nợ' : 'Nhờ trả nợ'}</button><button class="btn ghost" data-act="toSell" data-id="${x.id}">Chuyển thành bán tua</button></div>`;
    h += '</div>';
  }
  h += '</section>';

  const sent = S.txs.filter(t => t.status === 'pending' && t.createdBy === myEmail()).sort((a, b) => L.tsMs(b.createdAt) - L.tsMs(a.createdAt));
  h += `<section class="card"><h3>Yêu cầu tôi đã gửi</h3>${sent.length ? sent.map(t => `<div class="req">${describe(t)}
    <small>Đã đồng ý: ${(t.accepted || []).map(dname).join(', ') || 'chưa ai'} · Hết hạn: ${fmtTime(t.expiresAt)}</small>
    <div class="row"><button class="btn no" data-act="cancel" data-id="${t.id}">Hủy yêu cầu</button></div></div>`).join('') : '<p class="muted">Không có yêu cầu đang chờ.</p>'}</section>`;
  return h;
}

function viewTk() {
  const seg = `<div class="seg"><button class="${S.tkMode === 'thang' ? 'on' : ''}" data-act="tkMode" data-v="thang">Theo tháng</button>
    <button class="${S.tkMode === 'nam' ? 'on' : ''}" data-act="tkMode" data-v="nam">Theo năm</button></div>`;
  return S.tkMode === 'nam' ? viewTkNam(seg) : viewTkThang(seg);
}
const statRow = (id, s) => `<tr class="${id === myDoc() ? 'me' : ''}"><td>${esc(dname(id))}</td><td>${s.thuong + s.cnle}</td><td>${s.thuong}</td><td>${s.cnle}</td><td>${s.gio}</td><td>${s.goc}</td><td>${s.doiDi}/${s.doiDen}</td><td>${s.ban}/${s.mua}</td><td>${s.thay}/${s.nho}</td><td>${s.adj}</td></tr>`;
const statHead = '<thead><tr><th>BS</th><th>Tổng ca</th><th>Thường</th><th>CN/Lễ</th><th>Giờ</th><th>Ca gốc</th><th>Đổi đi/đến</th><th>Bán/Mua</th><th>Thay/Nhờ</th><th>Admin chỉnh</th></tr></thead>';

function viewTkThang(seg) {
  const m = S.month;
  let h = `<section class="card">${seg}${monthNav()}`;
  const st = L.monthStats(m, S.months, S.txs, doctorList().map(d => d.id));
  if (!st) return h + '<p class="muted">Chưa có lịch tháng này.</p></section>';
  const rows = doctorList(false).map(d => d.id).filter(id => st[id]);
  h += `<div class="scroll"><table>${statHead}<tbody>${rows.map(id => statRow(id, st[id])).join('')}</tbody></table></div></section>`;
  const open = L.debts(S.txs, S.months).filter(x => x.status === 'open');
  h += `<section class="card"><h3>Nợ tua đang mở (cả nhóm)</h3>${open.length ? open.map(x => `<div class="req">BS <b>${esc(dname(x.debtor))}</b> nợ BS <b>${esc(dname(x.creditor))}</b> 1 ca ${x.cnle ? 'CN/lễ' : 'thường'}<small>từ ca ${L.fmtDate(x.date)}/${x.date.slice(0, 4)}</small></div>`).join('') : '<p class="muted">Không có.</p>'}</section>`;
  const txs = S.txs.filter(t => (t.legs || []).some(l => L.monthOf(l.date) === m) || (t.type === 'DEBT_TO_SELL' && L.monthOf(coverById(t.refId)?.legs?.[0]?.date || '') === m)).sort((a, b) => L.tsMs(b.createdAt) - L.tsMs(a.createdAt));
  h += `<section class="card"><h3>Giao dịch tháng ${m.slice(5)}/${m.slice(0, 4)}</h3>${txs.length ? txs.map(t => `<div class="req">${describe(t)}
    <small>${STATUS[t.status] || t.status}${t.reversed ? ' · đã đảo ngược' : ''} · ${fmtTime(t.createdAt)}${t.reason ? ' · ' + esc(t.reason) : ''}</small></div>`).join('') : '<p class="muted">Chưa có.</p>'}</section>`;
  return h;
}

function viewTkNam(seg) {
  const y = S.month.slice(0, 4);
  const ms = Object.keys(S.months).filter(m => m.startsWith(y + '-')).sort();
  let h = `<section class="card">${seg}<div class="mnav"><button data-act="yprev">‹</button><b>Năm ${y}</b><button data-act="ynext">›</button></div>`;
  if (!ms.length) return h + '<p class="muted">Chưa có lịch tháng nào trong năm.</p></section>';
  const tot = {}, per = {};
  for (const m of ms) {
    const st = L.monthStats(m, S.months, S.txs, []);
    for (const [id, s] of Object.entries(st)) {
      const t = (tot[id] ||= { thuong: 0, cnle: 0, gio: 0, goc: 0, doiDi: 0, doiDen: 0, ban: 0, mua: 0, adj: 0, thay: 0, nho: 0 });
      for (const k in t) t[k] += s[k];
      (per[id] ||= {})[m] = s.thuong + s.cnle;
    }
  }
  const ids = doctorList(false).map(d => d.id).filter(id => tot[id]);
  h += `<p class="muted">Tổng hợp ${ms.length} tháng có lịch (gồm cả BS đã ngừng).</p>
    <div class="scroll"><table>${statHead}<tbody>${ids.map(id => statRow(id, tot[id])).join('')}</tbody></table></div></section>`;
  h += `<section class="card"><h3>Số ca theo từng tháng</h3><div class="scroll"><table><thead><tr><th>BS</th>${ms.map(m => `<th>T${+m.slice(5)}</th>`).join('')}<th>Cả năm</th></tr></thead><tbody>
    ${ids.map(id => `<tr class="${id === myDoc() ? 'me' : ''}"><td>${esc(dname(id))}</td>${ms.map(m => `<td>${per[id][m] ?? 0}</td>`).join('')}<td><b>${tot[id].thuong + tot[id].cnle}</b></td></tr>`).join('')}
    </tbody></table></div></section>`;
  return h;
}
ACT.yprev = () => { S.month = L.addMonth(S.month, -12); };
ACT.ynext = () => { S.month = L.addMonth(S.month, 12); };

function viewAdmin() {
  if (!isAdmin()) return '';
  let h = '';
  // --- Bác sĩ ---
  const e = S.editDoc;
  h += `<section class="card"><h3>Bác sĩ & quyền truy cập</h3><div class="docs">${doctorList(false).map((d, i, arr) => `
    <div class="docrow ${d.active === false ? 'off' : ''}"><span class="dot" style="background:${esc(d.color)}"></span>
      <div class="grow"><b>${esc(d.name)}</b>${d.active === false ? ' <small>(ngừng)</small>' : ''}${S.members[d.email]?.role === 'admin' ? ' <small>admin</small>' : ''}<br><small>${esc(d.email || '')}</small></div>
      <button class="mini" data-act="docMove" data-id="${d.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="mini" data-act="docMove" data-id="${d.id}" data-dir="1" ${i === arr.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="mini" data-act="docEdit" data-id="${d.id}">Sửa</button>
      <button class="mini" data-act="docToggle" data-id="${d.id}">${d.active === false ? 'Kích hoạt' : 'Ngừng'}</button>
      <button class="mini no" data-act="docDel" data-id="${d.id}">Xóa</button></div>`).join('')}</div>
    <p class="muted">Thứ tự ▲▼ = thứ tự vòng xoay.</p>`;
  if (e) {
    h += `<div class="form"><h4>${e.id ? 'Sửa' : 'Thêm'} bác sĩ</h4>
      <label>Tên (có dấu)<input type="text" data-dd="name" value="${esc(e.name)}" placeholder="vd Thành"></label>
      <label>Gmail<input type="email" data-dd="email" value="${esc(e.email)}" placeholder="ten@gmail.com"></label>
      <label class="inline">Màu <input type="color" data-dd="color" value="${esc(e.color)}"></label>
      <label class="inline"><input type="checkbox" data-dd="admin" ${e.admin ? 'checked' : ''}> Quyền admin</label>
      <div class="row"><button class="btn" data-act="docSave">Lưu</button><button class="btn ghost" data-act="docCancel">Hủy</button></div></div>`;
  } else h += '<button class="btn" data-act="docNew">+ Thêm bác sĩ</button>';
  h += '</section>';

  // --- Tài khoản không phải BS ---
  const others = Object.values(S.members).filter(m => !m.doctorId).sort((x, y) => x.email.localeCompare(y.email));
  h += `<section class="card"><h3>Tài khoản khác (không trực)</h3><p class="muted">Vd trưởng khoa, điều dưỡng hành chính: chỉ xem lịch, xuất ảnh, xem thống kê; hoặc cấp quyền admin.</p>
    ${others.map(m => `<div class="docrow ${m.active ? '' : 'off'}"><div class="grow">${esc(m.email)}<br><small>${m.role === 'admin' ? 'admin' : 'chỉ xem'}${m.active ? '' : ' · đã khóa'}${m.email === myEmail() ? ' · bạn' : ''}</small></div>
      ${m.email === myEmail() ? '' : `<button class="mini" data-act="memRole" data-e="${esc(m.email)}">${m.role === 'admin' ? 'Bỏ admin' : 'Cấp admin'}</button>
      <button class="mini" data-act="memToggle" data-e="${esc(m.email)}">${m.active ? 'Khóa' : 'Mở'}</button>
      <button class="mini no" data-act="memDel" data-e="${esc(m.email)}">Xóa</button>`}</div>`).join('') || '<p class="muted">Chưa có.</p>'}
    <div class="form"><label>Gmail<input type="email" data-nm="email" value="${esc(S.newMem.email)}" placeholder="ten@gmail.com"></label>
      <label>Quyền<select data-nm="role">${opt('viewer', 'Chỉ xem', S.newMem.role)}${opt('admin', 'Admin', S.newMem.role)}</select></label>
      <button class="btn" data-act="memAdd">+ Thêm tài khoản</button></div></section>`;

  // --- Lịch gốc ---
  h += '<section class="card"><h3>Lịch gốc theo tháng</h3>';
  if (!S.ed?.open) {
    h += `<label>Tháng<input type="month" data-ed-init value="${S.month}" id="edm"></label>
      <button class="btn" data-act="edOpenM">Mở / tạo lịch tháng</button>`;
  } else {
    const ed = S.ed, m = ed.month, n = L.daysIn(m), mon = S.months[m];
    const docs = doctorList().map(d => [d.id, d.name]);
    h += `<p><b>Tháng ${m.slice(5)}/${m.slice(0, 4)}</b> ${mon ? `<small>(đã có – phiên bản ${mon.version || 1}${mon.status === 'locked' ? ', ĐÃ KHÓA' : ''})</small>` : '<small>(mới)</small>'}</p>
      <div class="sub"><b>Cách 1 – Vòng xoay</b><label>BS trực ngày 1${select('data-ed', 'start', docs, ed.start)}</label>
        <div class="row"><button class="btn ghost" data-act="edRot">Sinh lịch theo vòng xoay</button>
        ${S.months[L.addMonth(m, -1)] ? '<button class="btn ghost" data-act="edCont">Nối tiếp tua gốc tháng trước</button>' : ''}</div>
        ${S.months[L.addMonth(m, -1)] && nextFromPrev(m) ? `<p class="muted">Gợi ý nối tiếp: ngày 1 = BS ${esc(dname(nextFromPrev(m).id))} (sau BS ${esc(dname(nextFromPrev(m).prev))} trực gốc ngày ${nextFromPrev(m).day}).</p>` : ''}</div>
      <div class="sub"><b>Cách 2 – Dán mã LT</b><textarea data-ed="lt" rows="5" placeholder="#LT v1&#10;THANG 2026-12&#10;...">${esc(ed.lt)}</textarea>
        <button class="btn ghost" data-act="edLT">Đọc mã LT</button></div>
      ${ed.errs?.length ? `<div class="warn">${ed.errs.map(esc).join('<br>')}</div>` : ''}
      <p class="muted">Kiểm tra từng ngày, tích “Lễ” cho ngày lễ trực 24h:</p><div class="edlist">`;
    const cnt = {};
    for (let d = 1; d <= n; d++) {
      const dd = L.pad(d), date = `${m}-${dd}`, isLe = ed.holidays.includes(dd), cn = L.dow(date) === 0;
      if (ed.rows[dd]) cnt[ed.rows[dd]] = (cnt[ed.rows[dd]] || 0) + 1;
      h += `<div class="edrow ${cn || isLe ? 'cnle' : ''}"><span>${dd} ${L.THU[L.dow(date)]}</span>${select('data-edrow', dd, docs, ed.rows[dd], '—')}
        <label class="inline"><input type="checkbox" data-edle="${dd}" ${isLe ? 'checked' : ''}> Lễ</label></div>`;
    }
    h += `</div><p class="muted">Tổng: ${Object.entries(cnt).map(([id, c]) => `${esc(dname(id))} ${c}`).join(' · ') || '—'}</p>
      <div class="row"><button class="btn" data-act="edSave" ${mon?.status === 'locked' ? 'disabled' : ''}>Lưu lịch gốc</button><button class="btn ghost" data-act="edClose">Đóng</button></div>`;
  }
  h += '</section>';

  // --- Điều chỉnh ca ---
  const a = S.adj;
  const dates = [];
  for (const m of Object.keys(S.months).sort()) {
    if (S.months[m].status === 'locked') continue;
    const sch = sched(m);
    for (const dd of Object.keys(sch.holder).sort()) dates.push([`${m}-${dd}`, `${L.fmtDate(`${m}-${dd}`)}/${m.slice(0, 4)} – ${dname(sch.holder[dd])}`]);
  }
  const cur = a.date ? holderOf(a.date) : null;
  h += `<section class="card" id="adj"><h3>Admin điều chỉnh ca</h3><p class="muted">Dùng khi BS đã đổi miệng mà quên nhập. Hiệu lực ngay, có ghi vết.</p>
    <label>Ngày${select('data-adj', 'date', dates, a.date)}</label>
    ${a.date ? `<p>Đang trực: <b>${esc(dname(cur))}</b></p><label>Người trực thực tế${select('data-adj', 'to', doctorList().filter(d => d.id !== cur).map(d => [d.id, d.name]), a.to)}</label>
    <label>Lý do<input type="text" data-adj="reason" value="${esc(a.reason || '')}" placeholder="vd đã đổi miệng ngày 10/11"></label>
    <button class="btn" data-act="doAdjust">Điều chỉnh</button>` : ''}</section>`;

  // --- Khóa tháng ---
  h += `<section class="card"><h3>Khóa tháng</h3>${Object.keys(S.months).sort().reverse().map(m => {
    const lk = S.months[m].status === 'locked';
    return `<div class="docrow"><div class="grow">Tháng ${m.slice(5)}/${m.slice(0, 4)} ${lk ? '🔒' : ''}</div>
      <button class="mini ${lk ? '' : 'no'}" data-act="lockMonth" data-m="${m}" data-v="${lk ? 'unlock' : 'lock'}">${lk ? 'Mở khóa' : 'Khóa'}</button></div>`;
  }).join('') || '<p class="muted">Chưa có tháng nào.</p>'}</section>`;

  // --- Nhật ký admin ---
  const logs = S.logs.filter(l => !S.logFilter || l.kind === S.logFilter);
  h += `<section class="card"><h3>Nhật ký thao tác admin</h3>
    <label>Lọc<select data-lf="1">${opt('', 'Tất cả', S.logFilter)}${Object.entries(LOGTYPE).map(([k, t]) => opt(k, t, S.logFilter)).join('')}</select></label>
    <div class="loglist">${logs.slice(0, 100).map(l => `<div class="req"><b>${LOGTYPE[l.kind] || l.kind}</b>: ${esc(l.text)}<small>${fmtTime(l.at)} · ${esc(l.by)}</small></div>`).join('') || '<p class="muted">Chưa có.</p>'}</div>
    <p class="muted">Đổi/bán/điều chỉnh ca xem ở tab Thống kê → Giao dịch, hoặc bấm vào ô lịch.</p></section>`;

  // --- Sao lưu ---
  h += `<section class="card"><h3>Sao lưu dữ liệu</h3><p class="muted">Tải toàn bộ bác sĩ, lịch gốc, giao dịch ra 1 file JSON. Nên làm mỗi tháng sau khi khóa tháng.</p>
    <button class="btn ghost" data-act="backup">Tải file sao lưu</button></section>`;

  // --- Yêu cầu đang chờ (toàn nhóm) ---
  const pend = S.txs.filter(t => t.status === 'pending');
  h += `<section class="card"><h3>Yêu cầu đang chờ (cả nhóm)</h3>${pend.length ? pend.map(t => `<div class="req">${describe(t)}
    <div class="row"><button class="btn no" data-act="cancel" data-id="${t.id}">Hủy</button></div></div>`).join('') : '<p class="muted">Không có.</p>'}</section>`;
  return h;
}
ACT.edOpenM = () => { const v = $('#edm')?.value; if (!v) throw new Error('Chọn tháng.'); S.ed = { month: v }; ACT.edOpen(); };

// ===================== XUẤT .ICS (ca của tôi trong tháng đang xem) =====================
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportIcs(only) {
  // Xuất ca của tôi trong tháng đang xem + tháng sau (nếu đã có lịch); mỗi ca = 1 sự kiện CẢ NGÀY đúng ngày trực
  // only = 'YYYY-MM-DD' → chỉ xuất đúng 1 ca đó (nút trong chi tiết ô lịch)
  const me = myDoc();
  if (!me) return;
  const today = L.vnToday(), list = [];
  if (only) list.push(only);
  else for (const m of [S.month, L.addMonth(S.month, 1)]) {
    if (!S.months[m]) continue;
    const sch = sched(m);
    for (const dd of Object.keys(sch.holder).sort()) if (sch.holder[dd] === me) list.push(`${m}-${dd}`);
  }
  if (!list.length) { toast('Bạn không có ca nào trong tháng này và tháng sau.', false); return; }
  const ymd = d => d.replace(/-/g, '');
  const next = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ev = list.map(date => {
    const cnle = L.isCnLe(date, S.months);
    return ['BEGIN:VEVENT', `UID:lichtruc-${date}-${me}@hmpxl`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(next(date))}`,
      `SUMMARY:${cnle ? 'Trực 24h' : 'Trực đêm'} HM`, 'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'TRIGGER:-PT4H', 'ACTION:DISPLAY', 'DESCRIPTION:Mai trực', 'END:VALARM', 'END:VEVENT'].join('\r\n');
  });
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LichTruc//VI', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n') + '\r\n';
  const name = `ca-truc-${today}.ics`;
  const file = new File([ics], name, { type: 'text/calendar' });
  // Điện thoại: mở khung chia sẻ để chọn thẳng app Lịch; máy tính: tải file
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: 'Ca trực của tôi' }).catch(() => downloadBlob(file, name));
  } else downloadBlob(file, name);
  toast(only ? `Ca ${L.fmtDate(only)} – chọn app Lịch để thêm.` : `${list.length} ca (tháng này + tháng sau) – chọn app Lịch để thêm.`);
}
function exportBackup() {
  const data = { exportedAt: new Date().toISOString(), by: myEmail(), doctors: S.doctors, members: S.members, months: S.months, transactions: S.txs };
  downloadBlob(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `lichtruc-backup-${L.vnToday()}.json`);
  toast('Đã tải file sao lưu.');
}

// ===================== XUẤT ẢNH PNG (vẽ bằng canvas, không cần thư viện) =====================
async function exportPng() {
  const m = S.month, sch = sched(m), goc = S.view === 'goc';
  if (!sch) return;
  const n = L.daysIn(m), off = (L.dow(`${m}-01`) + 6) % 7, rows = Math.ceil((off + n) / 7);
  const W = 1080, P = 30, cw = (W - 2 * P) / 7, ch = 130, top = 160;
  const H = top + 50 + rows * ch + 100;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const F = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.fillStyle = '#0f3d5e'; g.font = `bold 46px ${F}`;
  g.fillText(`LỊCH TRỰC THÁNG ${m.slice(5)}/${m.slice(0, 4)}`, W / 2, 70);
  g.fillStyle = '#555'; g.font = `26px ${F}`;
  g.fillText(`${APP_TITLE} · ${goc ? 'Lịch gốc' : 'Lịch hiện hành'} · xuất ${new Date().toLocaleString('vi-VN', { hour12: false })}`, W / 2, 115);
  ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].forEach((x, i) => {
    g.fillStyle = i === 6 ? '#c62828' : '#0f3d5e'; g.font = `bold 28px ${F}`;
    g.fillText(x, P + i * cw + cw / 2, top + 32);
  });
  for (let d = 1; d <= n; d++) {
    const dd = L.pad(d), date = `${m}-${dd}`, k = off + d - 1;
    const x = P + (k % 7) * cw, y = top + 50 + Math.floor(k / 7) * ch;
    const id = goc ? sch.base[dd] : sch.holder[dd];
    const cnle = L.isCnLe(date, S.months), le = (S.months[m].holidays || []).includes(dd);
    g.fillStyle = cnle ? '#fdecea' : '#fff'; g.fillRect(x, y, cw, ch);
    g.strokeStyle = '#bbb'; g.lineWidth = 2; g.strokeRect(x, y, cw, ch);
    g.textAlign = 'left'; g.fillStyle = cnle ? '#c62828' : '#333'; g.font = `bold 26px ${F}`;
    g.fillText(String(d), x + 10, y + 32);
    if (le) { g.font = `bold 20px ${F}`; g.fillText('Lễ', x + 50, y + 30); }
    if (!goc && (sch.hist[dd] || []).length) { g.fillStyle = '#ef6c00'; g.beginPath(); g.arc(x + cw - 16, y + 18, 8, 0, 7); g.fill(); }
    g.textAlign = 'center'; g.fillStyle = dcolor(id);
    let fs = 32; g.font = `bold ${fs}px ${F}`;
    const name = dname(id);
    while (g.measureText(name).width > cw - 12 && fs > 16) { fs -= 2; g.font = `bold ${fs}px ${F}`; }
    g.fillText(name, x + cw / 2, y + 88);
  }
  g.textAlign = 'left'; g.fillStyle = '#555'; g.font = `22px ${F}`;
  g.fillText('Nền hồng: CN/Lễ trực 24h (7h→7h) · Ngày thường 16h→7h', P, H - 52);
  if (!goc) g.fillText('Chấm cam: ca đã thay đổi so với lịch gốc', P, H - 22);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], `lich-truc-${m}${goc ? '-goc' : ''}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: `Lịch trực ${m}` }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

render();
