import { createApp } from './app.js';
import { seedDemo } from './seed.js';

const app = createApp();

if (process.argv.includes('--seed-demo')) {
  const seeded = await seedDemo(app);
  if (seeded) console.log('데모 이력을 넣었습니다.');
}

app.server.listen(app.config.port, app.config.host, () => {
  console.log(`문서 해지 센터  http://${app.config.host}:${app.config.port}`);
  console.log(`MIP 어댑터: ${app.mip.name} · 데이터: ${app.config.dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}
