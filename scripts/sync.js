'use strict';
/**
 * Täglicher Sync: holt SOAP-Änderungen für alle noch nicht synchronisierten Tage
 * und aktualisiert Firmen, die bereits in der DB sind.
 *
 * Aufruf:   node scripts/sync.js
 * Cron:     0 3 * * *  node /path/to/scripts/sync.js
 */
require('dotenv/config');
const { veraenderungenFirma, scrapeAndPersist } = require('../services/firmenbuch');
const dbService = require('../services/db');

const DELAY_MS = Number(process.env.SYNC_DELAY_MS) || 1500;

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

function getLastSyncedDate() {
  const db = dbService.getDb();
  const row = db.prepare('SELECT sync_date FROM sync_log ORDER BY sync_date DESC LIMIT 1').get();
  if (row) return row.sync_date;
  // Kein Eintrag: vorgestern als Startpunkt, damit gestern beim ersten Lauf synchronisiert wird
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return d.toISOString().slice(0, 10);
}

function isInDb(fnr) {
  return !!dbService.getDb().prepare('SELECT 1 FROM companies WHERE fnr = ?').get(fnr);
}

function saveChange(fnr, art, vollzugsdatum) {
  dbService.getDb().prepare(`
    INSERT INTO soap_changes (company_fnr, art, vollzugsdatum)
    VALUES (?, ?, ?)
  `).run(fnr, art, vollzugsdatum);
}

function markChangeProcessed(fnr, vollzugsdatum) {
  dbService.getDb().prepare(`
    UPDATE soap_changes SET processed_at = datetime('now')
    WHERE company_fnr = ? AND vollzugsdatum = ? AND processed_at IS NULL
  `).run(fnr, vollzugsdatum);
}

function writeSyncLog(date, companiesUpdated) {
  dbService.getDb().prepare(`
    INSERT OR REPLACE INTO sync_log (sync_date, companies_updated, synced_at)
    VALUES (?, ?, datetime('now'))
  `).run(date, companiesUpdated);
}

async function syncDay(date) {
  console.log(`[${date}] Hole SOAP-Änderungen...`);
  let changes;
  try {
    changes = await veraenderungenFirma({ von: date, bis: date });
  } catch (err) {
    console.error(`[${date}] SOAP-Fehler: ${err.message}`);
    return 0;
  }

  console.log(`[${date}] ${changes.length} Änderungen gefunden`);

  // Alle Änderungen in soap_changes speichern
  for (const c of changes) {
    saveChange(c.fnr, c.art, c.vollzugsdatum);
  }

  let updated = 0;

  for (const c of changes) {
    const { fnr, art, vollzugsdatum } = c;

    if (art === 'Löschung') {
      // Firma als gelöscht markieren (auch wenn nicht in DB)
      const db = dbService.getDb();
      if (isInDb(fnr)) {
        db.prepare(`UPDATE companies SET status = 'gelöscht', updated_at = datetime('now') WHERE fnr = ?`).run(fnr);
        console.log(`  [${fnr}] Als gelöscht markiert`);
        updated++;
      } else {
        // Neu anlegen als gelöscht damit wir FNR kennen
        dbService.upsertCompany(fnr, { status: 'gelöscht' });
      }
      markChangeProcessed(fnr, vollzugsdatum);
      continue;
    }

    if (art === 'Neueintragung') {
      // FNR in DB aufnehmen, Bulk-Load erledigt die Anreicherung
      if (!isInDb(fnr)) {
        dbService.upsertCompany(fnr, { status: 'aktiv' });
        console.log(`  [${fnr}] Neue Firma angelegt (pending)`);
      }
      markChangeProcessed(fnr, vollzugsdatum);
      continue;
    }

    // 'Änderung' → nur aktualisieren wenn bereits in DB
    if (!isInDb(fnr)) {
      markChangeProcessed(fnr, vollzugsdatum);
      continue;
    }

    try {
      await scrapeAndPersist(fnr);
      markChangeProcessed(fnr, vollzugsdatum);
      console.log(`  [${fnr}] Aktualisiert (${art})`);
      updated++;
    } catch (err) {
      if (err.response?.status === 429) {
        console.warn(`  [${fnr}] Rate limit erreicht — Abbruch`);
        return updated;
      }
      console.error(`  [${fnr}] Fehler: ${err.message}`);
    }

    await sleep(DELAY_MS);
  }

  return updated;
}

async function run() {
  const lastSynced = getLastSyncedDate();
  const target = yesterday();

  if (lastSynced >= target) {
    console.log(`Bereits aktuell (letzter Sync: ${lastSynced})`);
    return;
  }

  // Alle fehlenden Tage aufholen
  const dates = dateRange(
    new Date(new Date(lastSynced).getTime() + 86400000).toISOString().slice(0, 10),
    target,
  );

  console.log(`Synchronisiere ${dates.length} Tag(e): ${dates[0]} bis ${dates[dates.length - 1]}`);

  for (const date of dates) {
    const updated = await syncDay(date);
    writeSyncLog(date, updated);
    console.log(`[${date}] Sync abgeschlossen (${updated} Firmen aktualisiert)`);
  }

  console.log('Sync fertig.');
}

run().catch(err => {
  console.error('Sync fehlgeschlagen:', err.message);
  process.exit(1);
});
