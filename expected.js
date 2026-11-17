// "Администрация": what every Arsten / Multiplan project must contain (AM_TEMPLATE.md, the official template), as data,
// plus the pure checks on it. No network calls: runs in the browser (window.ArstenExpected) and in Node tests.
//
// Library access policies use Connect's own format (what "Library access control" writes, see shared/README.md):
//   we:libdef:v1   principal {any:["project:P"], notAny:["group:G", ...]}  default for members not in a listed group
//   we:groupdef:v1 principal {all:["project:P","group:G"]}                 a group's default; resource "*" or
//                                                                          {notAny:[defs with their own rule]}
//   we:psetspec:v1 principal {all:["project:P","group:G"]}                 per-definition rule, resource {any:[defs]}
//   we:projadm:v1  principal "project:P:ADMIN"                              library management (no pset:PutPSet)
// Edit = Get*/List*/PutPSet/Subscribe, Read = Get*/List*/Subscribe, No access = GetLibrary only.
// buildPolicy() reproduces, statement for statement, the policies PUT on AM_TEMPLATE on 16.11.2026 (test/*.json).
(function (root, factory) {
  const node = typeof module === "object" && module.exports;
  // group names are matched with ArstenAccess.groupKey (shared/arsten-access.js, loaded before this file)
  const access = node ? require("./arsten-access.js") : root.ArstenAccess;
  const lib = factory(access);
  if (node) module.exports = lib;
  else root.ArstenExpected = lib;
})(typeof self !== "undefined" ? self : this, function (ArstenAccess) {
  "use strict";

  const GROUPS = ["00_ADMIN", "01.CLIENT", "02.GENERAL CONTRACTOR", "02.1-EXECUTION PROJECT MANAGER", "03.SUBCONTRACTORS",
    "04.DESIGNERS", "4.1-STRUCTURAL DESIGNER", "05.VIEWERS", "06.FABRICATOR"];
  const ADMIN_GROUP = "00_ADMIN";

  // Access rows: lib = the group's level on the library; defs = per-definition rules. Row order = statement order.
  // A rule equal to the library level is still a rule when Connect stored one (4.1 / acceptance: Read on Read), so the
  // rebuilt policy is the same statement for statement.
  const LIBRARIES = [
    {
      key: "cip", name: "CIP/Монолитно", oldNames: ["Arsten Pour Status"],
      defs: [
        { id: "stages", bg: "Етапи", en: "Stages", body: "stages" },
        { id: "photo", bg: "Снимки", en: "Photo", body: "photo" },
        { id: "acceptance", bg: "Приемане", en: "Acceptance", body: "acceptance" },
        { id: "pourstatus", bg: "Статус такт", en: "Pour status", body: "pourstatus" },
        { id: "acceptdecision", bg: "Решение", en: "Decision", body: "acceptdecision" },
      ],
      access: {
        default: { lib: "read", defs: {} },
        groups: [
          { group: "02.GENERAL CONTRACTOR", lib: "edit", defs: { stages: "read", acceptdecision: "read" } },
          { group: "00_ADMIN", lib: "edit", defs: { acceptdecision: "read" } },
          { group: "4.1-STRUCTURAL DESIGNER", lib: "read", defs: { acceptance: "read", acceptdecision: "edit" } },
          { group: "02.1-EXECUTION PROJECT MANAGER", lib: "edit", defs: { acceptdecision: "read" } },
        ],
      },
    },
    {
      key: "steel", name: "STEEL/Монтаж", oldNames: ["STEEL/Montazh"],
      defs: [
        { id: "delivery", bg: "Доставки", en: "Delivery", body: "delivery" },
        { id: "fabstatus", bg: "AM_Fabrication", en: "AM_Fabrication", body: "fabstatus" },
        { id: "asmstatus", bg: "Статус сглобка", en: "Assembly status", body: "asmstatus" },
        { id: "asmhold", bg: "Задържане", en: "Assembly hold", body: "asmhold" },
      ],
      access: {
        default: { lib: "none", defs: {} },
        groups: [
          { group: "00_ADMIN", lib: "edit", defs: {} },
          { group: "02.GENERAL CONTRACTOR", lib: "edit", defs: {} },
          { group: "02.1-EXECUTION PROJECT MANAGER", lib: "edit", defs: {} },
          { group: "04.DESIGNERS", lib: "read", defs: { asmhold: "edit" } },
          { group: "4.1-STRUCTURAL DESIGNER", lib: "read", defs: { asmhold: "edit" } },
          { group: "06.FABRICATOR", lib: "none", defs: { fabstatus: "edit" } },
        ],
      },
    },
  ];

  // Projects whose access differs from the template ON PURPOSE: the panel only reports the differences (yellow,
  // "различно по избор") and never offers "Пренапиши правата" for the listed libraries. Add a row per project.
  //   projectId: Connect project id; name: for people; libs: LIBRARIES keys; why: shown next to the differences.
  const REPORT_ONLY = [
    { projectId: "ZDLr1OnpvtE", name: "1028", libs: ["steel"],
      why: { bg: "1028 има свои правила в STEEL (AM_TEMPLATE.md: 1028 не се променя)", en: "1028 keeps its own STEEL rules (AM_TEMPLATE.md: 1028 is not changed)" } },
  ];
  /** The REPORT_ONLY row for a project's library, or null. */
  const reportOnly = (projectId, libKey) => REPORT_ONLY.find((r) => r.projectId === projectId && r.libs.includes(libKey)) || null;

  const FOLDERS = [
    "_ArstenDocs/Photos", "_ArstenDocs/Fabrication", "_ArstenDocs/Submittals", "_ArstenDocs/Transmittals", "_ArstenDocs/Backups", "_ArstenDocs/Client",
    "01_BIM",
    "03_DESIGN/03_TECHNICAL LIVE MODELS", "03_DESIGN/04_STRUCTURAL DESIGN EXPORT MODELS",
    "04_EXECUTION/00_MODELS", "04_EXECUTION/01_ЗА СТАНЦИЯ", "04_EXECUTION/20_FORMWORK PLANS",
    "04_EXECUTION/30_REINFORCEMENT PLANS/LATEST DRAWINGS", "04_EXECUTION/30_REINFORCEMENT PLANS/ORDERS",
    "Point clouds", "ЗА СТРОИТЕЛСТВО",
  ];

  const ACTIONS = {
    edit: ["pset:Get*", "pset:List*", "pset:PutPSet", "pset:Subscribe"],
    read: ["pset:Get*", "pset:List*", "pset:Subscribe"],
    none: ["pset:GetLibrary"],
  };
  const PROJADM_ACTIONS = ["pset:GetLibrary*", "pset:UpdateLibrary*", "pset:CreateDef", "pset:GetDef*", "pset:ListDefs", "pset:UpdateDef", "pset:ValidatePSets", "pset:Subscribe"];
  const LEVELS = ["none", "read", "edit"];
  const better = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

  /** Definition bodies from the tools' own code. mods: {PourStatus, ArstenStages, ArstenPhotos, ArstenAcceptance, SteelRecords, SteelFab}. */
  function definitionBodies(mods) {
    const m = mods || {};
    const out = {};
    const put = (d) => { if (d && d.id) out[d.id] = d; };
    if (m.PourStatus) put(m.PourStatus.definition());
    if (m.ArstenStages) put(m.ArstenStages.definition());
    if (m.ArstenPhotos) put(m.ArstenPhotos.definition());
    if (m.ArstenAcceptance) { put(m.ArstenAcceptance.definition()); put(m.ArstenAcceptance.decisionDefinition()); }
    if (m.SteelRecords) m.SteelRecords.definitions().forEach(put);
    if (m.SteelFab) put(m.SteelFab.definition());
    return out;
  }

  // ---------- policy ----------
  /**
   * The library policy for a project (pure).
   * @param projectId Connect project id
   * @param groupIdsByName {"00_ADMIN": "id", ...}; a group without an id is left out of the policy
   * @param libSpec one of LIBRARIES (its .access is used)
   */
  function buildPolicy(projectId, groupIdsByName, libSpec) {
    const P = "project:" + projectId;
    const acc = libSpec.access;
    const ids = groupIdsByName || {};
    const rows = acc.groups.filter((r) => ids[r.group]);
    const st = [];
    const rule = (id, principal, level, resource) => ({ id, effect: "Allow", principal, action: ACTIONS[level].slice(), resource });
    // per-definition rules, grouped by level in the order of their first (sorted) definition
    const specs = (defs) => {
      const names = Object.keys(defs).sort();
      const byLevel = new Map();
      for (const d of names) { if (!byLevel.has(defs[d])) byLevel.set(defs[d], []); byLevel.get(defs[d]).push(d); }
      return [...byLevel].map(([level, list]) => ({ level, list }));
    };
    const scoped = (level, defs) => (level === "none" || !Object.keys(defs).length ? "*" : { notAny: Object.keys(defs).sort() });

    const defPrincipal = { any: [P], notAny: rows.map((r) => "group:" + ids[r.group]) };
    st.push(rule("we:libdef:v1", defPrincipal, acc.default.lib, scoped(acc.default.lib, acc.default.defs)));
    for (const s of specs(acc.default.defs)) st.push(rule("we:psetspec:v1", { any: [P], notAny: defPrincipal.notAny.slice() }, s.level, { any: s.list }));
    for (const r of rows) {
      const principal = () => ({ all: [P, "group:" + ids[r.group]] });
      st.push(rule("we:groupdef:v1", principal(), r.lib, scoped(r.lib, r.defs)));
      for (const s of specs(r.defs)) st.push(rule("we:psetspec:v1", principal(), s.level, { any: s.list }));
    }
    st.push({ id: "we:projadm:v1", effect: "Allow", principal: P + ":ADMIN", action: PROJADM_ACTIONS.slice(), resource: ["*"] });
    return { id: "we:acpol:v1", version: "2020-04-06", statements: st };
  }

  const list = (v) => [].concat(v == null ? [] : v);
  function levelOf(actions) {
    const a = list(actions);
    if (a.some((x) => x === "*" || /^pset:(PutPSet|\*)$/i.test(x))) return "edit";
    if (a.some((x) => /^pset:(Get\*|GetPSet\*?|List\*|ListPSets)$/i.test(x))) return "read";
    return "none";
  }
  function covers(resource, defId) {
    if (resource === "*" || resource == null) return true;
    if (Array.isArray(resource)) return resource.includes("*") || resource.includes(defId);
    if (typeof resource === "object") {
      if (resource.any) return list(resource.any).includes(defId) || list(resource.any).includes("*");
      if (resource.notAny) return !list(resource.notAny).includes(defId);
    }
    return resource === defId;
  }
  const UNLISTED = "\u0000library";   // a definition no rule names: the "Library" column

  /**
   * Effective access in a policy, per group id and for the default ("members not in a listed group").
   * @returns {default: {lib, defs:{id: level}}, groups: {groupId: {lib, defs}}, listedGroups: [ids], projadm: bool}
   */
  function effectiveAccess(policy, projectId, defIds) {
    const P = "project:" + projectId;
    const statements = (policy && policy.statements) || [];
    const groupOf = (p) => { const g = list(p).find((x) => /^group:/.test(x)); return g ? g.slice(6) : null; };
    // Default rule (every project member): the string "*" or "project:P", or {any: [...]} naming "*" or "project:P"
    // (review round 9, M9: the string forms were ignored, so "*: Edit" on STEEL still looked green).
    const isDefault = (p) => p === "*" || p === P || !!(p && typeof p === "object" && !Array.isArray(p) && list(p.any).some((x) => x === P || x === "*"));
    const isGroup = (p) => !!(p && typeof p === "object" && !Array.isArray(p) && p.all && groupOf(p.all)
      && list(p.all).every((x) => x === P || /^group:/.test(x)) && list(p.all).filter((x) => /^group:/.test(x)).length === 1 && !p.any && !p.notAny);
    const allows = [], unknown = [];
    let projadm = false;
    statements.forEach((s, i) => {
      const p = s && s.principal;
      if (!s || s.effect !== "Allow") { unknown.push({ index: i, id: s && s.id, why: "deny", statement: s }); return; }
      if (p === P + ":ADMIN") { projadm = true; return; }
      if (isDefault(p)) {
        // a default may only exclude groups; anything else in it is a rule this panel does not understand
        if (typeof p === "object" && (p.all || list(p.any).some((x) => x !== P && x !== "*") || list(p.notAny).some((x) => !/^group:/.test(x)))) { unknown.push({ index: i, id: s.id, why: "principal", statement: s }); return; }
        allows.push(s); return;
      }
      if (isGroup(p)) { allows.push(s); return; }
      unknown.push({ index: i, id: s.id, why: "principal", statement: s });
    });
    const groupIds = new Set(allows.filter((s) => isGroup(s.principal)).map((s) => groupOf(s.principal.all)));
    const forPrincipal = (match) => {
      const out = { lib: "none", defs: {} };
      const lv = (defId) => allows.filter((s) => match(s.principal) && covers(s.resource, defId)).reduce((a, s) => better(levelOf(s.action), a), "none");
      out.lib = lv(UNLISTED);
      for (const d of defIds) out.defs[d] = lv(d);
      return out;
    };
    // members of g also get a default rule unless that rule excludes g (a string default excludes nobody)
    const defaultFor = (p, g) => isDefault(p) && !(typeof p === "object" && list(p.notAny).includes("group:" + g));
    const res = { default: forPrincipal(isDefault), groups: {}, listedGroups: [...groupIds], projadm, unknown };
    for (const g of groupIds) res.groups[g] = forPrincipal((p) => (isGroup(p) && groupOf(p.all) === g) || defaultFor(p, g));
    /** Access of any group id (also one the policy does not name: it gets the default rules). */
    res.forGroup = (g) => res.groups[g] || forPrincipal((p) => defaultFor(p, g));
    return res;
  }
  /** Expected level of a row for a definition. */
  const expectedLevel = (row, defId) => (row.defs && row.defs[defId]) || row.lib;

  /**
   * Compare a library's live policy with the expected one (by effective access, group by group and definition by definition).
   * @returns {ok, exact, missingGroups:[names], diffs:[{who, def|null, want, have}], extraGroups:[ids], projadm}
   */
  function comparePolicy(policy, projectId, groupIdsByName, libSpec) {
    const defIds = libSpec.defs.map((d) => d.id);
    const eff = effectiveAccess(policy, projectId, defIds);
    const ids = groupIdsByName || {};
    const diffs = [], missingGroups = [];
    const cmp = (who, row, have) => {
      if (have.lib !== row.lib) diffs.push({ who, def: null, want: row.lib, have: have.lib });
      for (const d of defIds) { const w = expectedLevel(row, d); if (have.defs[d] !== w) diffs.push({ who, def: d, want: w, have: have.defs[d] }); }
    };
    cmp("default", libSpec.access.default, eff.default);
    for (const row of libSpec.access.groups) {
      const id = ids[row.group];
      if (!id) { missingGroups.push(row.group); continue; }
      cmp(row.group, row, eff.forGroup(id));
    }
    const known = new Set(libSpec.access.groups.map((r) => ids[r.group]).filter(Boolean));
    const extraGroups = eff.listedGroups.filter((g) => !known.has(g));
    const exact = !missingGroups.length && samePolicy(policy, buildPolicy(projectId, ids, libSpec));
    // Deny statements and principals this panel does not understand are differences too (round 9, M9)
    const unknown = eff.unknown.map((u) => ({ index: u.index, id: u.id || "", why: u.why, principal: typeof (u.statement || {}).principal === "string" ? u.statement.principal : JSON.stringify((u.statement || {}).principal) }));
    return { ok: !diffs.length && !missingGroups.length && !unknown.length, exact, missingGroups, diffs, extraGroups, unknown, projadm: eff.projadm };
  }

  /**
   * Before -> after of a policy rewrite, per principal and per definition (round 9, H2).
   * @param groupNames {groupId: name} for groups outside the template
   * @returns {rows: [{who: "default"|name, groupId|null, template: bool, cells: [{def: null|defId, before, after}], changed: bool,
   *           losesAll: bool}], unknown: [statements of "before" the panel does not understand (they are dropped)],
   *           targets: [{group, groupId}] template groups that get any right in "after"}
   */
  function policyChange(before, after, projectId, groupIdsByName, libSpec, groupNames) {
    const defIds = libSpec.defs.map((d) => d.id);
    const b = effectiveAccess(before, projectId, defIds), a = effectiveAccess(after, projectId, defIds);
    const ids = groupIdsByName || {};
    const row = (who, groupId, template, x, y) => {
      const cells = [{ def: null, before: x.lib, after: y.lib }].concat(defIds.map((d) => ({ def: d, before: x.defs[d], after: y.defs[d] })));
      const changed = cells.some((c) => c.before !== c.after);
      // "No access" on a library is GetLibrary only, so a principal loses everything when every level ends as "none"
      const losesAll = cells.some((c) => c.before !== "none") && cells.every((c) => c.after === "none");
      return { who, groupId, template, cells, changed, losesAll };
    };
    const rows = [row("default", null, true, b.default, a.default)];
    const targets = [];
    for (const r of libSpec.access.groups) {
      const id = ids[r.group];
      if (!id) continue;
      const y = a.forGroup(id);
      rows.push(row(r.group, id, true, b.forGroup(id), y));
      if (y.lib !== "none" || defIds.some((d) => y.defs[d] !== "none")) targets.push({ group: r.group, groupId: id });
    }
    const known = new Set(Object.values(ids));
    for (const g of b.listedGroups) if (!known.has(g)) rows.push(row((groupNames || {})[g] || g, g, false, b.forGroup(g), a.forGroup(g)));
    return { rows, unknown: b.unknown, targets };
  }

  /** Same statements in the same order (key order inside objects ignored). */
  function samePolicy(a, b) {
    const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : v);
    const strip = (p) => ((p && p.statements) || []).map((s) => canon(s));
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }

  // ---------- the whole setup ----------
  const normName = (x) => String(x || "").replace(/\s+/g, "").toLowerCase();
  /** Group match key: ArstenAccess.groupKey (number prefix off, lower case), then spaces and punctuation ignored. */
  const groupKeyOf = (x) => (ArstenAccess && ArstenAccess.groupKey ? ArstenAccess.groupKey(x) : String(x || "").toLowerCase()).replace(/[\s.,;:_()\-–]+/g, "");

  /**
   * Checklist of the project's setup (pure).
   * @param snap {projectId, groups:[{id,name}], libraries:[{id,name,policy (GET libs/{id}/policy; null = unreadable), policyError?}], defs:{libKey:{defId: def|null}},
   *              folders:{path: id|null}, projectAdmins:[{id,email,name}], adminGroupMembers:[{id,email}]}
   * @param bodies definitionBodies(...)
   * @returns {items:[{section, id, state:"ok"|"bad"|"warn"|"unknown", bg, en, detail?, fix?}], groupIds, libs:{key: lib|null}}
   */
  function evaluateSetup(snap, bodies) {
    const items = [];
    const add = (section, id, state, bg, en, extra) => items.push(Object.assign({ section, id, state, bg, en }, extra || {}));
    const groups = snap.groups || [];
    const groupIds = {};
    // Near names (round 9, M8): same ArstenAccess.groupKey (number prefix and punctuation stripped, case and spaces
    // ignored) but another exact name, e.g. "02-GENERAL CONTRACTOR", "00 ADMIN". Never created again (yellow); a policy
    // rewrite is blocked while one exists, so the rights never go to an empty twin while the real members are elsewhere.
    const nearGroups = {};
    for (const name of GROUPS) {
      const g = groups.find((x) => x.name === name);
      if (g) groupIds[name] = g.id;
      const near = groups.filter((x) => x.name !== name && groupKeyOf(x.name) === groupKeyOf(name));
      if (near.length) {
        nearGroups[name] = near.map((x) => x.name);
        const list = near.map((x) => `„${x.name}“`).join(", "), listEn = near.map((x) => `"${x.name}"`).join(", ");
        add("groups", "group:" + name, "warn", name, name, { near: nearGroups[name], fix: null,
          detail: g ? { bg: `има група с подобно име: ${list} – слейте членовете в „${name}“ и изтрийте другата`, en: `a group with a similar name exists: ${listEn} – move its members into "${name}" and delete the other` }
            : { bg: `има група с подобно име: ${list} – преименувайте я точно на „${name}“`, en: `a group with a similar name exists: ${listEn} – rename it to exactly "${name}"` } });
      } else add("groups", "group:" + name, g ? "ok" : "bad", name, name, g ? {} : { detail: { bg: "липсва", en: "missing" }, fix: { kind: "group", name } });
    }

    const libs = {};
    const allLibs = snap.libraries || [];
    for (const spec of LIBRARIES) {
      const same = allLibs.filter((l) => normName(l.name) === normName(spec.name));
      const old = allLibs.filter((l) => spec.oldNames.some((n) => normName(n) === normName(l.name)));
      const lib = same[0] || old[0] || null;
      libs[spec.key] = lib;
      if (!lib) add("libraries", "lib:" + spec.key, "bad", spec.name, spec.name, { detail: { bg: "липсва", en: "missing" }, fix: { kind: "library", name: spec.name } });
      else if (!same.length) add("libraries", "lib:" + spec.key, "warn", spec.name, spec.name, { detail: { bg: `намерена със старото име „${lib.name}“`, en: `found under the old name "${lib.name}"` } });
      else add("libraries", "lib:" + spec.key, "ok", spec.name, spec.name);
      if (same.length + old.length > 1) {
        add("libraries", "dup:" + spec.key, "warn", `${spec.name}: ${same.length + old.length} библиотеки`, `${spec.name}: ${same.length + old.length} libraries`, {
          detail: { bg: "Инструментите ползват първата. Изтрийте или преименувайте излишните в Connect.", en: "The tools use the first one. Delete or rename the extra ones in Connect." } });
      }
      if (!lib) continue;
      for (const d of spec.defs) {
        const have = ((snap.defs || {})[spec.key] || {})[d.id];
        const want = bodies && bodies[d.body];
        const label = `${spec.name} · ${d.id}`;
        if (!have) { add("definitions", `def:${spec.key}:${d.id}`, "bad", label, label, { detail: { bg: "липсва", en: "missing" }, fix: want ? { kind: "def", lib: spec.key, def: d.id } : null }); continue; }
        const missing = want ? Object.keys(want.schema.props).filter((p) => !((have.schema && have.schema.props) || {})[p]) : [];
        if (missing.length) add("definitions", `def:${spec.key}:${d.id}`, "bad", label, label, { detail: { bg: "липсват полета: " + missing.join(", "), en: "missing fields: " + missing.join(", ") }, fix: { kind: "def", lib: spec.key, def: d.id } });
        else add("definitions", `def:${spec.key}:${d.id}`, "ok", label, label);
      }
      // the policy comes from GET libs/{id}/policy; when it could not be read (403, error) the check is "unknown" (round 9, H1)
      if (!lib.policy || typeof lib.policy !== "object") {
        add("access", "acc:" + spec.key, "unknown", `Права: ${spec.name}`, `Access: ${spec.name}`, { fix: null,
          detail: { bg: "неизвестно – правата не можаха да се прочетат" + (lib.policyError ? ` (${lib.policyError})` : ""), en: "unknown – the access could not be read" + (lib.policyError ? ` (${lib.policyError})` : "") } });
        continue;
      }
      const c = comparePolicy(lib.policy, snap.projectId, groupIds, spec);
      const ro = reportOnly(snap.projectId, spec.key);
      const near = spec.access.groups.map((r) => r.group).filter((n) => nearGroups[n]);
      const lv = { edit: ["Edit", "Edit"], read: ["Read", "Read"], none: ["Няма", "No access"] };   // same word as the before/after table (round 14 L6)
      const lines = c.diffs.map((x) => ({ bg: `${x.who === "default" ? "Всички членове" : x.who}${x.def ? " · " + x.def : " · библиотека"}: ${lv[x.have][0]}, трябва ${lv[x.want][0]}`,
        en: `${x.who === "default" ? "All members" : x.who}${x.def ? " · " + x.def : " · library"}: ${lv[x.have][1]}, should be ${lv[x.want][1]}` }));
      for (const u of c.unknown) lines.push(u.why === "deny"
        ? { bg: `правило ${u.index + 1} (${u.id || "?"}): Deny за ${u.principal} – шаблонът няма Deny`, en: `statement ${u.index + 1} (${u.id || "?"}): Deny for ${u.principal} – the template has no Deny` }
        : { bg: `правило ${u.index + 1} (${u.id || "?"}): непознат получател ${u.principal}`, en: `statement ${u.index + 1} (${u.id || "?"}): unknown principal ${u.principal}` });
      if (c.missingGroups.length) lines.push({ bg: "няма групи: " + c.missingGroups.join(", "), en: "groups missing: " + c.missingGroups.join(", ") });
      if (near.length && !c.ok && !ro) lines.push({ bg: "групи с подобни имена: " + near.map((n) => `${n} ≈ ${nearGroups[n].join(", ")}`).join("; ") + " – оправете ги, преди да пренапишете правата",
        en: "groups with similar names: " + near.map((n) => `${n} ≈ ${nearGroups[n].join(", ")}`).join("; ") + " – resolve them before rewriting the access" });
      const blockedBy = c.ok || ro ? null : c.missingGroups.length ? "groups" : near.length ? "near" : null;
      add("access", "acc:" + spec.key, c.ok ? "ok" : ro ? "warn" : "bad", `Права: ${spec.name}`, `Access: ${spec.name}`, {
        detail: c.ok ? (c.exact ? { bg: "точно като шаблона", en: "exactly as the template" } : { bg: "същите права (записани различно)", en: "same access (written differently)" })
          : ro ? { bg: `различно по избор – ${ro.why.bg}`, en: `different by choice – ${ro.why.en}` } : null,
        lines, reportOnly: !!ro, fix: c.ok || ro || blockedBy ? null : { kind: "policy", lib: spec.key }, blockedBy });
      if (c.extraGroups.length) {
        const names = c.extraGroups.map((id) => (groups.find((g) => g.id === id) || {}).name || id);
        add("access", "accx:" + spec.key, "warn", `${spec.name}: други групи с права`, `${spec.name}: other groups with access`, { detail: ro
          ? { bg: names.join(", ") + " (не са в шаблона)", en: names.join(", ") + " (not in the template)" }
          : { bg: names.join(", ") + " (не са в шаблона; пренаписването ги маха)", en: names.join(", ") + " (not in the template; a rewrite removes them)" } });
      }
    }

    for (const path of FOLDERS) {
      const ok = !!(snap.folders || {})[path];
      add("folders", "folder:" + path, ok ? "ok" : "bad", "/" + path, "/" + path, ok ? {} : { detail: { bg: "липсва", en: "missing" }, fix: { kind: "folder", path } });
    }

    const inAdmin = (u) => (snap.adminGroupMembers || []).some((m) => (m.id && u.id && m.id === u.id) || (m.email && u.email && m.email.toLowerCase() === u.email.toLowerCase()));
    const outside = (snap.projectAdmins || []).filter((u) => !inAdmin(u));
    add("people", "admins", outside.length ? "warn" : "ok", "Администратори на проекта в 00_ADMIN", "Project admins in 00_ADMIN", outside.length ? {
      detail: { bg: `не са в 00_ADMIN: ${outside.map((u) => u.name || u.email).join(", ")} – получават 403 при запис (заключените библиотеки)`,
        en: `not in 00_ADMIN: ${outside.map((u) => u.name || u.email).join(", ")} – they get 403 on writes (library lock)` } } : {});
    return { items, groupIds, libs };
  }

  /** What "Създай липсващите" would do (no policy rewrites: those have their own confirm). */
  function plannedFixes(items) {
    return items.filter((i) => i.fix && ["group", "folder", "def"].includes(i.fix.kind)).map((i) => i.fix);
  }

  /** Folder paths to create, parents first, each once: "a/b/c" missing -> a, a/b, a/b/c (existing ones skipped at run time). */
  function folderSteps(paths) {
    const out = [];
    for (const p of paths) {
      const parts = p.split("/");
      for (let i = 1; i <= parts.length; i++) { const s = parts.slice(0, i).join("/"); if (!out.includes(s)) out.push(s); }
    }
    return out;
  }

  /** Steps to create a missing library by hand (library creation through the API is not verified). */
  function libraryHelp(name, projectId, lang) {
    const url = `https://web.connect.trimble.com/projects/${projectId}/property-set-libraries`;
    return lang === "en"
      ? [`Create it in Property Set Libraries with the name "${name}":`, `1. Open ${url} (project → Property Set Libraries).`, "2. New library → Name: " + name + " → Save.", "3. Come back here and press \"Create missing\" for its definitions, then rewrite its access."]
      : [`Създайте я в Property Set Libraries с името „${name}“:`, `1. Отворете ${url} (проектът → Property Set Libraries).`, "2. Нова библиотека (New library) → Name: " + name + " → Save.", "3. Върнете се тук и натиснете „Създай липсващите“ за дефинициите, после пренапишете правата ѝ."];
  }

  return { GROUPS, ADMIN_GROUP, LIBRARIES, REPORT_ONLY, reportOnly, groupKeyOf, FOLDERS, ACTIONS, PROJADM_ACTIONS, definitionBodies, buildPolicy, effectiveAccess, comparePolicy,
    samePolicy, policyChange, levelOf, covers, evaluateSetup, plannedFixes, folderSteps, libraryHelp };
});
