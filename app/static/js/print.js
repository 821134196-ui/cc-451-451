renderNav("/screen/print");

async function load() {
  const [jobs, devs] = await Promise.all([api("/api/prints"), api("/api/devices?kind=printer")]);
  document.getElementById("dev-rows").innerHTML = devs.map((d) => `
    <tr>
      <td>${d.name}<div class="muted mono">${d.id}</div></td>
      <td>${badge(d.status)}</td>
      <td class="mono">${d.paper}</td>
      <td>
        <button class="ghost" onclick="jam('${d.id}', true)">卡纸</button>
        <button class="ghost" onclick="jam('${d.id}', false)">解除</button>
      </td>
    </tr>`).join("");

  document.getElementById("job-rows").innerHTML = jobs.map((j) => {
    const type = j.is_reprint ? '<span class="badge retouching">加印</span>' : "冲印";
    const parent = j.parent_job_id ? `#${j.parent_job_id}` : "—";
    const canRun = ["pending", "failed_no_paper", "failed"].includes(j.status);
    return `<tr>
      <td class="mono">#${j.id}</td>
      <td class="mono">${j.queue_no}</td>
      <td>${type}</td>
      <td class="mono">${parent}</td>
      <td>${j.copies}</td>
      <td>${j.attempts}/${3}</td>
      <td>${badge(j.status)}</td>
      <td class="muted">${j.last_error || "—"}</td>
      <td>${canRun ? `<button class="ghost" onclick="runJob(${j.id})">立即执行</button>` : "—"}</td>
    </tr>`;
  }).join("");
}

window.jam = async (id, on) => {
  await api(`/api/printers/${id}/jam`, { method: "POST", body: { on } });
  toast(on ? "已模拟卡纸" : "卡纸已解除", on ? "err" : "ok");
  load();
};
window.runJob = async (id) => {
  try {
    const r = await api("/api/prints/run", { method: "POST", body: { job_id: id } });
    toast("结果：" + r.result, r.result === "done" ? "ok" : "err");
  } catch (e) { toast(e.message, "err"); }
  load();
};
window.reprint = async () => {
  const oid = parseInt(document.getElementById("rp-order").value, 10);
  const copies = parseInt(document.getElementById("rp-copies").value || "1", 10);
  const staff = document.getElementById("rp-staff").value;
  if (!oid) return toast("请输入订单 ID", "err");
  try {
    const r = await api(reprintUrl(oid), {
      method: "POST", body: { copies, staff },
    });
    toast(`加印任务 #${r.job_id} 已创建（关联原任务 #${r.parent_job_id}）`, "ok");
    load();
  } catch (e) { toast(e.message, "err"); }
};
function reprintUrl(oid) { return `/api/orders/${oid}/reprint`; }

window.tick = async () => {
  const r = await api("/api/worker/tick", { method: "POST", body: {} });
  document.getElementById("tick-out").textContent =
    `过期码 ${r.expired} 个；重试 ${r.print_results.length} 个任务`;
  load();
};

load();
setInterval(load, 4000);
