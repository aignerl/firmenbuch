# Firmenbuch

Eine Express.js-Webanwendung zur Recherche im österreichischen Firmenbuch. Die App verbindet sich mit dem SOAP-Webservice von JustizOnline, reichert die Daten durch Web-Scraping an und speichert alles in einer lokalen SQLite-Datenbank.

## Features

- **Firmensuche** – Volltextsuche mit Filtern nach Rechtsform und Bundesland
- **Firmendetail** – Stammdaten, Adressen, Funktionen (Geschäftsführer, Vorstand), Gesellschafterstruktur
- **Organigramm** – Interaktives D3.js-Diagramm der Beteiligungsstruktur (Gesellschafter & Töchter)
- **Jahresabschlüsse** – Automatische KPI-Berechnung aus XML-Urkunden (ROA, ROE, EK-Quote, Umsatzrendite u.v.m.)
- **Bestenliste** – Startseiten-Ranking der besten Firmen nach wählbarer Kennzahl mit Filtermöglichkeit
- **Urkunden** – Durchsuchen und Öffnen von Firmenbuchdokumenten (PDF & XML)
- **Datenbank-Cache** – Alle gescrapten Daten werden lokal in SQLite gespeichert inkl. vollständiger Änderungshistorie

## Voraussetzungen

- Node.js 18+
- API-Schlüssel für den [JustizOnline HVD SOAP-Webservice](https://www.data.gv.at/katalog/de/dataset/firmenbuch-hvd)

## Installation

```bash
git clone https://github.com/aignerl/firmenbuch.git
cd firmenbuch
npm install
cp .env.example .env
# FIRMENBUCH_API_KEY in .env eintragen
```

## Konfiguration

`.env`-Datei im Projektroot anlegen:

```env
FIRMENBUCH_API_KEY=dein_api_schluessel_hier
```

## Starten

```bash
# Standardport 3000
npm start

# Eigener Port
PORT=8080 npm start
```

Die App ist danach unter `http://localhost:3000` erreichbar.

## Datenbankbefüllung

Die SQLite-Datenbank wird beim ersten Start automatisch angelegt (`db/firmenbuch.db`). Daten werden über folgende Skripte befüllt:

### Tagesaktuelle Änderungen laden

```bash
# Die 20 zuletzt geänderten Firmen scrapen
node scripts/load-today.js 20
```

### Bulk-Load (vollständiger Erstimport)

Der Bulk-Load läuft in drei Phasen, die vollständig resumebar sind:

```bash
# Phase 1: FNR-Sammlung (alle Firmenbuchnummern seit 2000 einlesen)
node scripts/bulk-load.js phase1

# Phase 2: Stammdaten scrapen (SOAP + EVI)
node scripts/bulk-load.js phase2

# Phase 3: Jahresabschlüsse & KPIs berechnen
node scripts/bulk-load.js phase3

# Alle drei Phasen in einem Lauf
node scripts/bulk-load.js
```

Optionale Umgebungsvariablen für den Bulk-Load:

| Variable | Default | Beschreibung |
|---|---|---|
| `BULK_DELAY_MS` | `2000` | Pause zwischen API-Requests in ms |
| `BULK_BATCH_SIZE` | `500` | Firmen pro Lauf |
| `BULK_FROM` | `2000-01-01` | Startdatum für Phase 1 |

### Tägliche Synchronisation

```bash
node scripts/sync.js
```

## Datenbankschema (Überblick)

| Tabelle | Inhalt |
|---|---|
| `companies` | Stammdaten, Scrape-Status |
| `company_names` | Firmenwortlaute mit Umbenennungshistorie |
| `gesellschafter` | Gesellschafterbeziehungen mit Zeitverlauf |
| `personen_rollen` | Funktionen (GF, Vorstand, …) mit Zeitverlauf |
| `adressen` | Aktuelle Adressen |
| `jahresabschluesse` | Geparste KPIs + alle HGB-Positionen (`betrag`, `betragVJ`) |
| `kpi_scrape_status` | Phase-3-Fortschrittstracking |
| `soap_changes` | Rohe SOAP-Änderungsmeldungen |
| `sync_log` | Sync-Protokoll |

## API-Endpunkte

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/firma/suchen?name=` | Firmensuche |
| `GET` | `/api/firma/bestenliste?metric=roa&limit=20` | KPI-Ranking |
| `GET` | `/api/firma/:fnr/auszug` | SOAP-Auszug (JSON) |
| `GET` | `/api/firma/:fnr/urkunden` | Urkundenliste |
| `GET` | `/api/firma/:fnr/jahresabschluss?key=` | KPI-Auswertung eines XML-Jahresabschlusses |
| `GET` | `/api/firma/:fnr/baum` | Beteiligungsbaum |

### Bestenliste-Parameter

| Parameter | Optionen | Default |
|---|---|---|
| `metric` | `roa`, `roe`, `umsatzrendite`, `ek_quote` | `roa` |
| `limit` | 1–100 | `20` |
| `minBilanzsumme` | Betrag in EUR | `0` |
| `jahr` | Geschäftsjahr (z.B. `2023`) | letztes verfügbares Jahr |

## Technologie-Stack

- **Backend:** Node.js, Express.js
- **Datenbank:** SQLite via better-sqlite3
- **Templates:** Pug
- **Externe APIs:** JustizOnline SOAP (Firmenbuch HVD), EVI (Gesellschafterregister)
- **Parsing:** xml2js, cheerio
- **Frontend:** Vanilla JS, D3.js (Organigramm)

## Externe Datenquellen

- **JustizOnline HVD:** SOAP 1.2 Webservice unter `https://justizonline.gv.at/jop/api/at.gv.justiz.fbw/ws`
  Lizenz: [Open Government Data (CC BY 4.0)](https://www.data.gv.at/katalog/de/dataset/firmenbuch-hvd)
- **EVI (Ediktsdatei):** Web-Scraping der öffentlich zugänglichen Gesellschafterdaten

## Lizenz

Privates Projekt – keine öffentliche Lizenz.
