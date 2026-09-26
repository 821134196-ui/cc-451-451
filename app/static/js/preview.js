renderNav("/screen/preview");

let order = null, pv = null, crop = null, chosenId = null;

async function enterOrder() {
  const q = document.getElementById("order-input").value.trim();
  if (!q) return toast("请输入排队号", "err");
  try {
    order = await api("/api/orders/resolve?q=" + encodeURIComponent(q));
    document.getElementById("order-input").value = order.queue_no;
    document.getElementById("back-select").href = "/screen/select?order=" + order.id;
    await load();
  } catch (e) { toast(e.message, "err"); }
}

async function load() {
  if (!order) return;
  order = await api("/api/orders/" + order.id);
  pv = await api(`/api/orders/${order.id}/preview`);
  if (!crop) crop = { ...pv.crop };
  if (!chosenId) {
    chosenId = order.selected_photo_id || (pv.candidates[0] && pv.candidates[0].photo.id);
  }
  const s = pv.spec;
  document.getElementById("info").innerHTML =
    `<b>${order.queue_no}</b> · ${s.name} · 成品尺寸 <b>${s.mm_w} × ${s.mm_h} mm</b>
     · ${s.dpi} DPI · ${badge(order.status)}`;
  document.getElementById("spec-info").innerHTML =
    `<div class="field"><label>规格</label><b>${s.name}</b></div>
     <div class="row">
       <div class="field"><label>宽度</label><b>${s.mm_w} mm</b></div>
       <div class="field"><label>高度</label><b>${s.mm_h} mm</b></div>
       <div class="field"><label>分辨率</label><b>${s.dpi} DPI</b></div>
     </div>`;
  renderStage();
  renderRows();
  document.getElementById("btn-crop-confirm").disabled = order.status !== "queued";
}

function renderStage() {
  const c = pv.crop;
  const W = 360;
  const scale = W / c.raw_w;
  const chosen = pv.candidates.find((x) => x.photo.id === chosenId);
  const src = chosen ? chosen.photo.src_file : pv.candidates[0]?.photo.src_file;
  const x = crop.x * scale, y = crop.y * scale, w = crop.w * scale, h = crop.h * scale;
  const safe = 0.06; // 安全线内缩 6%
  document.getElementById("stage-wrap").innerHTML = `
    <div class="preview-stage">
      <img class="raw" src="/placeholders/${src}">
      <div class="crop-line" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
        <div class="safe-line" style="inset:0"></div>
        <div class="safe-line-inner" style="left:${w*safe}px;top:${h*safe}px;width:${w*(1-2*safe)}px;height:${h*(1-2*safe)}px"></div>
        <span class="dim-h" style="left:0;bottom:-26px">${pv.spec.mm_w} mm</span>
        <span class="dim-v" style="top:0;left:-58px">${pv.spec.mm_h} mm</span>
      </div>
    </div>`;
  const inBounds = crop.x >= 0 && crop.y >= 0 &&
    crop.x + crop.w <= c.raw_w && crop.y + crop.h <= c.raw_h;
  document.getElementById("crop-desc").innerHTML =
    `裁切框 x=${crop.x}, y=${crop.y}, w=${crop.w}, h=${crop.h}（原始 ${c.raw_w}×${c.raw_h}）` +
    (inBounds ? "" : ' · <b style="color:var(--err)">裁切越界，确认将被拒绝</b>');
}

function renderRows() {
  document.getElementById("spec-rows").innerHTML = pv.candidates.length
    ? pv.candidates.map((c) => `
      <tr style="${chosenId === c.photo.id ? "background:var(--blue-soft)" : ""};cursor:pointer"
          onclick="pickCandidate(${c.photo.id})">
        <td>第 ${c.photo.round} 轮 #${c.photo.id} ${c.photo.blink ? '<span class="badge err">眨眼</span>' : ""}</td>
        <td class="mono">${c.metrics.head_mm} mm</td>
        <td class="mono">${c.metrics.top_mm} mm</td>
        <td>${c.ok ? '<span class="badge ok">符合</span>'
                   : `<span class="badge warn">不符</span><div class="muted">${c.issues.join("；")}</div>`}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="muted">暂无候选</td></tr>`;
}

window.pickCandidate = (id) => { chosenId = id; renderStage(); renderRows(); };
window.nudge = (axis, d) => { crop[axis] += d; renderStage(); };
window.resetCrop = () => { crop = { ...pv.crop }; renderStage(); };
window.forceOutOfBounds = () => { crop.x = -120; renderStage(); };

window.confirmWithCrop = async () => {
  if (!chosenId) return toast("请先在表格中点选一张候选", "err");
  try {
    await api(`/api/orders/${order.id}/confirm`, {
      method: "POST",
      body: { photo_id: chosenId, crop: [crop.x, crop.y, crop.w, crop.h] },
    });
    toast("已确认并生成裁切版本", "ok");
    await load();
  } catch (e) { toast(e.message, "err"); }
};

if (qs("order")) {
  document.getElementById("order-input").value = qs("order");
  enterOrder();
}
