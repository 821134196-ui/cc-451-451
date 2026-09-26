/* 公共前端工具：API 调用 / 角色 / 提示 / 顶栏 */
'use strict';

const ROLES = [
  ['customer', '顾客'],
  ['staff', '店员'],
  ['retoucher', '修图人员'],
  ['manager', '店长'],
];

function getRole() { return localStorage.getItem('idphoto-role') || 'staff'; }
function setRole(r) { localStorage.setItem('idphoto-role', r); }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-role': getRole() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.code = (data.error && data.error.code) || 'ERROR';
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, type = '') {
  let box = document.querySelector('.toast-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast-box';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
const ok = (m) => toast(m, 'ok');
const err = (e) => toast(typeof e === 'string' ? e : e.message || '操作失败', 'err');

/** 渲染统一顶栏。page: 当前页面名 */
function renderTopbar(page) {
  const bar = document.createElement('div');
  bar.className = 'topbar';
  bar.innerHTML = `
    <span class="brand"><span class="dot">●</span> 蓝证照相馆</span>
    <span class="page-name">${page}</span>
    <span class="spacer"></span>
    <a href="/">全部页面</a>
    <span class="role-picker">角色
      <select id="roleSel">${ROLES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>
    </span>`;
  document.body.prepend(bar);
  const sel = bar.querySelector('#roleSel');
  sel.value = getRole();
  sel.addEventListener('change', () => { setRole(sel.value); toast(`已切换角色：${ROLES.find(r => r[0] === sel.value)[1]}`); });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
function fmtYuan(cents) { return `¥${(cents / 100).toFixed(2)}`; }

const STATUS_LABEL = {
  WAITING: ['排队中', 'blue'],
  SHOOTING: ['拍摄中', 'blue'],
  SELECTING: ['选片中', 'blue'],
  RETOUCH_PENDING: ['待修正', 'warn'],
  PRINT_PENDING: ['待冲印', 'warn'],
  READY: ['已完成', 'ok'],
  PICKED_UP: ['已取件', 'ok'],
  REFUNDED: ['已退款', 'bad'],
};
function statusBadge(s) {
  const [label, color] = STATUS_LABEL[s] || [s, ''];
  return `<span class="badge ${color}">${label}</span>`;
}

function fileUrl(rel) { return rel ? `/files/${rel}` : ''; }
