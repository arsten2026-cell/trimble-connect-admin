// "Администрация": data health report, change feed (from the records' history logs) and the JSON archive (pure, no network).
// Runs in the browser (window.ArstenHealth) and in Node tests.
//
// History lines, as the tools write them (status.js logLine, records.js / arsten-acceptance.js stamp, fabrication.js patchFor):
//   "2026-11-14 09:12 done: Formwork 2026-11-14 by Име Фамилия – ос 3"         (Pour status)
//   "2026-11-14 09:12 set: erected 2026-11-14 by Име Фамилия"                   (Steel asmstatus / asmhold)
//   "2026-11-14 09:12 created by Име Фамилия (typed): RF22=3"                   (Steel delivery)
//   "2026-11-14 09:12 round 1: approved by Име Фамилия – ok"                  (Acceptance decision)
//   "2026-11-14 09:12 FabDate=2026-11-01, DelivDate=2026-11-05 (fab.xlsx, Иван)" (AM_Fabrication: "(source, by)")
//   "2026-11-14 09:12 note: Formwork – текст by Име Фамилия"                    (Pour status note: the note BEFORE "by")
//   "2026-11-14 09:12 inherited: Formwork 2026-11-10 (A) from G – pour break, by Иван" (Pour status split)
// A note can hold " by " and can span several lines (continuation lines have no time stamp).
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  else root.ArstenHealth = lib;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Each tool cuts its own log at LOG_MAX (round 9, M10). A log longer than about 90 % of that is about to lose its
  // oldest lines. Keep in step with: status.js LOG_MAX (pourstatus), records.js LOG_MAX (asmstatus, asmhold, delivery),
  // fabrication.js LOG_MAX (fabstatus), arsten-acceptance.js LOG_MAX (acceptance, acceptdecision); test/health.test.js
  // reads those constants from the code and fails when they change.
  const LOG_MAX = { pourstatus: 4000, asmstatus: 4000, asmhold: 4000, delivery: 4000, fabstatus: 1500, acceptance: 6000, acceptdecision: 6000 };
  const LOG_SHARE = 0.9;
  /** Length above which a definition's log counts as "near the cap". */
  const logCap = (defId) => Math.floor((LOG_MAX[defId] || 4000) * LOG_SHARE);
  const TOOLS = {
    pourstatus: { bg: "Монолитен бетон", en: "Pour status" },
    photo: { bg: "Снимки", en: "Photos" },
    acceptance: { bg: "Авторски надзор", en: "Acceptance" },
    acceptdecision: { bg: "Авторски надзор", en: "Acceptance" },
    stages: { bg: "Етапи", en: "Stages" },
    asmstatus: { bg: "Стомана · монтаж", en: "Steel · erection" },
    asmhold: { bg: "Стомана · задържане", en: "Steel · hold" },
    delivery: { bg: "Стомана · доставки", en: "Steel · deliveries" },
    fabstatus: { bg: "Производство", en: "Fabrication" },
  };
  const toolOf = (defId) => TOOLS[defId] || { bg: defId, en: defId };

  // ---------- links ----------
  const ENTITY = "frn:entity:";
  /** IFC GUID of a model-object link, or null for our own record links (ARSTEN…-{project}-{id}). */
  function guidOf(link) {
    if (!String(link || "").startsWith(ENTITY)) return null;
    let g = link.slice(ENTITY.length);
    try { g = decodeURIComponent(g); } catch {}
    return /^[0-9A-Za-z_$]{22}$/.test(g) ? g : null;
  }
  /** A link with a raw "$" (must be "%24"): Connect's panel and Tekla never show such records. */
  const rawDollar = (link) => String(link || "").startsWith(ENTITY) && link.includes("$");
  const parseJson = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  /** GUIDs a record points to: its own link, or the objects listed inside it (acceptance, photos). */
  function guidsOf(link, props) {
    const own = guidOf(link);
    if (own) return [own];
    return [...new Set(parseJson(props && props.objects).map((o) => o && o.guid).filter(Boolean))];
  }
  /** Short human label of a record: pour / mark / delivery note / caption. */
  function labelOf(defId, link, props) {
    const p = props || {};
    if (defId === "delivery") return p.note_no ? `№ ${p.note_no}` : (p.lines || "").slice(0, 40);
    if (defId === "photo") return p.labels || p.caption || p.file_name || "";
    if (defId === "stages") return "";
    return p.pour || p.mark || guidOf(link) || "";
  }

  // ---------- log parser ----------
  const LINE = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)(?::\d\d)?\s+([\s\S]*)$/;
  const STAMP = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)/;   // a date-time field ("uploaded", "updated")
  const NOTE = " – ";   // the tools put a note after " – "
  /** Every "by NAME" in a text: [{name, stop, end}]; NAME runs to " (", ": ", " – ", " - ", a line break or the end. */
  function bys(text) {
    const out = [], re = /(?:^|[\s,])by\s+/g;
    for (let m; (m = re.exec(text));) {
      const rest = text.slice(m.index + m[0].length);
      const stop = /\s\(|:\s|:$|\s–\s|\s-\s|\n/.exec(rest);
      out.push({ name: (stop ? rest.slice(0, stop.index) : rest).trim().replace(/[.,;]$/, ""), stop: stop ? stop[0].trim() : "", end: !stop });
    }
    return out;
  }
  /** who of an AM_Fabrication line: the last part of the trailing "(source, by)"; the source may hold "(1)" itself. */
  function fabWho(what) {
    const first = what.split("\n")[0].trim();
    if (!first.endsWith(")")) return "";
    const inner = first.slice(0, -1), comma = inner.lastIndexOf(", ");
    return comma < 0 ? "" : inner.slice(comma + 2).trim();
  }
  /**
   * One history entry (a line plus its continuation lines) -> {date, time, who, what}, or null when it does not start
   * with "YYYY-MM-DD HH:MM". defId (optional) names the definition the log belongs to.
   * who (round 9, low 15):
   *  - AM_Fabrication (fabrication.js "Field=value, … (source, by)"): the part after the last ", " of the trailing
   *    "(…)", so a source "fab (1).xlsx" or a DelivNote with "by" in it does not matter;
   *  - the rest: the "by NAME" of the action part = the text before the first " – " (a note never decides the name).
   *    When the action part has no "by" (pour-status "note:" and "inherited:" lines put "by" after the note), the
   *    last "by NAME" of the entry.
   */
  function parseLogLine(line, defId) {
    const m = LINE.exec(String(line || "").trim());
    if (!m) return null;
    const what = m[3].trim();
    let who = "";
    const fab = defId === "fabstatus" || (!defId && /^[A-Za-z]\w*=/.test(what) && /\)$/.test(what.split("\n")[0].trim()));
    if (fab) who = fabWho(what);
    else {
      const cut = what.indexOf(NOTE);
      const action = (cut < 0 ? what : what.slice(0, cut)).split("\n")[0];
      // the first "by NAME" that ends the action part or is followed by " (" / ":" (records.js "created by X (typed): lines")
      const own = bys(action).find((b) => b.end || b.stop === "(" || b.stop === ":");
      if (own) who = own.name;
      else if (cut >= 0) { const all = bys(what.slice(cut + NOTE.length)); if (all.length) who = all[all.length - 1].name; }
    }
    if (who === "?") who = "";
    return { date: m[1], time: m[2], who, what };
  }
  /** Every entry of a log text, oldest first. A line without a time stamp continues the entry above it (multi-line
   *  notes are kept); lines before the first entry are skipped. */
  function parseLog(text, defId) {
    const entries = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const t = raw.trim();
      if (LINE.test(t)) entries.push(t);
      else if (entries.length && t) entries[entries.length - 1] += "\n" + t;
    }
    return entries.map((e) => parseLogLine(e, defId)).filter(Boolean);
  }
  /** Local {date: "YYYY-MM-DD", time: "HH:MM"} of a UTC time text ("2026-11-14 07:12", ISO with or without Z);
   *  null when it is not a time. */
  function utcToLocal(text) {
    const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d)(:\d\d(?:\.\d+)?)?(Z|[+-]\d\d:?\d\d)?$/.exec(String(text || "").trim());
    if (!m) return null;
    const d = new Date(`${m[1]}T${m[2]}${m[3] || ":00"}${m[4] || "Z"}`);
    if (isNaN(d)) return null;
    const p = (n) => String(n).padStart(2, "0");
    return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
  }

  /**
   * The change feed from loaded records.
   * @param records [{lib, def, link, props}]
   * @param opts {since: "YYYY-MM-DD" (inclusive)}
   * @returns [{date, time, who, tool:{bg,en}, def, lib, link, label, what, guids}] newest first
   */
  function feed(records, opts) {
    const since = (opts && opts.since) || "";
    const out = [];
    for (const r of records || []) {
      const p = r.props || {};
      const base = { def: r.def, lib: r.lib, link: r.link, tool: toolOf(r.def), label: labelOf(r.def, r.link, p), guids: guidsOf(r.link, p) };
      for (const e of parseLog(p.log, r.def)) if (e.date >= since) out.push(Object.assign({}, base, e));
      // photos and stages keep no log: their own date + by fields are the event
      if (r.def === "photo" && p.uploaded) {
        const m = STAMP.exec(String(p.uploaded));
        if (m && m[1] >= since) out.push(Object.assign({}, base, { date: m[1], time: m[2], who: p.by || "", what: p.deleted ? "photo (deleted)" : `photo${p.purpose ? " · " + p.purpose : ""}${p.caption ? " – " + p.caption : ""}` }));
      }
      // stages.js writes "updated" in UTC (toISOString); the logs are local time (round 9, low 15)
      if (r.def === "stages" && p.updated) {
        const t = utcToLocal(p.updated);
        if (t && t.date >= since) out.push(Object.assign({}, base, { date: t.date, time: t.time, who: p.by || "", what: "stages updated" }));
      }
    }
    return out.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : a.date + a.time > b.date + b.time ? -1 : 0));
  }
  /** "YYYY-MM-DD" n days before now (local). */
  function daysAgo(n, now) {
    const d = new Date((now || new Date()).getTime());
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  /** Feed rows filtered by person and tool (empty = all). */
  const filterFeed = (rows, who, tool) => rows.filter((r) => (!who || r.who === who) && (!tool || r.tool.bg === tool || r.tool.en === tool));

  // ---------- health ----------
  const TEXT_FIELD = /(note|log|comment|caption|reason|DelivNote)$/i;
  /** Test leftovers: any value with "UI-TEST", or a note / log / comment text containing the word TEST. */
  function testHit(props) {
    for (const [k, v] of Object.entries(props || {})) {
      if (typeof v !== "string") continue;
      if (v.includes("UI-TEST")) return `${k}: UI-TEST`;
      if (TEXT_FIELD.test(k) && /\bTEST\b/.test(v)) return `${k}: TEST`;
    }
    return null;
  }

  /** A link encoded twice ("%2524" = "%24" encoded again): no tool and no Connect panel finds that record. */
  const doubleEncoded = (link) => String(link || "").startsWith(ENTITY) && /%25[0-9A-Fa-f]{2}/.test(link);

  /**
   * Health of every library/definition.
   * @param records [{lib, def, link, props}]
   * @param check what the model check found: null when no model is loaded (orphans not checked); a Set of the IFC GUIDs
   *   found; or {present: Set, unknown: Set}, unknown = GUIDs not found that cannot be called orphans (their lookup
   *   failed, or some project models are not loaded). Those count as "unknown", never as orphans (round 9, M11).
   * @param noAccess optional Set (or array) of "lib|def" whose records could not be read (403, round 11 L9): their rows
   *   carry noAccess: true and say "няма достъп" instead of counts.
   * @returns {rows:[{lib, def, count, raw, double, test, longLogs, orphans|null, unknown|null, noAccess?}], issues:[{lib, def, kind, link, label, detail, guids}]}
   */
  function health(records, check, defsByLib, noAccess) {
    const present = check instanceof Set ? check : check && check.present ? check.present : null;
    const unknownSet = (check && !(check instanceof Set) && check.unknown) || new Set();
    const rows = new Map(), issues = [];
    const key = (l, d) => l + "|" + d;
    const blank = (lib, def) => ({ lib, def, count: 0, raw: 0, double: 0, test: 0, longLogs: 0, orphans: present ? 0 : null, unknown: present ? 0 : null });
    for (const [libName, defs] of Object.entries(defsByLib || {})) for (const d of defs) rows.set(key(libName, d), blank(libName, d));
    for (const r of records || []) {
      const k = key(r.lib, r.def);
      if (!rows.has(k)) rows.set(k, blank(r.lib, r.def));
      const row = rows.get(k), p = r.props || {};
      const issue = (kind, detail) => issues.push({ lib: r.lib, def: r.def, kind, link: r.link, label: labelOf(r.def, r.link, p), detail, guids: guidsOf(r.link, p) });
      row.count++;
      if (rawDollar(r.link)) { row.raw++; issue("raw", "„$“ → „%24“"); }
      if (doubleEncoded(r.link)) { row.double++; issue("double", "„%2524“ → „%24“"); }
      const t = testHit(p);
      if (t) { row.test++; issue("test", t); }
      if (typeof p.log === "string" && p.log.length > logCap(r.def)) { row.longLogs++; issue("log", `${p.log.length} / ${LOG_MAX[r.def] || 4000}`); }
      const g = guidOf(r.link);
      if (present && g && !present.has(g)) {
        if (unknownSet.has(g)) row.unknown++;
        else { row.orphans++; issue("orphan", g); }
      }
    }
    for (const k of noAccess || []) {
      const i = k.indexOf("|"), lib = k.slice(0, i), def = k.slice(i + 1);
      if (!rows.has(k)) rows.set(k, blank(lib, def));
      Object.assign(rows.get(k), { noAccess: true, orphans: null, unknown: null });
    }
    return { rows: [...rows.values()], issues };
  }

  // ---------- export ----------
  // a text starting with = + - @ (or tab / CR) is a formula to Excel: prefix "'" so it stays text (round 9, low 16)
  const cell = (v) => {
    let s = String(v == null ? "" : v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const KIND = { raw: ["Суров „$“ линк", "Raw \"$\" link"], double: ["Двойно кодиран линк (%2524)", "Double-encoded link (%2524)"], test: ["Тестов запис", "Test leftover"], log: ["Дълга история", "Log near the cap"], orphan: ["Сирак (няма обект)", "Orphan (no object)"] };
  /** CSV for Excel: ";" separated, UTF-8 with BOM, summary first then one row per issue. */
  function toCsv(report, lang) {
    const en = lang === "en";
    const lines = [];
    lines.push([en ? "Library" : "Библиотека", en ? "Definition" : "Дефиниция", en ? "Records" : "Записи", en ? "Raw $ links" : "Сурови $", "%2524", en ? "Test" : "Тестови", en ? "Long logs" : "Дълги истории", en ? "Orphans" : "Сираци", en ? "Unknown" : "Неизвестни"].map(cell).join(";"));
    const nc = en ? "not checked" : "непроверено";
    const na = en ? "no access" : "няма достъп";
    for (const r of report.rows) if (r.noAccess) lines.push([r.lib, r.def, na, na, na, na, na, na, na].map(cell).join(";"));
    else lines.push([r.lib, r.def, r.count, r.raw, r.double || 0, r.test, r.longLogs, r.orphans == null ? nc : r.orphans, r.unknown == null ? nc : r.unknown].map(cell).join(";"));
    lines.push("");
    lines.push([en ? "Library" : "Библиотека", en ? "Definition" : "Дефиниция", en ? "Problem" : "Проблем", en ? "Link" : "Линк", en ? "Pour / mark" : "Такт / марка", en ? "Detail" : "Подробно"].map(cell).join(";"));
    for (const i of report.issues) lines.push([i.lib, i.def, KIND[i.kind] ? KIND[i.kind][en ? 1 : 0] : i.kind, i.link, i.label, i.detail].map(cell).join(";"));
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  /** The archive: every record of both libraries with its link, the definitions and the libraries (with policies). */
  function archive(meta, libraries) {
    return {
      kind: "arsten-connect-archive", version: 1, created: meta && meta.created, project: meta && meta.project,
      libraries: (libraries || []).map((l) => ({ id: l.id, name: l.name, policy: l.policy || null,
        definitions: (l.definitions || []).map((d) => Object.assign({ id: d.id, definition: d.definition || null, records: (d.records || []).map((r) => ({ link: r.link, props: r.props })) },
          d.noAccess ? { noAccess: true } : {})) })),
    };
  }

  return { LOG_MAX, LOG_SHARE, logCap, utcToLocal, doubleEncoded, TOOLS, toolOf, guidOf, rawDollar, guidsOf, labelOf, parseLogLine, parseLog, feed, daysAgo, filterFeed, testHit, health, toCsv, archive, KIND };
});
