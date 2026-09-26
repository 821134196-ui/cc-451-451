renderNav("/screen/refund");

async function load() {
  const rows = await api("/api/refunds");
  document.getElementById("rows").innerHTML = rows.length ? rows.map((r) => {
    const act = r.status === "pending"
      ? `<button onclick="review(${r.id}, true)">通过并退款</button>
         <button class="danger" onclick="review(${r.id}, false)">驳回</button>`
      : (r.reused ? '<span class="muted">（重复提交，返回原单）</span>' : "—");
    const cls = r.status === "done" ? "ok" : r.status === "rejected" ? "offline" : "warn";
    return `<tr>
      <td class="mono">#${r.id}</td>
      <td class="mono">${r.queue_no}<div class="muted">订单状态 ${STATUS_TEXT[r.order_status] || r.order_status}</div></td>
      <td class="mono">${yuan(r.amount)}</td>
      <td>${r.reason}</td>
      <td>${r.requested_by}</td>
      <td>${r.manager || "—"}</td>
      <td><span class="badge ${cls}">${STATUS_TEXT[r.status] || r.status}</span></td>
      <td class="mono muted">${r.receipt_no || "—"}</td>
      <td><div class="row" style="gap:6px">${act}</div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9" class="muted">暂无退款单</td></tr>`;
}

window.requestRefund = async () => {
  try {
    await api("/api/refunds", {
      method: "POST",
      body: {
        order_id: parseInt(document.getElementById("rf-order").value, 10),
        amount: parseInt(document.getElementById("rf-amount").value, 10),
        requested_by: document.getElementById("rf-by").value,
        reason: document.getElementById("rf-reason").value,
      },
    });
    toast("退款申请已提交，等待店长审核", "ok");
    load();
  } catch (e) { toast(e.message, "err"); }
};

window.review = async (id, approve) => {
  try {
    const r = await api(`/api/refunds/${id}/review`, {
      method: "POST",
      body: { manager: document.getElementById("mgr").value, approve },
    });
    if (r.reused) toast("该退款单已处理，返回既有结果（幂等）", "ok");
    else toast(approve ? "审核通过，退款已退回付款账户" : "已驳回", approve ? "ok" : "err");
    load();
  } catch (e) { toast(e.message + "（单据保留，可重试，不会重复打款）", "err"); }
};

load();
