'use strict';
const { extractKpis } = require('../services/jahresabschluss');
const db = require('../services/db').getDb();

const rows = db.prepare('SELECT company_fnr, gj_jahr, positions FROM jahresabschluesse WHERE positions IS NOT NULL').all();

let totalEntries = 0;
let improved = 0;       // mehr KPIs als vorher (alte kpis aus cache)
let formatA = 0;        // HGB-Codes (z.B. HGB_224_2)
let formatB = 0;        // Klartext-Codes (z.B. ANLAGEVERMOEGEN)
let formatMixed = 0;

const beforeBuckets = {};
const afterBuckets  = {};

for (const row of rows) {
  let pos, oldKpis;
  try {
    pos = JSON.parse(row.positions);
    const cached = db.prepare('SELECT kpis FROM jahresabschluesse WHERE company_fnr = ? AND gj_jahr = ?').get(row.company_fnr, row.gj_jahr);
    oldKpis = cached ? JSON.parse(cached.kpis) : {};
  } catch (e) { continue; }

  const newKpis = extractKpis(pos);
  const oldN = Object.values(oldKpis).filter(v => v && (v.betrag !== null || v.betragVJ !== null)).length;
  const newN = Object.values(newKpis).filter(v => v && (v.betrag !== null || v.betragVJ !== null)).length;

  beforeBuckets[oldN] = (beforeBuckets[oldN] || 0) + 1;
  afterBuckets[newN]  = (afterBuckets[newN]  || 0) + 1;

  if (newN > oldN) improved++;

  // Format erkennen
  const hasHGB = Object.keys(pos).some(k => k.startsWith('HGB_'));
  const hasKlar = Object.keys(pos).some(k => k === 'ANLAGEVERMOEGEN' || k === 'UMLAUFVERMOEGEN');
  if (hasHGB && hasKlar) formatMixed++;
  else if (hasHGB) formatA++;
  else if (hasKlar) formatB++;

  totalEntries++;
}

console.log('Gesamt gecachte Jahresabschlüsse:', totalEntries);
console.log('Davon verbessert durch Fix:       ', improved, '(' + Math.round(improved/totalEntries*100) + '%)');
console.log('\nXML-Format:');
console.log('  HGB-Codes (HGB_224_x):          ', formatA);
console.log('  Klartext-Codes (ANLAGEVERMOEGEN):', formatB);
console.log('  Gemischt:                        ', formatMixed);
console.log('  Sonstige:                        ', totalEntries - formatA - formatB - formatMixed);

console.log('\nVorher — Verteilung verfügbarer KPIs:');
Object.keys(beforeBuckets).sort((a,b)=>+b-+a).slice(0,8).forEach(k => console.log('  ' + k + ' KPIs: ' + beforeBuckets[k] + 'x'));

console.log('\nNachher — Verteilung verfügbarer KPIs:');
Object.keys(afterBuckets).sort((a,b)=>+b-+a).slice(0,8).forEach(k => console.log('  ' + k + ' KPIs: ' + afterBuckets[k] + 'x'));
