'use strict';
const xml2js = require('xml2js');

const parser = new xml2js.Parser({
  explicitArray: true,
  tagNameProcessors: [xml2js.processors.stripPrefix],
  trim: true,
});

function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function parseFloatSafe(s) {
  if (s === null || s === undefined || s === '') return null;
  const n = parseFloat(String(s).replace(',', '.'));
  return isNaN(n) ? null : n;
}

/**
 * Walk the parsed XML tree.
 * Structure: <HGB_224_2> (position code as tag) > <POSTENZEILE> > <BETRAG> / <BETRAG_VJ>
 * Returns positions map: { 'HGB_224_2': { betrag, betragVJ }, ... }
 */
function collectPositions(node, parentKey, positions) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach(item => collectPositions(item, parentKey, positions));
    return;
  }

  for (const [key, val] of Object.entries(node)) {
    if (key === '$') continue;
    const upperKey = key.toUpperCase();

    if (upperKey === 'POSTENZEILE') {
      // parentKey is the position code
      const items = toArr(val);
      for (const pz of items) {
        if (!pz || typeof pz !== 'object' || Array.isArray(pz)) continue;
        // old format: BETRAG / BETRAG_VJ  —  new format (v4): BETRAG_GJ / BETRAG_VJ
        const betragKey = Object.keys(pz).find(k => k.toUpperCase() === 'BETRAG' || k.toUpperCase() === 'BETRAG_GJ');
        const vjKey     = Object.keys(pz).find(k => k.toUpperCase() === 'BETRAG_VJ');
        const betrag    = betragKey ? parseFloatSafe(toArr(pz[betragKey]).find(v => typeof v === 'string')) : null;
        const betragVJ  = vjKey     ? parseFloatSafe(toArr(pz[vjKey]).find(v => typeof v === 'string'))     : null;
        if (betrag !== null || betragVJ !== null) {
          positions[parentKey] = { betrag, betragVJ };
        }
      }
    } else {
      collectPositions(val, upperKey, positions);
    }
  }
}

/**
 * Find a single string value by uppercase tag name anywhere in the tree.
 */
function findStr(node, upperTag) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) { const r = findStr(item, upperTag); if (r !== null) return r; }
    return null;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key.toUpperCase() === upperTag) {
      const found = toArr(val).find(v => typeof v === 'string');
      if (found !== undefined) return found.trim();
    }
    const r = findStr(val, upperTag);
    if (r !== null) return r;
  }
  return null;
}

/**
 * Parses an Austrian FinanzOnline Jahresabschluss XML (UEBERMITTLUNG format).
 *
 * XML structure:
 *   <UEBERMITTLUNG>
 *     <BILANZ_GLIEDERUNG>
 *       <ALLG_JUSTIZ>
 *         <GJ><BEGINN>...</BEGINN><ENDE>...</ENDE></GJ>
 *         <VOR_GJ><WERT_TSD>j</WERT_TSD></VOR_GJ>   ← VJ-Werte in Tausend wenn "j"
 *       </ALLG_JUSTIZ>
 *       <BILANZ>
 *         <HGB_224_2>                ← Positionscode = Tag-Name
 *           <POSTENZEILE>
 *             <BETRAG>...</BETRAG>
 *             <BETRAG_VJ>...</BETRAG_VJ>
 *           </POSTENZEILE>
 *         </HGB_224_2>
 *       </BILANZ>
 *       <GUV>...</GUV>
 *     </BILANZ_GLIEDERUNG>
 *   </UEBERMITTLUNG>
 *
 * Returns { gj, kpis, positions }
 */
