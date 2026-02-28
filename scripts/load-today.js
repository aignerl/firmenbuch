'use strict';
/**
 * Lädt N Firmen mit heutigen Änderungen in die DB (Testdaten).
 * Aufruf: node scripts/load-today.js [anzahl]   (default: 5)
 */
require('dotenv/config');
const { veraenderungenFirma, scrapeAndPersist } = require('../services/firmenbuch');
const dbService = require('../services/db');

const LIMIT = parseInt(process.argv[2] || '5', 10);
const DELAY_MS = 1500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function run() {
  const date = today();
  console.log(`Hole Änderungen für ${date}...`);

  let changes;
  try {
    changes = await veraenderungenFirma({ von: date, bis: date });
  } catch (err) {
    console.error('SOAP-Fehler:', err.message);
    process.exit(1);
  }

  console.log(`${changes.length} Änderungen gefunden.`);

  // Nur 'Änderung' und 'Neueintragung', noch nicht vollständig gescrapt
  const db = dbService.getDb();
  const candidates = changes
    .filter(c => c.art !== 'Löschung')
    .filter(c => {
      const row = db.prepare("SELECT scrape_status FROM companies WHERE fnr = ?").get(c.fnr);
      return !row || row.scrape_status !== 'done';
    })
    .slice(0, LIMIT);

  console.log(`Scrappe ${candidates.length} Firmen...`);

  let ok = 0;
  for (const { fnr, art } of candidates) {
    try {
      await scrapeAndPersist(fnr);
      console.log(`  ✓ ${fnr} (${art})`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${fnr}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  const total = db.prepare("SELECT COUNT(*) AS n FROM companies WHERE scrape_status='done'").get();
  console.log(`\nFertig: ${ok}/${candidates.length} erfolgreich. Gesamt in DB: ${total.n} vollständig.`);
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
