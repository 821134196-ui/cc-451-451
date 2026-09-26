renderNav("/screen/retouch");

async function load() {
  const items = await api("/api/retouch/queue");
  const wrap = document.getElementById("queue");
  if (!items.length) {
    wrap.innerHTML = '<div class="card muted">修正队列为空。顾客确认了规格不符的照片或勾选“需要人工修正”时会进入这里。</div>';
    return;
  }
  wrap.innerHTML = items.map((it) => `
    <div class="card">
      <div class="row" style="align-items:flex-start">
        <img class="thumb" style="width:150px;height:200px;object-fit:contain"
             src="${it.photo.out_file ? "/outputs/" + it.photo.out_file : "/placeholders/" + it.photo.src_file}">
        <div style="flex:1">
          <h3 style="margin-top:0">${it.queue_no} · ${it.customer_name}
            ${badge("retouching")}</h3>
          <div class="muted">规格：${it.spec_key} · 候选 #${it.selected_photo_id}</div>
          <div class="field" style="margin:10px 0 0">
            <label>修正原因 / 待办</label>
            <div>${it.note || "顾客要求人工精修"}</div>
          </div>
          <div class="row" style="margin-top:12px">
            <input id="note-${it.order_id}" placeholder="修正说明（可选）" style="flex:1">
            <button onclick="submit(${it.order_id})">提交修正版，转待冲印</button>
          </div>
          <p class="muted" style="margin-bottom:0">本页不显示金额、付款状态与付款回执（权限隔离）。</p>
        </div>
      </div>
    </div>`).join("");
}

window.submit = async (orderId) => {
  const who = document.getElementById("retoucher").value || "修图员";
  const note = document.getElementById("note-" + orderId).value;
  // 记录一次“查看脱敏订单”的审计调用
  await api(`/api/retouch/orders/${orderId}?retoucher=${encodeURIComponent(who)}`);
  try {
    await api(`/api/orders/${orderId}/retouch`, {
      method: "POST", body: { retoucher: who, note },
    });
    toast("修正版已提交，进入待冲印", "ok");
    load();
  } catch (e) { toast(e.message, "err"); }
};

load();
setInterval(load, 5000);
