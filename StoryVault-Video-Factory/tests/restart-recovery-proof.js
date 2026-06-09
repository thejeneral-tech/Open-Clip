'use strict';
// Integration proof for spec §16/§17: a batch interrupted mid-stage RESUMES from its
// last completed stage after a simulated restart, with no manual repair.
const db = require('../src/db/database');
const batch = require('../src/services/batch');
const jobs = require('../src/services/jobs');

function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      const r = await fn();
      if (r) return resolve(r);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(tick, 500);
    };
    tick();
  });
}

(async () => {
  db.getDb();
  console.log('\nRestart-recovery integration proof\n');

  // 1. Create a batch of 1 and let it run far enough to complete the SCRIPT stage.
  const b = await batch.create({ count: 1, category: null });
  const itemId = b.items[0].id;
  console.log(`  • Created batch ${b.id} with 1 item.`);
  batch.run(b.id);

  // Wait until the item has a job with the 'script' stage marked done.
  const reached = await waitFor(async () => {
    const it = db.get('SELECT * FROM batch_items WHERE id = ?', [itemId]);
    if (!it.job_id) return null;
    const scriptStage = db.get("SELECT * FROM job_stages WHERE job_id = ? AND name = 'script'", [it.job_id]);
    return scriptStage && scriptStage.status === 'done' ? it : null;
  }, 60000);
  if (!reached) { console.error('  ✗ item never completed the script stage'); process.exit(1); }
  console.log('  • Script stage completed.');

  // 2. SIMULATE A CRASH: stop the runner, leave the item stranded mid-stage.
  batch.stop(b.id);                       // detaches the in-memory runner
  db.update('batches', b.id, { status: 'Generating audio', paused: 0 });
  db.update('batch_items', itemId, { status: 'Generating audio', stage_detail: 'killed mid-flight' });
  const jobIdBefore = db.get('SELECT job_id FROM batch_items WHERE id = ?', [itemId]).job_id;
  const stagesBefore = jobs.stagesOf(jobIdBefore).filter((s) => s.status === 'done').map((s) => s.name);
  console.log(`  • Simulated crash. Completed stages preserved in DB: [${stagesBefore.join(', ')}]`);

  // 3. RESTART RECOVERY (the exact call server.js makes on boot).
  const rec = batch.recoverInterrupted();
  console.log(`  • recoverInterrupted(): reset ${rec.reset} item(s), resumed ${rec.requeued} batch(es).`);

  // 4. The item must reach Ready for review WITHOUT re-running the script stage.
  const done = await waitFor(async () => {
    const it = db.get('SELECT * FROM batch_items WHERE id = ?', [itemId]);
    return it.status === 'Ready for review' ? it : (it.status === 'Failed' ? it : null);
  }, 120000);

  if (!done || done.status !== 'Ready for review') {
    console.error(`  ✗ item did not resume to Ready for review (status: ${done && done.status})`);
    process.exit(1);
  }
  const scriptStage = db.get("SELECT * FROM job_stages WHERE job_id = ? AND name = 'script'", [jobIdBefore]);
  const sameJob = done.job_id === jobIdBefore;
  const scriptReused = scriptStage.attempts <= 1; // ran once before the crash, not again

  console.log(`  • Item resumed to "Ready for review" (video ${done.video_id}).`);
  console.log(`  • Same job reused: ${sameJob}. Script stage attempts: ${scriptStage.attempts} (reused: ${scriptReused}).`);
  console.log(`\n  ${sameJob && scriptReused ? '✓ PASS' : '✗ FAIL'} — batch survived restart and resumed from the last completed stage.\n`);
  process.exit(sameJob && scriptReused ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
