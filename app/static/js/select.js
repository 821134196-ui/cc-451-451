renderNav("/screen/select");

let order = null;
let chosen = null;
// 每终端随机 token：两台终端同时确认时只接收首个版本
const clientToken = Math.random().toString(36).slice(2);

async function enterOrder() {
  const q = document.getElementById("order-input").value.trim();
  if (!q) return toast("请输入排队号", "err");
  try {
    order = await api("/api/orders/resolve?q=" + encodeURIComponent(q));
    document.getElementById("order-input").value = order.queue_no;
    await load();
  } catch (e) { toast(e.message, "err"); }
}

async function load() {
  if (!order) return;
  order = await api("/api/orders/" + order.id);
  const cands = await api(`/api/orders/${order.id}/candidates`);
  const spec = (await api("/api/specs"))[order.spec_key];
  const pv = await api(`/api/orders/${order.id}/preview`);
  const flags = {};
  pv.candidates.forEach((c) => { flags[c.photo.id] = c; });
  document.getElementById("info").innerHTML =
    `<b>${order.queue_no}</b> · ${spec.name} · 轮次 ${order.rounds_used}/${order.max_rounds} · ${badge(order.status)}`;
  document.getElementById("preview-link").href = "/screen/preview?order=" + order.id;

  // 已确认后的展示（第一台终端成功，其余终端刷新后只能看到已确认版本）
  const confirmed = order.status !== "queued";
  document.getElementById("grid").innerHTML = confirmed
    ? `<div class="photo-cell chosen"><img src="${photoUrl(order.selected_photo)}">
         <div class="meta">已确认版本 #${order.selected_photo_id}${order.selected_photo && order.selected_photo.spec_issue ? '<br><span class="badge warn">规格不符，转人工修正</span>' : ""}</div>
       </div>`
    : (cands.length ? cands.map((p) => {
        const f = flags[p.id];
        const flag = f ? (f.ok ? '<span class="badge ok">符合规格</span>' : '<span class="badge warn">规格不符</span>') : "";
        return `<div class="photo-cell ${chosen === p.id ? "chosen" : ""}" onclick="pick(${p.id})">
          <img src="/placeholders/${p.src_file}" alt="第 ${p.round} 轮">
          <div class="meta">第 ${p.round} 轮
            ${p.blink ? '<span class="badge err">眨眼</span>' : ""}
            ${flag}
          </div>
        </div>`;
      }).join("") : '<div class="muted">请先在拍摄终端完成至少一轮拍摄。</div>');

  renderStaffCard();
  document.getElementById("btn-confirm").disabled = confirmed || !chosen;
  if (confirmed) {
    document.getElementById("pick-hint").textContent =
      "该订单已确认。两台终端同时确认时仅首个版本生效，此处展示已生效版本。";
  }
}

function renderStaffCard() {
  const show = ["selected", "retouching", "printing"].includes(order.status);
  document.getElementById("staff-card").style.display = show ? "block" : "none";
}

window.pick = (id) => {
  chosen = id;
  load().catch((e) => toast(e.message, "err"));
};

window.confirmPick = async () => {
  if (!chosen) return;
  try {
    await api(`/api/orders/${order.id}/confirm`, {
      method: "POST",
      body: { photo_id: chosen, client_token: clientToken },
    });
    toast("确认成功：已生成裁切版本", "ok");
    chosen = null;
    await load();
  } catch (e) {
    toast(e.message, "err");
    await load();
  }
};

window.reopen = async () => {
  const reason = document.getElementById("reopen-reason").value;
  const staff = document.getElementById("staff-name").value;
  if (!reason.trim()) return toast("重开选择必须填写原因", "err");
  try {
    await api(`/api/orders/${order.id}/reopen`, {
      method: "POST", body: { staff, reason },
    });
    toast("已重开选择，请顾客重新选片", "ok");
    chosen = null;
    await load();
  } catch (e) { toast(e.message, "err"); }
};

if (qs("order")) {
  document.getElementById("order-input").value = qs("order");
  enterOrder();
}
setInterval(() => { if (order) load().catch(() => {}); }, 5000);
