// 公共工具
const STATUS_TEXT = {
  queued: "拍摄中", selected: "已选片", retouching: "待修正",
  printing: "待冲印", completed: "已完成", picked: "已取件", cancelled: "已取消",
  approved: "已通过", rejected: "已驳回", duplicate: "重复请求",
  pending: "待处理", done: "已完成", failed_no_paper: "缺纸", failed: "失败", cancelled: "已取消",
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json();
  if (!j.ok) {
    const e = new Error(j.error || "请求失败");
    e.code = j.code;
    throw e;
  }
  return j.data;
}

let toastTimer;
function toast(msg, kind = "") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = kind;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 3200);
}

function badge(status) {
  return `<span class="badge ${status}">${STATUS_TEXT[status] || status}</span>`;
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function photoUrl(p) {
  if (!p) return "";
  if (p.out_file) return "/outputs/" + p.out_file;
  return "/placeholders/" + p.src_file;
}

function yuan(cents) {
  return "¥" + (cents / 100).toFixed(2);
}

const NAV = [
  ["/", "开单首页"],
  ["/screen/call", "叫号屏"],
  ["/screen/capture", "拍摄终端"],
  ["/screen/select", "候选选择"],
  ["/screen/preview", "规格预览"],
  ["/screen/retouch", "修正队列"],
  ["/screen/print", "冲印任务"],
  ["/screen/pickup", "取件核验"],
  ["/screen/refund", "退款复核"],
];

function renderNav(active) {
  const links = NAV.map(([href, label]) =>
    `<a href="${href}"${href === active ? ' style="color:#fff;font-weight:600"' : ""}>${label}</a>`
  ).join("");
  const h = document.createElement("header");
  h.className = "topbar";
  h.innerHTML = `<a class="brand" href="/">证件照<span>·</span>自助门店</a>${links}`;
  document.body.prepend(h);
}
