renderNav("/screen/capture");

let order = null;
let blinkMode = false;

async function enterOrder() {
  const q = document.getElementById("order-input").value.trim();
  if (!q) return toast("请输入排队号或订单 ID", "err");
  try {
    order = await api("/api/orders/resolve?q=" + encodeURIComponent(q));
    document.getElementById("order-input").value = order.queue_no;
    await refresh();
  } catch (e) { toast(e.message, "err"); }
}

async function refresh() {
  if (!order) return;
  order = await api("/api/orders/" + order.id);
  const cands = await api(`/api/orders/${order.id}/candidates`);
  const spec = (await api("/api/specs"))[order.spec_key];
  document.getElementById("order-info").innerHTML =
    `<b>${order.queue_no}</b> · ${order.customer_name} · ${spec.name}（${spec.mm_w}×${spec.mm_h}mm）
     · 轮次 <b>${order.rounds_used}/${order.max_rounds}</b> · ${badge(order.status)}`;
  renderCandidates(cands);
  const shooting = order.status === "queued";
  const full = order.rounds_used >= order.max_rounds;
  document.getElementById("btn-shoot").disabled = !shooting || full;
  document.getElementById("btn-select").disabled = cands.length === 0;
  document.getElementById("hint").textContent = full
    ? "已达轮次上限，请从候选中选定一张。"
    : shooting ? "可在规定轮次内重拍，所有候选均保留。" : "该订单已离开拍摄阶段。";
}

function renderCandidates(cands) {
  document.getElementById("cand").innerHTML = cands.map((p) => `
    <div class="photo-cell">
      <img src="/placeholders/${p.src_file}" alt="候选 ${p.round}">
      <div class="meta">第 ${p.round} 轮
        ${p.blink ? '<span class="badge err">眨眼</span>' : ""}
      </div>
    </div>`).join("") || '<div class="muted">暂无候选，点击下方拍摄。</div>';
}

async function shoot() {
  try {
    const r = await api(`/api/orders/${order.id}/capture`, { method: "POST", body: {} });
    if (r.hint) toast(r.hint, "err"); else toast("拍摄完成", "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "err");
    if (e.code === "device_offline") {
      document.getElementById("hint").textContent =
        "设备离线：订单仍占用该设备，设备恢复在线后可继续拍摄；也可由店员处理。";
    }
    await refresh();
  }
}

async function toggleBlink() {
  blinkMode = !blinkMode;
  await api("/api/camera/mode", { method: "POST", body: { mode: blinkMode ? "blink" : "normal" } });
  document.getElementById("btn-blink").textContent = "模拟眨眼：" + (blinkMode ? "开" : "关");
}

function goSelect() {
  location.href = "/screen/select?order=" + order.id;
}

if (qs("order")) {
  document.getElementById("order-input").value = qs("order");
  enterOrder();
}
setInterval(() => { if (order) refresh().catch(() => {}); }, 5000);
