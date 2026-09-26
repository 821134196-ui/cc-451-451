'use strict';
const { createApp } = require('./app');

/** 一条命令完成初始化并启动：npm start */
const app = createApp();
const port = Number(process.env.PORT || app.config.port);

app.listen(port).then((actual) => {
  app.tasks.start();
  const base = `http://localhost:${actual}`;
  console.log(`证件照门店系统已启动  ${base}`);
  console.log(`  数据目录: ${app.config.dataDir}`);
  console.log('  页面入口:');
  console.log(`    总览导航   ${base}/`);
  console.log(`    叫号屏     ${base}/display.html`);
  console.log(`    拍摄终端   ${base}/terminal.html`);
  console.log(`    候选选择   ${base}/select.html`);
  console.log(`    修正队列   ${base}/retouch.html`);
  console.log(`    冲印任务   ${base}/print.html`);
  console.log(`    取件核验   ${base}/pickup.html`);
  console.log(`    退款复核   ${base}/refunds.html`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { app.close(); process.exit(0); });
}
