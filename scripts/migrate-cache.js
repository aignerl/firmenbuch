'use strict';
/**
 * Migriert cache/gesellschafter.json in die SQLite-Datenbank.
 * Kann mehrfach ausgeführt werden (idempotent).
 */
const fs = require('fs');
const path = require('path');
const { upsertCompany, updateGesellschafter, updatePersonenRollen } = require('../services/db');

const CACHE_FILE = path.join(__dirname, '../cache/gesellschafter.json');

function run() {
  if (!fs.existsSync(CACHE_FILE)) {
    console.log('Kein Cache gefunden, nichts zu migrieren.');
    return;
  }

  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const fnrs = Object.keys(cache);
  console.log(`Migriere ${fnrs.length} Einträge aus Cache...`);

  let ok = 0;
  let err = 0;

  for (const fnr of fnrs) {
    const entry = cache[fnr];
    try {
      // Stammdaten
      upsertCompany(fnr, { name: entry.name || null });

      // Gesellschafter
      const gesellschafter = (entry.gesellschafter || []).map(g => ({
        name: g.name,
        fnr: g.fnr || null,
        quelle: g.quelle || 'EVI',
      }));
      updateGesellschafter(fnr, gesellschafter);

      // GF + Vorstand als Personen-Rollen
      const rollen = [
        ...(entry.geschaeftsfuehrer || []).map(name => ({
          name, rolle: 'GF', fkentext: 'Geschäftsführer/in',
        })),
        ...(entry.vorstand || []).map(name => ({
          name, rolle: 'VM', fkentext: 'Vorstand',
        })),
      ];
      updatePersonenRollen(fnr, rollen);

      ok++;
    } catch (e) {
      console.error(`Fehler bei ${fnr}: ${e.message}`);
      err++;
    }
  }

  console.log(`Migration abgeschlossen: ${ok} OK, ${err} Fehler`);
}

run();
