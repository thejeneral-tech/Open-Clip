/**
 * healthcheck.js
 * Calls GET /api/health and prints a readable status report.
 * Run: npm run healthcheck
 * Exit code 0 = ok/warning, 1 = failed or server down.
 */
const PORT = process.env.PORT || 3001;

fetch(`http://localhost:${PORT}/api/health`)
  .then(r => r.json())
  .then(data => {
    const icons = { ok: 'ok', warning: 'WARN', failed: 'FAIL' };
    console.log(`\n  Trend Vault Program Health Check`);
    console.log(`  Status: ${data.status.toUpperCase()}  (${data.timestamp})\n`);
    for (const [name, comp] of Object.entries(data.components)) {
      const icon = icons[comp.status] || '?';
      console.log(`  [${icon}] ${name.padEnd(20)} ${comp.message}`);
    }
    console.log('');
    process.exit(data.status === 'failed' ? 1 : 0);
  })
  .catch(e => {
    console.error(`\n  Server not running on port ${PORT}: ${e.message}\n`);
    console.error('  Start with: npm start\n');
    process.exit(1);
  });
