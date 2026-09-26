renderNav("/");

const specNames = {};

async function loadSpecs() {
  const specs = await api("/api/specs");
  const sel = document.getElementById("f-spec");
  sel.innerHTML = Object.entries(specs)
    .map(([k, v]) => `<option value="${k}">${v.name}（${v.mm_w}×${v.mm_h}mm）</option>`)
    .join("");
  Object.entries(specs).forEach(([k, v]) => (specNames[k] = v.name));
}

async function loadDevices() {
  const [cams, prts] = await Promise.all([
    api("/api/devices?kind=camera"),
    api("/api/devices?kind=printer"),
  ]);
  document.getElementById("f-device").innerHTML = cams
    .map((d) => `<option value="${d.id}">${d.name}（${d.id}）</option>`)
    .join("");
  const rows = [...cams, ...prts].map((d) => {
    const occupy = d.locked_by ? `被 ${d.locked_by} 锁定` : "空闲";
    const paper = d.kind === "printer" ? `${d.paper} 张` : "—";
    const isCam = d.kind === "camera";
    return `<tr>
      <td>${d.name}<div class="muted mono">${d.id}</div></td>
      <td>${isCam ? "拍摄" : "冲印"}</td>
      <td>${badge(d.status)}</td>
      <td>${paper}<div class="muted">${occupy}</div></td>
      <td>
        ${isCam
          ? `<button class="ghost" onclick="toggleCamera('${d.id}','${d.status}')">${d.status === "offline" ? "恢复在线" : "模拟离线"}</button>`
          : `<button class="ghost" onclick="addPaper('${d.id}')">加纸 +20</button>
             <button class="ghost" onclick="togglePaper('${d.id}','${d.status}')">${d.status === "out_of_paper" ? "恢复在线" : "模拟缺纸"}</button>`}
      </td></tr>`;
  }).join("");
  document.getElementById("dev-rows").innerHTML = rows;
}

window.toggleCamera = async (id, st) => {
  try {
    await api(`/api/devices/${id}/status`, { method: "POST", body: { status: st === "offline" ? "online" : "offline" } });
    toast("设备状态已更新", "ok");
    loadDevices();
  } catch (e) { toast(e.message, "err"); }
};
window.addPaper = async (id) => {
  await api(`/api/devices/${id}/paper`, { method: "POST", body: { n: 20 } });
  toast("已加纸 20 张", "ok");
  loadDevices();
};
window.togglePaper = async (id, st) => {
  await api(`/api/devices/${id}/status`, { method: "POST", body: { status: st === "out_of_paper" ? "online" : "out_of_paper" } });
  loadDevices();
};

async function loadOrders() {
  const orders = await api("/api/orders");
  document.getElementById("order-rows").innerHTML = orders.map((o) => {
    const code = o.pickup_code_hash ? "已签发" : "—";
    return `<tr>
      <td class="mono">#${o.id}</td>
      <td class="mono">${o.queue_no}</td>
      <td>${o.customer_name}</td>
      <td>${specNames[o.spec_key] || o.spec_key}</td>
      <td>${o.copies}</td>
      <td>${o.rounds_used}/${o.max_rounds}</td>
      <td class="mono">${yuan(o.amount)}</td>
      <td>${badge(o.status)}</td>
      <td>${o.pickup_active ? '<span class="badge ok">有效</span>' : code}</td>
      <td>
        ${o.status === "queued" ? `<a class="btn" href="/screen/capture?order=${o.id}">去拍摄</a>` : ""}
        ${["selected", "retouching", "printing"].includes(o.status) ? `<a class="btn ghost" href="/screen/select?order=${o.id}">查看</a>` : ""}
        ${["printing", "completed", "picked"].includes(o.status) ? `<a class="btn ghost" href="/screen/print?order=${o.id}">冲印</a>` : ""}
      </td></tr>`;
  }).join("");
}

document.getElementById("btn-call").onclick = async () => {
  try {
    const o = await api("/api/call", {
      method: "POST",
      body: {
        customer_name: document.getElementById("f-name").value || "顾客",
        spec_key: document.getElementById("f-spec").value,
        device_id: document.getElementById("f-device").value,
        copies: parseInt(document.getElementById("f-copies").value || "1", 10),
        retouch_required: document.getElementById("f-retouch").checked,
      },
    });
    toast(`叫号成功：${o.queue_no}，设备已锁定`, "ok");
    loadDevices();
    loadOrders();
  } catch (e) { toast(e.message, "err"); }
};

async function init() {
  await loadSpecs();
  await loadDevices();
  await loadOrders();
  setInterval(() => { loadDevices(); loadOrders(); }, 4000);
}
init();
