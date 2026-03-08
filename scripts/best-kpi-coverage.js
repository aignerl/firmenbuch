'use strict';
// Re-evaluiert gecachte Positionen mit dem aktuellen extractKpis
const db = require('../services/db').getDb();

// extractKpis aus jahresabschluss.js direkt importieren (nicht exportiert, daher inline-require trick)
// Wir rufen parseJahresabschluss nicht auf sondern nutzen die positions aus DB
// und rufen den API-Endpoint intern auf

const rows = db.prepare('SELECT company_fnr, gj_jahr, positions FROM jahresabschluesse WHERE positions IS NOT NULL').all();

// Wir laden extractKpis aus dem Modul indem wir den Quellcode kurz ausführen
// Einfacher: Zähle direkt aus dem positions-JSON welche KPI-Rohwerte vorhanden sind
// und simuliere extractKpis-Logik

function countFromPositions(posStr) {
  let positions;
  try { positions = typeof posStr === 'string' ? JSON.parse(posStr) : posStr; } catch (e) { return 0; }

  const get = (...codes) => { for (const c of codes) if (positions[c]) return positions[c]; return null; };
  const hasVal = (p) => p && (p.betrag !== null || p.betragVJ !== null);

  const bilanzsumme   = get('HGB_224_2', 'AKTIVA');
  const anlageverm    = get('HGB_224_2_A', 'ANLAGEVERMÖGEN');
  const umlaufverm    = get('HGB_224_2_B', 'UMLAUFVERMÖGEN');
  const vorräte       = get('HGB_224_2_B_I', 'VORRAETE');
  const forderungen   = get('HGB_224_2_B_II', 'FORDERUNGEN');
  const flüssig       = get('HGB_224_2_B_IV', 'FLUESSIGE_MITTEL');
  const ek            = get('HGB_224_3_A', 'EIGENKAPITAL');
  const verbindl      = get('HGB_224_3_D', 'VERBINDLICHKEITEN');
  const kvVerbindl    = get('HGB_224_3_D_HGB_225B', 'VERBINDLICHKEITEN_KFR');
  const rückstell     = get('HGB_224_3_B');
  const langfrVerbindl= get('HGB_224_3_D_HGB_225A');
  const umsatz        = get('HGB_231_2_1', 'HGB_231_1_1', 'UMSATZERLOESE');
  const personal      = get('HGB_231_2_6', 'HGB_231_1_6', 'PERSONALAUFWAND');
  const abschreib     = get('HGB_231_2_7', 'HGB_231_1_7', 'ABSCHREIBUNGEN');
  const betrErg       = get('HGB_231_2_9', 'HGB_231_1_9', 'BETRIEBSERGEBNIS');
  const egt           = get('HGB_231_2_17', 'HGB_231_1_17', 'EGT');
  const jahreserg     = get('HGB_231_2_20', 'HGB_231_2_29', 'HGB_231_2_23', 'HGB_231_1_20', 'JAHRESUEBERSCHUSS_JAHRESFEHLBETRAG');

  // Alle 38 KPI-Keys aus extractKpis
  const checks = [
    hasVal(bilanzsumme),
    hasVal(anlageverm),
    hasVal(umlaufverm),
    hasVal(vorräte),
    hasVal(forderungen),
    hasVal(flüssig),
    hasVal(ek),
    hasVal(verbindl),
    hasVal(kvVerbindl),
    hasVal(rückstell),
    hasVal(langfrVerbindl),
    hasVal(umsatz),
    hasVal(personal),
    hasVal(abschreib),
    hasVal(betrErg),
    hasVal(egt),
    hasVal(jahreserg),
    // Quoten
    hasVal(ek) && hasVal(bilanzsumme),         // ekQuote
    hasVal(anlageverm) && hasVal(bilanzsumme), // anlageintensität
    hasVal(umlaufverm) && hasVal(bilanzsumme), // umlaufintensität
    hasVal(verbindl) && hasVal(ek),            // verschuldungsgrad
    hasVal(rückstell) && hasVal(bilanzsumme),  // rückstellungsquote
    (hasVal(verbindl) || hasVal(rückstell)) && hasVal(bilanzsumme), // fremdkapitalquote
    hasVal(ek) && hasVal(anlageverm),          // anlagendeckungI
    hasVal(ek) && hasVal(langfrVerbindl) && hasVal(anlageverm), // anlagendeckungII
    hasVal(umlaufverm) && hasVal(kvVerbindl),  // workingCapital
    hasVal(vorräte) && hasVal(umlaufverm),     // vorratsintensität
    hasVal(forderungen) && hasVal(umlaufverm), // forderungsintensität
    hasVal(flüssig) && hasVal(kvVerbindl),     // liquidität1
    hasVal(flüssig) && hasVal(forderungen) && hasVal(kvVerbindl), // liquidität2
    hasVal(umlaufverm) && hasVal(kvVerbindl),  // liquidität3
    hasVal(forderungen) && hasVal(umsatz),     // debitorenziel
    hasVal(kvVerbindl) && hasVal(umsatz),      // kreditorenziel
    hasVal(vorräte) && hasVal(umsatz),         // vorratsdauer
    hasVal(personal) && hasVal(umsatz),        // personalaufwandsquote
    hasVal(betrErg) && hasVal(umsatz),         // ebitMarge
    hasVal(jahreserg) && hasVal(umsatz),       // umsatzrendite
    hasVal(jahreserg) && hasVal(ek),           // roe
    hasVal(jahreserg) && hasVal(bilanzsumme),  // roa
    hasVal(betrErg) && hasVal(bilanzsumme),    // gesamtkapitalrendite
  ];

  return checks.filter(Boolean).length;
}

const results = rows.map(row => {
  const n = countFromPositions(row.positions);
  return { fnr: row.company_fnr, jahr: row.gj_jahr, n };
}).filter(r => r.n > 0);

results.sort((a, b) => b.n - a.n);

console.log('── Top 15 (aus', rows.length, 'gecachten Jahresabschlüssen) ──\n');
results.slice(0, 15).forEach((r, i) => {
  const name = db.prepare('SELECT name FROM company_names WHERE company_fnr = ? AND valid_to IS NULL LIMIT 1').get(r.fnr);
  console.log(`${i + 1}. ${r.n}/41 KPIs  ${r.fnr}  GJ${r.jahr}  ${name ? name.name : '—'}`);
});
