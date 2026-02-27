'use strict';
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../db/firmenbuch.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    -- ── Stammdaten ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS companies (
      fnr              TEXT  PRIMARY KEY,
      rechtsform       TEXT,
      sitz             TEXT,
      status           TEXT  NOT NULL DEFAULT 'aktiv',
      scraped_at       DATETIME,
      scrape_status    TEXT  NOT NULL DEFAULT 'pending',
      scrape_attempts  INTEGER NOT NULL DEFAULT 0,
      scrape_error     TEXT,
      last_attempt_at  DATETIME,
      created_at       DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at       DATETIME NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Firmenwortlaute mit Umbenennungshistorie ───────────────────
    CREATE TABLE IF NOT EXISTS company_names (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      company_fnr  TEXT    NOT NULL REFERENCES companies(fnr),
      name         TEXT    NOT NULL,
      valid_from   DATE    NOT NULL,
      valid_to     DATE,
      created_at   DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_company_names_fnr
      ON company_names(company_fnr);
    CREATE INDEX IF NOT EXISTS idx_company_names_current
      ON company_names(company_fnr, valid_to)
      WHERE valid_to IS NULL;

    -- ── Gesellschafter mit Historie ────────────────────────────────
    CREATE TABLE IF NOT EXISTS gesellschafter (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      company_fnr         TEXT    NOT NULL REFERENCES companies(fnr),
      gesellschafter_fnr  TEXT,   -- Soft-Referenz: Firma evtl. noch nicht in DB
      name                TEXT    NOT NULL,
      quelle              TEXT    NOT NULL DEFAULT 'EVI',
      valid_from          DATE    NOT NULL,
      valid_to            DATE,
      created_at          DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at          DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gesellschafter_company
      ON gesellschafter(company_fnr);
    CREATE INDEX IF NOT EXISTS idx_gesellschafter_gs_fnr
      ON gesellschafter(gesellschafter_fnr)
      WHERE gesellschafter_fnr IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gesellschafter_current
      ON gesellschafter(company_fnr, valid_to)
      WHERE valid_to IS NULL;

    -- ── Personen-Rollen mit Historie ───────────────────────────────
    CREATE TABLE IF NOT EXISTS personen_rollen (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      company_fnr  TEXT    NOT NULL REFERENCES companies(fnr),
      name         TEXT    NOT NULL,
      rolle        TEXT    NOT NULL,
      fkentext     TEXT,
      valid_from   DATE    NOT NULL,
      valid_to     DATE,
      created_at   DATETIME NOT NULL DEFAULT (datetime('now')),
      updated_at   DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_personen_rollen_company
      ON personen_rollen(company_fnr);
    CREATE INDEX IF NOT EXISTS idx_personen_rollen_current
      ON personen_rollen(company_fnr, valid_to)
      WHERE valid_to IS NULL;

    -- ── SOAP-Änderungen (Rohdaten) ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS soap_changes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      company_fnr     TEXT    NOT NULL,
      art             TEXT    NOT NULL,
      vollzugsdatum   DATE    NOT NULL,
      processed_at    DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_soap_changes_fnr
      ON soap_changes(company_fnr);
    CREATE INDEX IF NOT EXISTS idx_soap_changes_unprocessed
      ON soap_changes(processed_at)
      WHERE processed_at IS NULL;

    -- ── Sync-Log ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sync_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_date          DATE    NOT NULL UNIQUE,
      companies_updated  INTEGER NOT NULL DEFAULT 0,
      synced_at          DATETIME NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Adressen (aktueller Stand, wird bei jedem Auszug ersetzt) ──
    CREATE TABLE IF NOT EXISTS adressen (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_fnr TEXT    NOT NULL REFERENCES companies(fnr),
      strasse     TEXT,
      hausnummer  TEXT,
      plz         TEXT,
      ort         TEXT,
      staat       TEXT    NOT NULL DEFAULT 'AUT',
      updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_adressen_fnr
      ON adressen(company_fnr);

    -- ── Jahresabschlüsse (KPI-Cache, keyed by urkunde_key) ─────────
    CREATE TABLE IF NOT EXISTS jahresabschluesse (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_fnr TEXT    NOT NULL REFERENCES companies(fnr),
      urkunde_key TEXT    NOT NULL UNIQUE,
      gj_beginn   TEXT,
      gj_ende     TEXT,
      gj_jahr     INTEGER,
      kpis        TEXT    NOT NULL,
      positions   TEXT,
      created_at  DATETIME NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_jahresabschluesse_fnr
      ON jahresabschluesse(company_fnr);
    CREATE INDEX IF NOT EXISTS idx_jahresabschluesse_jahr
      ON jahresabschluesse(company_fnr, gj_jahr);

    -- ── KPI-Scrape-Status (Phase 3 Tracking) ───────────────────────
    CREATE TABLE IF NOT EXISTS kpi_scrape_status (
      company_fnr TEXT    PRIMARY KEY REFERENCES companies(fnr),
      ja_count    INTEGER NOT NULL DEFAULT 0,
      scraped_at  DATETIME NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// ── Hilfsfunktionen ────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Gibt den aktuellen Namen einer Firma zurück.
 */
function getCurrentName(fnr) {
  const db = getDb();
  const row = db.prepare(`
    SELECT name FROM company_names
    WHERE company_fnr = ? AND valid_to IS NULL
    ORDER BY valid_from DESC LIMIT 1
  `).get(fnr);
  return row ? row.name : null;
}

/**
 * Legt eine Firma an oder aktualisiert Stammdaten.
 * Gibt true zurück wenn neu angelegt, false wenn aktualisiert.
 */
function upsertCompany(fnr, { name, rechtsform, sitz, status } = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT fnr FROM companies WHERE fnr = ?').get(fnr);

  if (!existing) {
    db.prepare(`
      INSERT INTO companies (fnr, rechtsform, sitz, status)
      VALUES (?, ?, ?, ?)
    `).run(fnr, rechtsform || null, sitz || null, status || 'aktiv');

    if (name) {
      db.prepare(`
        INSERT INTO company_names (company_fnr, name, valid_from)
        VALUES (?, ?, ?)
      `).run(fnr, name, today());
    }
    return true;
  }

  // Stammdaten aktualisieren
  db.prepare(`
    UPDATE companies SET rechtsform = ?, sitz = ?, status = ?, updated_at = datetime('now')
    WHERE fnr = ?
  `).run(rechtsform || null, sitz || null, status || 'aktiv', fnr);

  // Name: nur neu eintragen wenn geändert
  if (name) {
    const currentName = getCurrentName(fnr);
    if (currentName !== name) {
      // Alten Namen abschließen
      db.prepare(`
        UPDATE company_names SET valid_to = ? WHERE company_fnr = ? AND valid_to IS NULL
      `).run(today(), fnr);
      // Neuen Namen eintragen
      db.prepare(`
        INSERT INTO company_names (company_fnr, name, valid_from) VALUES (?, ?, ?)
      `).run(fnr, name, today());
    }
  }
  return false;
}

/**
 * Aktualisiert Gesellschafter einer Firma (mit valid_from/valid_to Historisierung).
 * newList: Array von { name, fnr (optional), quelle }
 */
function updateGesellschafter(companyFnr, newList) {
  const db = getDb();
  const t = today();

  const current = db.prepare(`
    SELECT id, name, gesellschafter_fnr FROM gesellschafter
    WHERE company_fnr = ? AND valid_to IS NULL
  `).all(companyFnr);

  const normalize = (g) => `${(g.gesellschafter_fnr || '').trim()}|${g.name.trim()}`;
  const currentMap = new Map(current.map(g => [normalize(g), g]));
  const newMap = new Map(newList.map(g => [
    normalize({ gesellschafter_fnr: g.fnr || null, name: g.name }),
    g,
  ]));

  // Weggefallene abschließen
  for (const [key, row] of currentMap) {
    if (!newMap.has(key)) {
      db.prepare(`UPDATE gesellschafter SET valid_to = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(t, row.id);
    }
  }

  // Neue eintragen
  for (const [key, g] of newMap) {
    if (!currentMap.has(key)) {
      db.prepare(`
        INSERT INTO gesellschafter (company_fnr, gesellschafter_fnr, name, quelle, valid_from)
        VALUES (?, ?, ?, ?, ?)
      `).run(companyFnr, g.fnr || null, g.name, g.quelle || 'EVI', t);
    }
  }
}

/**
 * Aktualisiert Personen-Rollen einer Firma (mit Historisierung).
 * newList: Array von { name, rolle, fkentext }
 */
function updatePersonenRollen(companyFnr, newList) {
  const db = getDb();
  const t = today();

  const current = db.prepare(`
    SELECT id, name, rolle FROM personen_rollen
    WHERE company_fnr = ? AND valid_to IS NULL
  `).all(companyFnr);

  const normalize = (r) => `${r.rolle}|${r.name.trim()}`;
  const currentMap = new Map(current.map(r => [normalize(r), r]));
  const newMap = new Map(newList.map(r => [normalize(r), r]));

  for (const [key, row] of currentMap) {
    if (!newMap.has(key)) {
      db.prepare(`UPDATE personen_rollen SET valid_to = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(t, row.id);
    }
  }

  for (const [key, r] of newMap) {
    if (!currentMap.has(key)) {
      db.prepare(`
        INSERT INTO personen_rollen (company_fnr, name, rolle, fkentext, valid_from)
        VALUES (?, ?, ?, ?, ?)
      `).run(companyFnr, r.name, r.rolle, r.fkentext || null, t);
    }
  }
}

/**
 * Gibt aktuelle Gesellschafter einer Firma zurück.
 */
function getGesellschafter(fnr) {
  return getDb().prepare(`
    SELECT name, gesellschafter_fnr AS fnr, quelle
    FROM gesellschafter
    WHERE company_fnr = ? AND valid_to IS NULL
    ORDER BY name
  `).all(fnr);
}

/**
 * Gibt aktuelle Personen-Rollen einer Firma zurück.
 */
function getPersonenRollen(fnr) {
  return getDb().prepare(`
    SELECT name, rolle, fkentext
    FROM personen_rollen
    WHERE company_fnr = ? AND valid_to IS NULL
    ORDER BY rolle, name
  `).all(fnr);
}

/**
 * Gibt alle Firmen zurück, an denen eine bestimmte FNR als Gesellschafter beteiligt ist.
 * (Tochtergesellschaften)
 */
function getTochtergesellschaften(fnr) {
  const db = getDb();
  const toechter = db.prepare(`
    SELECT g.company_fnr AS fnr, cn.name
    FROM gesellschafter g
    LEFT JOIN company_names cn
      ON cn.company_fnr = g.company_fnr AND cn.valid_to IS NULL
    WHERE g.gesellschafter_fnr = ? AND g.valid_to IS NULL
  `).all(fnr);

  return toechter.map(t => {
    const coGs = db.prepare(`
      SELECT g.name, g.gesellschafter_fnr AS fnr
      FROM gesellschafter g
      WHERE g.company_fnr = ? AND g.gesellschafter_fnr != ? AND g.valid_to IS NULL
    `).all(t.fnr, fnr).map(cg => ({
      fnr: cg.fnr,
      name: cg.name,
      geschaeftsfuehrer: getPersonenRollen(cg.fnr).filter(r => r.rolle === 'GF').map(r => r.name),
      vorstand: getPersonenRollen(cg.fnr).filter(r => r.rolle === 'VM').map(r => r.name),
    }));

    const rollen = getPersonenRollen(t.fnr);
    return {
      fnr: t.fnr,
      name: t.name || t.fnr,
      coGesellschafter: coGs,
      geschaeftsfuehrer: rollen.filter(r => r.rolle === 'GF').map(r => r.name),
      vorstand: rollen.filter(r => r.rolle === 'VM').map(r => r.name),
    };
  });
}

/**
 * Ersetzt alle Adressen einer Firma durch die neue Liste.
 * adressen: Array von { strasse, hausnummer, plz, ort, staat }
 */
function updateAdressen(companyFnr, adressen) {
  const db = getDb();
  db.prepare('DELETE FROM adressen WHERE company_fnr = ?').run(companyFnr);
  const ins = db.prepare(`
    INSERT INTO adressen (company_fnr, strasse, hausnummer, plz, ort, staat)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const a of adressen) {
    ins.run(companyFnr, a.strasse || null, a.hausnummer || null,
      a.plz || null, a.ort || null, a.staat || 'AUT');
  }
}

/**
 * Speichert einen geparsten Jahresabschluss (INSERT OR IGNORE – einmal gespeichert
 * wird nie überschrieben, da sich ein eingereichter Abschluss nicht ändert).
 */
function upsertJahresabschluss(companyFnr, urkundeKey, { gj, kpis, positions }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO jahresabschluesse
      (company_fnr, urkunde_key, gj_beginn, gj_ende, gj_jahr, kpis, positions)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyFnr, urkundeKey,
    gj?.beginn || null, gj?.ende || null, gj?.jahr || null,
    JSON.stringify(kpis),
    positions ? JSON.stringify(positions) : null,
  );
}

/**
 * Gibt einen gecachten Jahresabschluss zurück oder null.
 */
function getJahresabschluss(urkundeKey) {
  const row = getDb().prepare(
    'SELECT * FROM jahresabschluesse WHERE urkunde_key = ?'
  ).get(urkundeKey);
  if (!row) return null;
  return {
    gj: { beginn: row.gj_beginn, ende: row.gj_ende, jahr: row.gj_jahr },
    kpis: JSON.parse(row.kpis),
    positions: row.positions ? JSON.parse(row.positions) : {},
  };
}

/**
 * Gibt alle gespeicherten Jahresabschlüsse einer Firma zurück (für die Jahr-Auswahl).
 */
function getJahresabschlussList(companyFnr) {
  return getDb().prepare(`
    SELECT urkunde_key, gj_beginn, gj_ende, gj_jahr
    FROM jahresabschluesse
    WHERE company_fnr = ?
    ORDER BY gj_jahr DESC NULLS LAST
  `).all(companyFnr);
}

/**
 * Gibt Firmen zurück, die Phase 2 abgeschlossen haben, aber noch keinen
 * KPI-Scrape (Phase 3) hatten.
 */
function getPendingKpiScrape(limit) {
  return getDb().prepare(`
    SELECT c.fnr FROM companies c
    LEFT JOIN kpi_scrape_status k ON k.company_fnr = c.fnr
    WHERE c.scrape_status = 'done' AND k.company_fnr IS NULL
    ORDER BY c.fnr
    LIMIT ?
  `).all(limit);
}

/**
 * Markiert eine Firma als KPI-gescrapt (auch wenn keine Jahresabschlüsse gefunden).
 */
function markKpiScraped(companyFnr, jaCount) {
  getDb().prepare(`
    INSERT OR REPLACE INTO kpi_scrape_status (company_fnr, ja_count, scraped_at)
    VALUES (?, ?, datetime('now'))
  `).run(companyFnr, jaCount || 0);
}

/**
 * Fortschrittsabfrage für Bulk-Load.
 */
function getBulkLoadProgress() {
  return getDb().prepare(`
    SELECT scrape_status, COUNT(*) AS count FROM companies GROUP BY scrape_status
  `).all();
}

module.exports = {
  getDb,
  upsertCompany,
  updateGesellschafter,
  updatePersonenRollen,
  updateAdressen,
  upsertJahresabschluss,
  getJahresabschluss,
  getJahresabschlussList,
  getPendingKpiScrape,
  markKpiScraped,
  getGesellschafter,
  getPersonenRollen,
  getTochtergesellschaften,
  getCurrentName,
  getBulkLoadProgress,
};
