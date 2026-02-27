'use strict';
/**
 * Initialer Bulk-Load des gesamten Firmenbuchs.
 *
 * Phase 1 — FNR-Sammlung:
 *   Ruft VERAENDERUNGENFIRMAREQUEST tagesweise rückwärts ab und sammelt
 *   alle FNRs die je im Firmenbuch existiert haben. Speichert sie als
 *   scrape_status='pending' in der DB.
 *
 * Phase 2 — Anreicherung:
 *   Scrapt SOAP + EVI für jede pending-Firma und persistiert in der DB.
 *   Gedrosselt via BULK_DELAY_MS, vollständig resumebar.
 *
 * Aufruf:
 *   node scripts/bulk-load.js phase1        # nur FNR-Sammlung
 *   node scripts/bulk-load.js phase2        # nur Anreicherung
 *   node scripts/bulk-load.js               # beide Phasen nacheinander
 *
 * Umgebungsvariablen:
 *   BULK_DELAY_MS=2000     ms Pause zwischen Requests (default: 2000)
 *   BULK_BATCH_SIZE=500    Firmen pro Lauf in Phase 2 (default: 500)
 *   BULK_FROM=2000-01-01   Startdatum für Phase 1 (default: 2000-01-01)
 */
require('dotenv/config');
const { veraenderungenFirma, scrapeAndPersist } = require('../services/firmenbuch');
const dbService = require('../services/db');

const DELAY_MS   = Number(process.env.BULK_DELAY_MS)   || 2000;
const BATCH_SIZE = Number(process.env.BULK_BATCH_SIZE) || 500;
const FROM_DATE  = process.env.BULK_FROM               || '2000-01-01';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── Phase 1 ────────────────────────────────────────────────────────

function getLastCollectedDate() {
  const row = dbService.getDb()
    .prepare(`SELECT MAX(sync_date) AS d FROM sync_log WHERE sync_date LIKE 'bulk1:%'`)
    .get();
  if (row && row.d) return row.d.replace('bulk1:', '');
  return null;
}

function markDateCollected(date, newFnrs) {
  dbService.getDb().prepare(`
    INSERT OR REPLACE INTO sync_log (sync_date, companies_updated, synced_at)
    VALUES (?, ?, datetime('now'))
  `).run('bulk1:' + date, newFnrs);
}

async function phase1() {
  const lastCollected = getLastCollectedDate();
  const startDate = lastCollected
    ? new Date(new Date(lastCollected).getTime() + 86400000).toISOString().slice(0, 10)
    : FROM_DATE;
  const endDate = yesterday();

  if (startDate > endDate) {
    console.log('[Phase 1] FNR-Sammlung bereits abgeschlossen.');
    return;
  }

  const dates = dateRange(startDate, endDate);
  console.log(`[Phase 1] Sammle FNRs für ${dates.length} Tage (${startDate} → ${endDate})`);

  const db = dbService.getDb();
  let totalNew = 0;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let changes;

    try {
      changes = await veraenderungenFirma({ von: date, bis: date });
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn(`[Phase 1] Rate limit am ${date} — Abbruch, beim nächsten Lauf fortsetzen`);
        break;
      }
      console.error(`[Phase 1] Fehler am ${date}: ${err.message}`);
      markDateCollected(date, 0);
      await sleep(DELAY_MS);
      continue;
    }

    let newFnrs = 0;
    for (const c of changes) {
      if (!db.prepare('SELECT 1 FROM companies WHERE fnr = ?').get(c.fnr)) {
        dbService.upsertCompany(c.fnr, {
          status: c.art === 'Löschung' ? 'gelöscht' : 'aktiv',
        });
        newFnrs++;
        totalNew++;
      }
    }

    markDateCollected(date, newFnrs);

    // Fortschritt alle 30 Tage ausgeben
    if ((i + 1) % 30 === 0 || i === dates.length - 1) {
      const progress = db.prepare('SELECT COUNT(*) AS n FROM companies').get();
      console.log(`[Phase 1] ${date} — ${i + 1}/${dates.length} Tage, ${progress.n} Firmen gesamt (+${totalNew} neu)`);
    }

    await sleep(500); // Phase 1 kann schneller laufen, nur 1 Call/Tag
  }

  console.log(`[Phase 1] Abgeschlossen. ${totalNew} neue FNRs gesammelt.`);
}

// ── Phase 2 ────────────────────────────────────────────────────────

async function phase2() {
  const db = dbService.getDb();

  const total = db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE scrape_status != 'done'`).get();
  console.log(`[Phase 2] ${total.n} Firmen ausstehend (Batch: ${BATCH_SIZE}, Delay: ${DELAY_MS}ms)`);

  if (total.n === 0) {
    console.log('[Phase 2] Alle Firmen bereits angereichert.');
    return;
  }

  const pending = db.prepare(`
    SELECT fnr FROM companies
    WHERE scrape_status = 'pending'
       OR (scrape_status = 'error' AND scrape_attempts < 3)
    ORDER BY scrape_attempts ASC, last_attempt_at ASC
    LIMIT ?
  `).all(BATCH_SIZE);

  console.log(`[Phase 2] Verarbeite ${pending.length} Firmen in diesem Lauf...`);

  let done = 0;
  let errors = 0;

  for (const { fnr } of pending) {
    try {
      await scrapeAndPersist(fnr);
      done++;

      if (done % 50 === 0) {
        const remaining = db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE scrape_status != 'done'`).get();
        console.log(`[Phase 2] ${done} fertig, ${remaining.n} verbleibend`);
      }
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn(`[Phase 2] Rate limit bei ${fnr} — Abbruch, beim nächsten Lauf fortsetzen`);
        break;
      }
      db.prepare(`
        UPDATE companies
        SET scrape_status = 'error', scrape_error = ?,
            scrape_attempts = scrape_attempts + 1, last_attempt_at = datetime('now')
        WHERE fnr = ?
      `).run(err.message, fnr);
      errors++;
    }

    await sleep(DELAY_MS);
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE scrape_status != 'done'`).get();
  console.log(`[Phase 2] Lauf beendet: ${done} OK, ${errors} Fehler, ${remaining.n} verbleibend`);
}

// ── Fortschrittsanzeige ────────────────────────────────────────────

function printProgress() {
  const rows = dbService.getBulkLoadProgress();
  console.log('\n── Bulk-Load Fortschritt ──────────────────');
  for (const r of rows) {
    console.log(`  ${r.scrape_status.padEnd(10)} ${r.count}`);
  }
  const phase1Last = getLastCollectedDate();
  console.log(`  Phase 1 zuletzt: ${phase1Last || '(noch nicht gestartet)'}`);
  console.log('────────────────────────────────────────────\n');
}

// ── Einstieg ───────────────────────────────────────────────────────

async function run() {
  const arg = process.argv[2];
  printProgress();

  if (arg === 'phase1') {
    await phase1();
  } else if (arg === 'phase2') {
    await phase2();
  } else if (arg === 'progress') {
    // Nur Fortschritt ausgeben, nichts tun
  } else {
    await phase1();
    await phase2();
  }

  printProgress();
}

run().catch(err => {
  console.error('Bulk-Load fehlgeschlagen:', err.message);
  process.exit(1);
});
