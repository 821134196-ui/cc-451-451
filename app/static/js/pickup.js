// 取件屏：仅大号数字键盘 + 结果提示，无其他导航元素
const input = document.getElementById("code");
const result = document.getElementById("result");

window.key = (d) => {
  if (input.value.length >= 6) return;
  input.value += d;
  result.className = "pickup-result";
  result.textContent = "请输入 6 位取件码";
};
window.clearCode = () => {
  input.value = "";
  result.className = "pickup-result";
  result.textContent = "已清空";
};

window.verify = async () => {
  if (input.value.length !== 6) {
    result.className = "pickup-result err";
    result.textContent = "请输入完整的 6 位取件码";
    return;
  }
  try {
    const o = await api("/api/pickup/verify", { method: "POST", body: { code: input.value } });
    result.className = "pickup-result ok";
    result.innerHTML = `✅ 核验通过：${o.queue_no} · ${o.customer_name} · ${o.copies} 份，取件完成`;
    input.value = "";
  } catch (e) {
    result.className = "pickup-result err";
    result.textContent = "✕ " + e.message;
  }
};

// 物理键盘也可输入
document.addEventListener("keydown", (e) => {
  if (/^[0-9]$/.test(e.key)) key(e.key);
  else if (e.key === "Backspace") input.value = input.value.slice(0, -1);
  else if (e.key === "Enter") verify();
});