async function parseJahresabschluss(xmlBuffer) {
  let xmlString = xmlBuffer.toString('latin1');
  xmlString = xmlString.replace(/(encoding\s*=\s*["'])ISO-8859-1(["'])/i, '$1UTF-8$2');

  const parsed = await parser.parseStringPromise(xmlString);

  // ── Period ─────────────────────────────────────────────────────
  const beginn = findStr(parsed, 'BEGINN');
  const ende   = findStr(parsed, 'ENDE');
  const gj = (beginn || ende) ? {
    beginn: beginn || '',
    ende:   ende   || '',
    jahr:   parseInt((ende || beginn || '').slice(0, 4)) || null,
  } : null;

  // ── WERT_TSD: applies only to BETRAG_VJ ────────────────────────
  const wertTsd = findStr(parsed, 'WERT_TSD') || '';
  const vjMultiplier = wertTsd.toLowerCase() === 'j' ? 1000 : 1;

  // ── Collect positions ───────────────────────────────────────────
  const rawPositions = {};
  collectPositions(parsed, '', rawPositions);

  // Apply VJ multiplier
  const positions = {};
  for (const [code, { betrag, betragVJ }] of Object.entries(rawPositions)) {
    positions[code] = {
      betrag,
      betragVJ: betragVJ !== null ? betragVJ * vjMultiplier : null,
    };
  }

  const kpis = extractKpis(positions);
  return { gj, kpis, positions };
}

function deriveRatio(numerator, denominator, scale = 100) {
  const betrag = (numerator?.betrag != null && denominator?.betrag)
    ? numerator.betrag / denominator.betrag * scale : null;
  const betragVJ = (numerator?.betragVJ != null && denominator?.betragVJ)
    ? numerator.betragVJ / denominator.betragVJ * scale : null;
  return (betrag !== null || betragVJ !== null) ? { betrag, betragVJ } : null;
}

function extractKpis(positions) {
  // ── Bilanz ──────────────────────────────────────────────────────
  const bilanzsumme                = positions['HGB_224_2']           || positions['AKTIVA']                    || null;
  const anlagevermögen             = positions['HGB_224_2_A']         || positions['ANLAGEVERMÖGEN']            || null;
  const umlaufvermögen             = positions['HGB_224_2_B']         || positions['UMLAUFVERMÖGEN']            || null;
  const vorräte                    = positions['HGB_224_2_B_I']       || positions['VORRAETE']                  || null;
  const forderungen                = positions['HGB_224_2_B_II']      || positions['FORDERUNGEN']               || null;
  const flüssigeMittel             = positions['HGB_224_2_B_IV']      || positions['FLUESSIGE_MITTEL']          || null;
  const eigenkapital               = positions['HGB_224_3_A']         || positions['EIGENKAPITAL']              || null;
  const verbindlichkeiten          = positions['HGB_224_3_D']         || positions['VERBINDLICHKEITEN']         || null;
  const kurzfristigeVerbindlichkeiten = positions['HGB_224_3_D_HGB_225B'] || positions['VERBINDLICHKEITEN_KFR'] || null;

  // ── GuV ─────────────────────────────────────────────────────────
  const umsatz = positions['HGB_231_2_1']
              || positions['HGB_231_1_1']
              || positions['UMSATZERLOESE'] || null;

  const personalaufwand = positions['HGB_231_2_6']
                       || positions['HGB_231_1_6']
                       || positions['PERSONALAUFWAND'] || null;

  const abschreibungen = positions['HGB_231_2_7']
                      || positions['HGB_231_1_7']
                      || positions['ABSCHREIBUNGEN'] || null;

  const betriebsergebnis = positions['HGB_231_2_9']
                        || positions['HGB_231_1_9']
                        || positions['BETRIEBSERGEBNIS'] || null;

  const egt = positions['HGB_231_2_17']
           || positions['HGB_231_1_17']
           || positions['EGT'] || null;

  const jahresergebnis = positions['HGB_231_2_20']
                      || positions['HGB_231_2_29']
                      || positions['HGB_231_2_23']
                      || positions['HGB_231_1_20']
                      || positions['JAHRESUEBERSCHUSS_JAHRESFEHLBETRAG'] || null;

  // ── Abgeleitete Kennzahlen ───────────────────────────────────────
  const ekQuote          = deriveRatio(eigenkapital,    bilanzsumme);
  const anlageintensität = deriveRatio(anlagevermögen,  bilanzsumme);
  const verschuldungsgrad= deriveRatio(verbindlichkeiten, eigenkapital);
  const roe              = deriveRatio(jahresergebnis,  eigenkapital);
  const roa              = deriveRatio(jahresergebnis,  bilanzsumme);
  const umsatzrendite    = (umsatz?.betrag) ? deriveRatio(jahresergebnis, umsatz) : null;

  // ── Liquidität (nur wenn kurzfristige Verbindlichkeiten verfügbar) ─
  const liquidität1 = kurzfristigeVerbindlichkeiten
    ? deriveRatio(flüssigeMittel, kurzfristigeVerbindlichkeiten) : null;

  const liquidität2 = (kurzfristigeVerbindlichkeiten && forderungen)
    ? (() => {
        const add = (a, b) => a !== null && b !== null ? a + b : (a ?? b);
        return deriveRatio(
          { betrag:   add(flüssigeMittel?.betrag,   forderungen?.betrag),
            betragVJ: add(flüssigeMittel?.betragVJ, forderungen?.betragVJ) },
          kurzfristigeVerbindlichkeiten
        );
      })()
    : null;

  const liquidität3 = kurzfristigeVerbindlichkeiten
    ? deriveRatio(umlaufvermögen, kurzfristigeVerbindlichkeiten) : null;

  return {
    bilanzsumme, anlagevermögen, umlaufvermögen,
    vorräte, forderungen, flüssigeMittel,
    eigenkapital, ekQuote, anlageintensität,
    verbindlichkeiten, verschuldungsgrad,
    liquidität1, liquidität2, liquidität3,
    umsatz, personalaufwand, abschreibungen,
    betriebsergebnis, egt,
    jahresergebnis, umsatzrendite, roe, roa,
  };
}

module.exports = { parseJahresabschluss };
