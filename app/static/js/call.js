renderNav("/screen/call");

const dot = (s) => {
  const color = s === "online" ? "#2E7D46" : s === "busy" ? "#1F4E8C" : "#B3352B";
  return `<span class="dev-dot" style="background:${color}"></span>`;
};

async function load() {
  const b = await api("/api/call-board");
  document.getElementById("current").innerHTML = b.current.length
    ? b.current.map((o) => `
      <div class="queue-card">
        <div>
          <div class="big-queue mono">${o.queue_no}</div>
          <div class="who">${o.customer_name}</div>
          <div class="muted">${o.device_name || ""} · ${STATUS_TEXT[o.status] || o.status}</div>
        </div>
        <div style="text-align:right">
          <a class="btn" href="/screen/capture?order=${o.id}">拍摄终端</a>
          <div style="margin-top:8px"><a class="btn ghost" href="/screen/select?order=${o.id}">候选选择</a></div>
        </div>
      </div>`).join("")
    : `<div class="card muted">当前没有在处理的订单，请在首页叫号。</div>`;

  document.getElementById("cams").innerHTML = b.cameras.map((d) =>
    `${dot(d.status)}${d.name} <span class="muted">${d.locked_by ? "锁定 " + d.locked_by : "空闲"}</span>`
  ).join("<br>");

  document.getElementById("recent").innerHTML = b.recent.length
    ? b.recent.map((o) => `${o.queue_no} · ${STATUS_TEXT[o.status] || o.status}`).join("<br>")
    : "暂无";
}
load();
setInterval(load, 3000);
