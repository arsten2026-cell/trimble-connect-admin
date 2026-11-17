// "Администрация" (Administration): admin-only checks of an Arsten / Multiplan Connect project.
//   1. Настройка на проекта – checklist against AM_TEMPLATE (expected.js): groups, libraries, definitions, library
//      access, folders, duplicate libraries, project admins outside 00_ADMIN. "Създай липсващите" creates missing groups,
//      folders and definitions; a library's access is rewritten only after an inline confirm. Nothing is ever deleted.
//      Round 11 M7: group, access and definition fixes only for a Connect project ADMIN (own role from projects/{id}/users);
//      a 00_ADMIN member with the USER role sees the report, folder creation and the reason.
//      Round 11 L9: a library / definition that cannot be read is reported as "няма достъп"; the rest is still checked.
//      Libraries themselves are NOT created (not verified through the API): the panel gives the steps.
//   2. Здраве на данните – read-only report per library / definition (health.js), CSV export.
//   3. Какво се промени – change feed from the records' history logs (7 / 30 days), JSON archive of both libraries.
// Access: ArstenAccess app "projectAdmin" (roles ["admin"]), passed as a config override; shared/arsten-access.js unchanged.
(function () {
  "use strict";
  const A = window.ArstenPsetApi || window.PsetApi, E = window.ArstenExpected, H = window.ArstenHealth, PH = window.ArstenPhotos;
  const ACCESS_CONFIG = { apps: { projectAdmin: ["admin"] } };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // one language for all tools (A10): shared key "arsten.lang" (shared/arsten-i18n.js), the old key read once
  const I18N = window.ArstenI18n, OLD_LANG = ["arsten.admin.lang"];
  let lang = I18N ? I18N.getLang(OLD_LANG) : "bg";
  const L2 = (b, e) => (lang === "bg" ? b : e);
  // counted forms (round 19 L6): countWord(1, "запис", "записа", "record", "records") = "1 запис"
  const countWord = (n, one, many, en1, enN) => `${n} ${lang === "bg" ? (Math.abs(Number(n)) === 1 ? one : many) : (Math.abs(Number(n)) === 1 ? en1 : enN)}`;
  const T = (o) => (o ? (lang === "bg" ? o.bg : o.en) : "");
  const state = {
    api: null, client: null, core: null, project: null, access: null, tab: "setup", busy: false,
    setup: null, snap: null, fixLog: [], confirm: null, originals: {}, me: null,
    data: null, report: null, orphanNote: "", feed: { days: 7, who: "", tool: "" },
  };
  const bodies = () => E.definitionBodies({ PourStatus: window.PourStatus, ArstenStages: window.ArstenStages, ArstenPhotos: window.ArstenPhotos,
    ArstenAcceptance: window.ArstenAcceptance, SteelRecords: window.SteelRecords, SteelFab: window.SteelFab });
  // t may be a function: then it is built again in the new language after a language switch (round 19 L4)
  let statusAgain = null;
  const setStatus = (t, bad) => { statusAgain = typeof t === "function" ? { t, bad } : null; if (typeof t === "function") t = t(); $("status").textContent = t || ""; $("status").className = "status" + (bad ? " bad" : ""); };
  const relabelStatus = () => { if (statusAgain) setStatus(statusAgain.t, statusAgain.bad); if (window.ArstenDiag && ArstenDiag.relabel) ArstenDiag.relabel(); };
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  const guarded = (fn) => Promise.resolve().then(fn).catch((e) => { console.error(e); setStatus(I18N ? I18N.err(errText(e), lang) : errText(e), true); }).finally(() => { state.busy = false; render(); });
  // role checks work with the single role (access.role) and with the role union of multi-group users (access.roles)
  const hasRole = (r) => !!(state.access && (state.access.role === r || (Array.isArray(state.access.roles) && state.access.roles.includes(r))));
  const isAdmin = () => hasRole("admin");
  /** M7 (round 11): the user's own Connect project role is ADMIN (projects/{id}/users, read by the setup check).
   *  Only then are group, policy and definition fixes offered: Connect refuses them for a 00_ADMIN member with role USER. */
  const isConnectAdmin = () => !!(state.me && state.snap && (state.snap.projectAdmins || []).some((u) => sameUser(u, state.me)));
  const canManage = () => isAdmin() && isConnectAdmin();
  /** The fixes "Създай липсващите" may run: folders for every admin, groups and definitions only for a Connect project ADMIN. */
  const allowedFixes = () => (state.setup ? E.plannedFixes(state.setup.items).filter((f) => canManage() || f.kind === "folder") : []);
  const NEEDS_CONNECT_ADMIN = { bg: "Нужна е роля администратор на проекта в Connect за групи, права и дефиниции (Connect отказва тези промени на член на 00_ADMIN с роля потребител). Проверките и докладите остават.",
    en: "Groups, access and definitions need the Connect project ADMIN role (Connect refuses them for a 00_ADMIN member with the USER role). The checks and reports stay." };

  // ---------- access token ----------
  let token = null, waiters = [];
  function onToken(tk) { token = tk; const w = waiters; waiters = []; w.forEach((f) => f(tk)); }
  // Round 17 L3 (the round 12 L6 fix of Монолитен бетон / Стомана): the waiter is registered before asking (the token
  // event may come while requestPermission runs). When Connect returns the token directly, refuses or throws, the waiter
  // and its 60 s timer are dropped, so no stray "No access token" rejection is logged a minute later.
  async function getToken(refresh) {
    if (token && !refresh) return token;
    let timer = 0, done = null;
    const p = new Promise((resolve, reject) => {
      done = (tk) => { clearTimeout(timer); resolve(tk); };
      waiters.push(done);
      timer = setTimeout(() => { waiters = waiters.filter((f) => f !== done); reject(new Error(L2("Trimble Connect не даде ключ за достъп", "No access token from Trimble Connect"))); }, 60000);
    });
    const drop = () => { clearTimeout(timer); waiters = waiters.filter((f) => f !== done); p.catch(() => {}); };
    let r;
    try { r = await state.api.extension.requestPermission("accesstoken"); } catch (e) { drop(); throw e; }
    if (r === "denied") { drop(); throw new Error(L2("Достъпът до данните в Trimble Connect е отказан за това разширение.", "Access to Trimble Connect data was denied for this extension.")); }
    if (r && r !== "pending" && r !== "granted") { drop(); token = r; return r; }
    return p;
  }
  const items = (x) => (Array.isArray(x) ? x : (x && x.items) || []);

  // ---------- 1. setup ----------
  // folder names are matched case-insensitively (round 9, low 16): "_arstendocs" is the same folder for people
  const folderName = (s) => String(s == null ? "" : s).normalize("NFC").trim().toLowerCase();
  const findFolder = (list, name) => list.find((x) => String(x.type || "FOLDER").toUpperCase() === "FOLDER" && folderName(x.name) === folderName(name));
  /** {leaves: {path: id|null} for E.FOLDERS, ids: {path or parent path: id}} */
  async function folderIndex(rootId) {
    const cache = new Map(), out = {}, ids = {};
    const children = async (id) => { if (!cache.has(id)) cache.set(id, items(await state.core.req(`folders/${encodeURIComponent(id)}/items`))); return cache.get(id); };
    for (const path of E.FOLDERS) {
      let id = rootId;
      const parts = path.split("/");
      for (let i = 0; i < parts.length; i++) {
        const f = id && findFolder(await children(id), parts[i]);
        id = f ? f.id : null;
        if (!id) break;
        ids[parts.slice(0, i + 1).join("/")] = id;
      }
      out[path] = id;
    }
    return { leaves: out, ids };
  }

  async function gatherSetup() {
    const pid = state.project.id;
    setStatus(L2("Чета групите, библиотеките и папките…", "Reading groups, libraries and folders…"));
    const proj = await state.core.req(`projects/${encodeURIComponent(pid)}`);
    const groups = items(await state.core.req(`groups?projectId=${encodeURIComponent(pid)}`)).map((g) => ({ id: g.id, name: g.name }));
    const users = items(await state.core.req(`projects/${encodeURIComponent(pid)}/users`)).filter((u) => String(u.status || "ACTIVE").toUpperCase() !== "REMOVED");
    const projectAdmins = users.filter((u) => String(u.role || "").toUpperCase() === "ADMIN")
      .map((u) => ({ id: u.id, email: u.email, tiduuid: u.tiduuid, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id }));
    const adminGroup = groups.find((g) => g.name === E.ADMIN_GROUP);
    const adminGroupMembers = adminGroup ? items(await state.core.req(`groups/${encodeURIComponent(adminGroup.id)}/users`)) : [];
    const libraries = [];
    for (const id of await state.client.projectLibraryIds(pid)) {
      let l = null;
      try { l = await state.client.getLibrary(id); }
      catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
      if (!l) continue;
      // the policy has its own endpoint, GET libs/{id}/policy, like every other panel (round 9, H1); a library's own
      // body does not carry it. Unreadable (403 or any error) -> the access check says "unknown" and offers no rewrite.
      let policy = null, policyError = "";
      try { policy = await state.client.getPolicy(l.id || id); if (!policy || typeof policy !== "object") { policy = null; policyError = L2("празен отговор", "empty answer"); } }
      catch (e) { policyError = e.status ? String(e.status) : errText(e); }
      libraries.push({ id: l.id || id, name: l.name, policy, policyError });
    }
    const snap = { projectId: pid, rootId: proj && proj.rootId, groups, libraries, defs: {}, folders: {}, folderIds: {}, projectAdmins, adminGroupMembers };
    const first = E.evaluateSetup(snap, bodies());
    for (const spec of E.LIBRARIES) {
      const lib = first.libs[spec.key];
      if (!lib) continue;
      snap.defs[spec.key] = {};
      for (const d of spec.defs) {
        try { snap.defs[spec.key][d.id] = await state.client.request("pset", `libs/${encodeURIComponent(lib.id)}/defs/${encodeURIComponent(d.id)}`); }
        catch (e) { if (e.status === 404) snap.defs[spec.key][d.id] = null; else throw e; }
      }
    }
    if (snap.rootId) { const fi = await folderIndex(snap.rootId); snap.folders = fi.leaves; snap.folderIds = fi.ids; }
    return snap;
  }

  async function runSetup() {
    state.snap = await gatherSetup();
    state.setup = E.evaluateSetup(state.snap, bodies());
    const n = (s) => state.setup.items.filter((i) => i.state === s).length;
    const bad = n("bad"), warn = n("warn"), unk = n("unknown");
    setStatus(() => bad || warn || unk ? L2(`${bad} за оправяне · ${warn} предупреждения${unk ? ` · ${unk} неизвестни` : ""}`, `${bad} to fix · ${warn} warnings${unk ? ` · ${unk} unknown` : ""}`)
      : L2("Проектът е като AM_TEMPLATE.", "The project matches AM_TEMPLATE."), !!bad);
  }

  async function createMissing() {
    if (!isAdmin()) return setStatus(L2("Само за администратори.", "Admins only."), true);
    const fixes = allowedFixes();   // M7: groups and definitions only for a Connect project ADMIN
    if (!fixes.length) return setStatus(canManage() ? "" : T(NEEDS_CONNECT_ADMIN), !canManage());
    const log = (ok, bg, en) => state.fixLog.push({ ok, bg, en });
    const pid = state.project.id, B = bodies();
    for (const f of fixes.filter((x) => x.kind === "group")) {
      try { await state.core.req("groups", "POST", { name: f.name, projectId: pid }); log(true, `Група ${f.name} създадена`, `Group ${f.name} created`); }
      catch (e) { log(false, `Група ${f.name}: ${errText(e)}`, `Group ${f.name}: ${errText(e)}`); }
    }
    const missingFolders = fixes.filter((x) => x.kind === "folder").map((x) => x.path);
    if (missingFolders.length) {
      const ids = new Map([["", state.snap.rootId]]);
      for (const step of E.folderSteps(missingFolders)) {
        const parts = step.split("/"), name = parts.pop(), parent = ids.get(parts.join("/"));
        if (!parent) continue;
        try {
          const have = findFolder(items(await state.core.req(`folders/${encodeURIComponent(parent)}/items`)), name);
          if (have) { ids.set(step, have.id); continue; }
          const made = await state.core.req("folders", "POST", { name, parentId: parent });
          ids.set(step, made && made.id);
          log(true, `Папка /${step} създадена`, `Folder /${step} created`);
        } catch (e) { log(false, `Папка /${step}: ${errText(e)}`, `Folder /${step}: ${errText(e)}`); }
      }
    }
    for (const f of fixes.filter((x) => x.kind === "def")) {
      const lib = state.setup.libs[f.lib], spec = E.LIBRARIES.find((l) => l.key === f.lib), d = spec.defs.find((x) => x.id === f.def);
      try {
        const r = await state.client.ensureDefinition(lib.id, B[d.body], { fresh: true });   // never answered from the session cache (review 10 L3)
        log(true, `${lib.name} · ${f.def}: ${r.created ? "създадена" : "допълнени полета " + (r.extended || []).join(", ")}`, `${lib.name} · ${f.def}: ${r.created ? "created" : "fields added " + (r.extended || []).join(", ")}`);
      } catch (e) { log(false, `${lib.name} · ${f.def}: ${errText(e)}`, `${lib.name} · ${f.def}: ${errText(e)}`); }
    }
    await runSetup();
  }

  // ---------- policy rewrite (round 9, H2) ----------
  // policyAsk: a fresh GET of the policy, the member count of every group involved, a before -> after table, and the
  // reasons it is refused. policyGo: GET again (abort when it changed since the confirm opened), save the current
  // policy to _ArstenDocs/Backups (or download it; stop when neither worked), then PUT.
  const sameUser = (a, b) => !!a && !!b && ((a.id && b.id && a.id === b.id) || (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase())
    || (a.tiduuid && b.tiduuid && a.tiduuid === b.tiduuid));
  const groupName = (id) => ((state.snap.groups || []).find((g) => g.id === id) || {}).name || id;

  /** Why a rewrite of this library must not run now ([{bg, en}]; empty = allowed). Pure on state + the prepared data. */
  function refusals(key, prep) {
    const out = [];
    const item = state.setup.items.find((i) => i.id === "acc:" + key) || {};
    if (!isConnectAdmin()) out.push(NEEDS_CONNECT_ADMIN);   // M7 (round 11): PUT libs/{id}/policy is project-admin only
    if (E.reportOnly(state.project.id, key)) out.push({ bg: "Проектът е в списъка „само доклад“ (expected.js REPORT_ONLY): правата му са различни по избор.", en: "The project is on the report-only list (expected.js REPORT_ONLY): its access differs on purpose." });
    if (item.blockedBy === "groups") out.push({ bg: "Първо създайте липсващите групи.", en: "Create the missing groups first." });
    if (item.blockedBy === "near") out.push({ bg: "Има групи с подобни имена – първо ги оправете (едната група трябва да остане).", en: "There are groups with similar names – resolve them first (one group must remain)." });
    if (prep) {
      const empty = prep.change.targets.filter((t) => prep.members[t.groupId] === 0);
      const unread = prep.change.targets.filter((t) => prep.members[t.groupId] == null);
      if (empty.length) out.push({ bg: `Празни групи получават права: ${empty.map((t) => t.group).join(", ")}. Добавете хора в тях първо – иначе хората без група губят достъп.`,
        en: `Empty groups would get the access: ${empty.map((t) => t.group).join(", ")}. Add people to them first – otherwise the people outside them lose access.` });
      if (unread.length) out.push({ bg: `Членовете на ${unread.map((t) => t.group).join(", ")} не можаха да се прочетат.`, en: `The members of ${unread.map((t) => t.group).join(", ")} could not be read.` });
      if (!state.me) out.push({ bg: "Не мога да разбера кой е текущият потребител.", en: "Could not tell who the current user is." });
      else if ((state.snap.projectAdmins || []).some((u) => sameUser(u, state.me)) && !(state.snap.adminGroupMembers || []).some((m) => sameUser(m, state.me))) {
        out.push({ bg: `Вие сте администратор на проекта, но не сте в ${E.ADMIN_GROUP}: след пренаписването няма да можете да пишете в библиотеката. Добавете се в ${E.ADMIN_GROUP} първо.`,
          en: `You are a project admin but not in ${E.ADMIN_GROUP}: after the rewrite you could not write to the library. Add yourself to ${E.ADMIN_GROUP} first.` });
      }
    }
    return out;
  }

  async function prepareRewrite(key) {
    if (!isAdmin()) return setStatus(L2("Само за администратори.", "Admins only."), true);
    const lib = state.setup.libs[key], spec = E.LIBRARIES.find((l) => l.key === key);
    const pre = refusals(key, null);
    if (pre.length) { state.confirm = null; return setStatus(T(pre[0]), true); }
    setStatus(L2("Чета текущите права и членовете на групите…", "Reading the current access and the group members…"));
    const before = await state.client.getPolicy(lib.id);
    if (!before || typeof before !== "object") throw new Error(L2("Правата на библиотеката не могат да се прочетат.", "The library access could not be read."));
    const after = E.buildPolicy(state.project.id, state.setup.groupIds, spec);
    const change = E.policyChange(before, after, state.project.id, state.setup.groupIds, spec, Object.fromEntries((state.snap.groups || []).map((g) => [g.id, g.name])));
    const members = {};
    for (const r of change.rows) {
      if (!r.groupId || r.groupId in members) continue;
      try { members[r.groupId] = items(await state.core.req(`groups/${encodeURIComponent(r.groupId)}/users`)).length; } catch { members[r.groupId] = null; }
    }
    // the first original of each library in this session is kept for "Изтегли старите права" (round 9, H2e)
    if (!state.originals[key]) state.originals[key] = { name: lib.name, libId: lib.id, at: new Date().toISOString(), policy: before };
    state.confirm = { key, libId: lib.id, libName: lib.name, before, after, change, members };
    state.confirm.refusals = refusals(key, state.confirm);
    setStatus(state.confirm.refusals.length ? L2("Пренаписването е спряно – вижте причините.", "The rewrite is refused – see the reasons.") : L2("Проверете промените и потвърдете.", "Check the changes and confirm."), !!state.confirm.refusals.length);
  }

  /** Save the current policy before the PUT: upload to _ArstenDocs/Backups/<day>/admin-policy-<lib>-<HHMMSSmmm>.json, or
   *  download it. Returns {ok, text} – ok false when neither worked (the PUT must not run). */
  async function backupPolicy(c, policy) {
    const B = window.ArstenBackup;
    if (!B) return { ok: false, text: L2("архивният модул (arsten-backup.js) не е зареден", "the backup module (arsten-backup.js) is not loaded") };
    const at = new Date();
    const snapshot = { type: "arsten-backup", version: B.VERSION, kind: "library-policy", tool: "admin", action: "policy-" + c.libName,
      project: { id: state.project.id, name: state.project.name || "" }, by: (state.me && state.me.name) || "", at: at.toISOString(),
      library: { id: c.libId, name: c.libName }, policy, records: [] };
    // folder ids found by the setup check (case-insensitive names), so the backup never makes a second "_ArstenDocs"
    const cache = new Map(), ids = state.snap.folderIds || {}, root = state.snap.rootId;
    if (root) {
      cache.set("root:" + state.project.id, root);
      if (ids["_ArstenDocs"]) { cache.set(root + "/_ArstenDocs", ids["_ArstenDocs"]); if (ids["_ArstenDocs/Backups"]) cache.set(ids["_ArstenDocs"] + "/Backups", ids["_ArstenDocs/Backups"]); }
    }
    const res = await B.save({ core: state.core, projectId: state.project.id, snapshot, cache, fetch: window.ARSTEN_ADMIN_FETCH,
      download: (name, text) => { try { download(name, text, "application/json"); return true; } catch (e) { console.warn("download failed", e); return false; } } });
    if (res.uploaded) return { ok: true, text: L2("архив: ", "backup: ") + res.path };
    if (res.downloaded) return { ok: true, text: L2(`архивът не се качи в Connect (${res.error}) – изтеглен е на компютъра като ${res.name}`, `the backup was not uploaded to Connect (${res.error}) – it was downloaded as ${res.name}`) };
    return { ok: false, text: L2(`архивът не се качи (${res.error}) и не можа да се изтегли`, `the backup was not uploaded (${res.error}) and could not be downloaded`) };
  }

  async function rewritePolicy(key) {
    if (!isAdmin()) return setStatus(L2("Само за администратори.", "Admins only."), true);
    const c = state.confirm;
    if (!c || c.key !== key) return setStatus(L2("Отворете потвърждението отново.", "Open the confirmation again."), true);
    const stop = (bg, en) => { state.fixLog.push({ ok: false, bg: `Права на ${c.libName}: ${bg}`, en: `Access of ${c.libName}: ${en}` }); state.confirm = null; };
    const why = refusals(key, c);
    if (why.length) return setStatus(T(why[0]), true);
    let now;
    try { now = await state.client.getPolicy(c.libId); } catch (e) { stop(`не се прочетоха отново (${errText(e)}) – нищо не е променено`, `could not be read again (${errText(e)}) – nothing changed`); return runSetup(); }
    if (!now || typeof now !== "object" || !E.samePolicy(now, c.before) || now.id !== c.before.id || now.version !== c.before.version) {
      stop("променени са междувременно (напр. в Library access control) – нищо не е записано. Проверете отново.", "changed meanwhile (e.g. in Library access control) – nothing was written. Check again.");
      return runSetup();
    }
    const bk = await backupPolicy(c, now);
    if (!bk.ok) { stop(`${bk.text} – правата НЕ са пренаписани`, `${bk.text} – the access was NOT rewritten`); return runSetup(); }
    try {
      await state.client.putPolicy(c.libId, c.after);
      state.fixLog.push({ ok: true, bg: `Правата на ${c.libName} са пренаписани · ${bk.text}`, en: `Access of ${c.libName} rewritten · ${bk.text}` });
    } catch (e) { state.fixLog.push({ ok: false, bg: `Права на ${c.libName}: ${errText(e)} · ${bk.text}`, en: `Access of ${c.libName}: ${errText(e)} · ${bk.text}` }); }
    state.confirm = null;
    await runSetup();
  }

  // ---------- data (tabs 2 and 3) ----------
  async function loadData() {
    if (!state.setup) await runSetup();
    const recs = [], libs = [], noAccess = [], errors = [];
    for (const spec of E.LIBRARIES) {
      const lib = state.setup.libs[spec.key];
      if (!lib) continue;
      const entry = { id: lib.id, name: lib.name, key: spec.key, policy: lib.policy, definitions: [] };
      for (const d of spec.defs) {
        setStatus(L2(`Чета ${lib.name} · ${d.id}…`, `Reading ${lib.name} · ${d.id}…`));
        let m = new Map(), denied = false;
        // L9 (round 11): a refused (403) or failing read is reported as "няма достъп" for that definition; the others go on
        try { m = await state.client.listAll(lib.id, d.id); }
        catch (e) {
          if (e.status !== 404) {
            denied = true; noAccess.push(lib.name + "|" + d.id);
            if (e.status !== 403 && e.status !== 401) errors.push(`${lib.name} · ${d.id}: ${errText(e)}`);
            console.warn("not readable", lib.name, d.id, e);
          }
        }
        const records = [...m].map(([link, props]) => ({ lib: lib.name, def: d.id, link, props }));
        recs.push(...records);
        entry.definitions.push(Object.assign({ id: d.id, definition: ((state.snap.defs || {})[spec.key] || {})[d.id] || null, records }, denied ? { noAccess: true } : {}));
      }
      libs.push(entry);
    }
    state.data = { records: recs, libs, at: new Date(), noAccess, errors };
    const deniedLibs = [...new Set(noAccess.map((k) => k.split("|")[0]))];
    setStatus(() => `${countWord(recs.length, "запис", "записа", "record", "records")} ${L2("в", "in")} ${countWord(libs.length, "библиотека", "библиотеки", "library", "libraries")}`
      + (deniedLibs.length ? L2(` · няма достъп: ${deniedLibs.join(", ")}`, ` · no access: ${deniedLibs.join(", ")}`) : ""), !!deniedLibs.length);
  }

  /** Runtime ids of a chunk of GUIDs; a failing call is split and retried smaller, down to one GUID at a time (as
   *  Стомана does), so one bad GUID never drops its neighbours. GUIDs whose own lookup failed go into `failed`. */
  async function toRuntimeIds(modelId, chunk, failed) {
    try {
      const r = (await state.api.viewer.convertToObjectRuntimeIds(modelId, chunk)) || [];
      return chunk.map((_, k) => (r[k] != null ? r[k] : null));
    } catch (e) {
      if (chunk.length <= 32) {
        const out = [];
        for (const g of chunk) {
          try { const r = (await state.api.viewer.convertToObjectRuntimeIds(modelId, [g])) || []; out.push(r[0] != null ? r[0] : null); }
          catch { failed.add(g); out.push(null); }
        }
        return out;
      }
      const h = chunk.length >> 1;
      const a = await toRuntimeIds(modelId, chunk.slice(0, h), failed);
      return a.concat(await toRuntimeIds(modelId, chunk.slice(h), failed));
    }
  }

  /**
   * Which GUIDs are in the loaded models (round 9, M11). null when no model is loaded. Otherwise
   * {present, unknown, models: names checked, notLoaded: names of project models not loaded (null = could not tell),
   *  failed: GUIDs whose lookup failed}. unknown = not found AND (lookup failed, or some project model is not loaded):
   * such a record may belong to a model that is not loaded, so it is never called an orphan.
   */
  async function modelCheck(guids) {
    const objs = (await state.api.viewer.getObjects()) || [];
    const loaded = objs.filter((m) => (m.objects || []).length).map((m) => m.modelId);
    if (!loaded.length) return null;
    let all = null;
    try { all = (await state.api.viewer.getModels()) || null; } catch {}
    const nameOf = (id) => ((all || []).find((m) => m.id === id) || {}).name || id;
    const notLoaded = all ? all.filter((m) => !loaded.includes(m.id) && m.state !== "loaded").map((m) => m.name || m.id) : null;
    const present = new Set(), failed = new Set();
    for (const modelId of loaded) {
      for (let i = 0; i < guids.length; i += 500) {
        const chunk = guids.slice(i, i + 500);
        const ids = await toRuntimeIds(modelId, chunk, failed);
        chunk.forEach((g, k) => { if (ids[k] != null) present.add(g); });
      }
    }
    const unknown = new Set(guids.filter((g) => !present.has(g) && (failed.has(g) || (notLoaded && notLoaded.length))));
    return { present, unknown, failed: [...failed].filter((g) => !present.has(g)), models: loaded.map(nameOf), notLoaded };
  }

  function orphanNoteOf(check) {
    if (!check) return L2("Заредете модела за проверка на сираците.", "Load the model to check for orphans.");
    const parts = [L2(`Сираците са проверени в: ${check.models.join(", ")}.`, `Orphans checked in: ${check.models.join(", ")}.`)];
    if (check.notLoaded && check.notLoaded.length) parts.push(L2(`Не са заредени: ${check.notLoaded.join(", ")} – записите, които не са намерени, се броят за неизвестни (може да са от тези модели). Заредете всички модели за пълна проверка.`,
      `Not loaded: ${check.notLoaded.join(", ")} – records not found count as unknown (they may belong to those models). Load every model for a full check.`));
    else if (!check.notLoaded) parts.push(L2("Не може да се разбере дали всички модели са заредени: записи от незаредени модели ще изглеждат като сираци.", "Could not tell whether every model is loaded: records of a model that is not loaded would look like orphans."));
    if (check.failed.length) parts.push(L2(`${check.failed.length} GUID не можаха да се потърсят – броят се за неизвестни.`, `${check.failed.length} GUIDs could not be looked up – counted as unknown.`));
    return parts.join(" ");
  }

  async function runHealth() {
    await loadData();
    const guids = [...new Set(state.data.records.map((r) => H.guidOf(r.link)).filter(Boolean))];
    setStatus(L2("Търся обектите в модела…", "Looking for the objects in the model…"));
    const check = await modelCheck(guids);
    state.orphanNote = orphanNoteOf(check);
    const defsByLib = Object.fromEntries(state.data.libs.map((l) => [l.name, l.definitions.map((d) => d.id)]));
    state.report = H.health(state.data.records, check, defsByLib, state.data.noAccess);
    const n = state.report.issues.length;
    const denied = [...new Set((state.data.noAccess || []).map((k) => k.split("|")[0]))];
    setStatus(() => (n ? countWord(n, "забележка", "забележки", "finding", "findings") : L2("Няма забележки.", "No findings."))
      + (denied.length ? L2(` · няма достъп до ${denied.join(", ")} (не е проверено)`, ` · no access to ${denied.join(", ")} (not checked)`) : ""), !!denied.length);
  }

  async function selectGuids(guids) {
    if (!guids || !guids.length) return setStatus(L2("Записът няма обекти в модела.", "The record has no model objects."), true);
    const objs = (await state.api.viewer.getObjects()) || [];
    const sel = [];
    for (const m of objs.filter((x) => (x.objects || []).length)) {
      try { const ids = ((await state.api.viewer.convertToObjectRuntimeIds(m.modelId, guids)) || []).filter((x) => x != null); if (ids.length) sel.push({ modelId: m.modelId, objectRuntimeIds: ids }); } catch {}
    }
    if (!sel.length) return setStatus(L2("Обектите не са в заредените модели.", "The objects are not in the loaded models."), true);
    await state.api.viewer.setSelection({ modelObjectIds: sel }, "set");
    try { await state.api.viewer.setCamera({ modelObjectIds: sel }, { animationTime: 400 }); } catch {}
    const k = sel.reduce((n, s) => n + s.objectRuntimeIds.length, 0);
    setStatus(L2(`${k === 1 ? "Избран" : "Избрани"} ${countWord(k, "обект", "обекта")}.`, `${k} ${k === 1 ? "object" : "objects"} selected.`));
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const fileStem = () => `${String(state.project.name || state.project.id).replace(/[^\p{L}\p{N}_-]+/gu, "_")}_${H.daysAgo(0)}`;

  async function backup() {
    if (!state.data) await loadData();
    const a = H.archive({ created: new Date().toISOString(), project: { id: state.project.id, name: state.project.name || "" } }, state.data.libs);
    download(`arsten-archive_${fileStem()}.json`, JSON.stringify(a, null, 1), "application/json");
    const na = state.data.noAccess || [];
    setStatus(`${L2("Архивът е изтеглен", "Archive downloaded")} (${countWord(state.data.records.length, "запис", "записа", "record", "records")}).`
      + (na.length ? L2(` Без ${na.join(", ")}: няма достъп.`, ` Without ${na.join(", ")}: no access.`) : ""), !!na.length);
  }

  // ---------- render ----------
  const TABS = [["setup", "Настройка на проекта", "Project setup"], ["health", "Здраве на данните", "Data health"], ["feed", "Какво се промени", "What changed"]];
  const SECTIONS = [["groups", "Групи", "Groups"], ["libraries", "Библиотеки", "Libraries"], ["definitions", "Дефиниции", "Definitions"],
    ["access", "Права в библиотеките", "Library access"], ["folders", "Папки", "Folders"], ["people", "Хора", "People"]];

  function renderSetup() {
    const r = state.setup;
    if (!r) return `<div class="note">${esc(L2("Проверката не е пусната.", "Not checked yet."))}</div>`;
    const fixes = allowedFixes();
    let h = `<div class="bar"><button class="small secondary" data-act="setup" ${state.busy ? "disabled" : ""}>${esc(L2("Провери отново", "Check again"))}</button>`;
    if (isAdmin()) h += `<button class="small" data-act="create" ${state.busy || !fixes.length ? "disabled" : ""}>${esc(canManage() ? L2("Създай липсващите", "Create missing") : L2("Създай липсващите папки", "Create missing folders"))}${fixes.length ? ` (${fixes.length})` : ""}</button>`;
    h += `</div><div class="sub">${esc(canManage() ? L2("Създава липсващи групи, папки и дефиниции. Нищо не се трие. Библиотеки не се създават автоматично.", "Creates missing groups, folders and definitions. Nothing is deleted. Libraries are not created automatically.")
      : L2("Създава само липсващи папки. Нищо не се трие.", "Creates missing folders only. Nothing is deleted."))}</div>`;
    if (isAdmin() && !canManage()) h += `<div class="note bad" id="needsConnectAdmin">${esc(T(NEEDS_CONNECT_ADMIN))}${state.me ? "" : esc(L2(" (Текущият потребител не можа да се разпознае.)", " (The current user could not be identified.)"))}</div>`;
    if (state.fixLog.length) h += `<div class="note">${state.fixLog.map((x) => `<div class="${x.ok ? "" : "bad"}">${x.ok ? "✓" : "✗"} ${esc(T(x))}</div>`).join("")}</div>`;
    for (const [sec, bg, en] of SECTIONS) {
      const list = r.items.filter((i) => i.section === sec);
      if (!list.length) continue;
      const okN = list.filter((i) => i.state === "ok").length;
      h += `<h2>${esc(L2(bg, en))} · ${okN}/${list.length}</h2>`;
      for (const i of list) {
        h += `<div class="item ${i.state}"><span class="dot"></span><div class="body"><div>${esc(T(i))}${i.detail ? ` <span class="sub">– ${esc(T(i.detail))}</span>` : ""}</div>`;
        if (i.lines && i.lines.length) h += `<div class="lines">${i.lines.map((l) => `<div>${esc(T(l))}</div>`).join("")}</div>`;
        if (i.fix && i.fix.kind === "library") h += `<ol class="help">${E.libraryHelp(i.fix.name, state.project.id, lang).slice(1).map((l) => `<li>${esc(l.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol><div class="sub">${esc(E.libraryHelp(i.fix.name, state.project.id, lang)[0])}</div>`;
        if (i.fix && i.fix.kind === "policy" && canManage()) {
          const key = i.fix.lib;
          if (state.confirm && state.confirm.key === key) h += renderConfirm(state.confirm);
          else h += `<div class="bar"><button class="small" data-act="policyAsk" data-lib="${esc(key)}" ${state.busy ? "disabled" : ""}>${esc(L2("Пренапиши правата", "Rewrite access"))}</button></div>`;
        }
        if (i.blockedBy === "groups") h += `<div class="sub">${esc(L2("Първо създайте липсващите групи, после пренапишете правата.", "Create the missing groups first, then rewrite the access."))}</div>`;
        if (i.blockedBy === "near") h += `<div class="sub">${esc(L2("Пренаписването е спряно, докато има групи с подобни имена (вижте „Групи“).", "Rewriting is blocked while groups with similar names exist (see \"Groups\")."))}</div>`;
        if (i.reportOnly) h += `<div class="sub">${esc(L2("Само доклад: този проект не се пренаписва (expected.js REPORT_ONLY).", "Report only: this project is never rewritten (expected.js REPORT_ONLY)."))}</div>`;
        if (i.id.startsWith("acc:") && state.originals[i.id.slice(4)]) h += `<div class="bar"><button class="small secondary" data-act="oldPolicy" data-lib="${esc(i.id.slice(4))}">${esc(L2("Изтегли първоначалните права (JSON)", "Download the original access (JSON)"))}</button></div>`;
        h += `</div></div>`;
      }
    }
    return h;
  }

  const LV = { edit: ["Edit", "Edit"], read: ["Read", "Read"], none: ["Няма", "No access"] };
  const lvText = (x) => (LV[x] ? LV[x][lang === "bg" ? 0 : 1] : String(x));
  /** The confirmation: before -> after per principal and definition, member counts, what is dropped, why it is refused. */
  function renderConfirm(c) {
    const spec = E.LIBRARIES.find((l) => l.key === c.key);
    let h = `<div class="confirm"><div><b>${esc(L2(`Пренаписване на правата на ${c.libName}`, `Rewrite the access of ${c.libName}`))}</b> – ${esc(L2("преди → след (прочетено току-що от Connect)", "before → after (just read from Connect)"))}</div>`;
    h += `<table><tr><th>${esc(L2("Кой", "Who"))}</th><th>${esc(L2("Членове", "Members"))}</th><th>${esc(L2("Библиотека", "Library"))}</th>${spec.defs.map((d) => `<th>${esc(d.id)}</th>`).join("")}</tr>`;
    for (const r of c.change.rows) {
      const who = r.who === "default" ? L2("Всички членове (без група от шаблона)", "All members (not in a template group)") : r.who + (r.template ? "" : L2(" – извън шаблона", " – outside the template"));
      const m = r.groupId ? c.members[r.groupId] : null;
      const mem = !r.groupId ? "–" : m == null ? "?" : String(m);
      h += `<tr${r.losesAll ? ` class="bad"` : ""}><td>${esc(who)}</td><td class="n${r.groupId && m === 0 ? " hot" : ""}">${esc(mem)}</td>${r.cells.map((x) => x.before === x.after
        ? `<td>${esc(lvText(x.after))}</td>` : `<td class="chg">${esc(lvText(x.before))} → <b>${esc(lvText(x.after))}</b></td>`).join("")}</tr>`;
    }
    h += `</table>`;
    const losing = c.change.rows.filter((r) => r.losesAll);
    if (losing.length) h += `<div class="bad">${esc(L2("Губят всякакъв достъп: ", "Lose all access: ") + losing.map((r) => (r.who === "default" ? L2("всички членове без група", "all members without a group") : r.who)).join(", "))}</div>`;
    if (c.change.unknown.length) h += `<div class="bad">${esc(L2(`Премахват се ${c.change.unknown.length} правила, които панелът не разпознава (Deny или непознат получател).`, `${c.change.unknown.length} statements the panel does not recognise (Deny or unknown principal) are removed.`))}</div>`;
    h += `<div class="sub">${esc(L2("Преди записа правата се четат отново (ако са променени междувременно – спира) и текущите се архивират в _ArstenDocs/Backups (или се изтеглят).", "Before the write the access is read again (it stops if it changed meanwhile) and the current one is saved to _ArstenDocs/Backups (or downloaded)."))}</div>`;
    if (c.refusals.length) h += `<div class="bad"><b>${esc(L2("Не може да се пренапише:", "Cannot rewrite:"))}</b>${c.refusals.map((x) => `<div>• ${esc(T(x))}</div>`).join("")}</div>`;
    h += `<div class="bar">${c.refusals.length ? "" : `<button class="small danger" data-act="policyGo" data-lib="${esc(c.key)}" ${state.busy ? "disabled" : ""}>${esc(L2("Да, пренапиши", "Yes, rewrite"))}</button>`}
      <button class="small secondary" data-act="policyNo">${esc(c.refusals.length ? L2("Затвори", "Close") : L2("Отказ", "Cancel"))}</button></div></div>`;
    return h;
  }

  const KIND_ORDER = ["raw", "double", "test", "log", "orphan"];
  function renderHealth() {
    let h = `<div class="bar"><button class="small secondary" data-act="health" ${state.busy ? "disabled" : ""}>${esc(state.report ? L2("Провери отново", "Check again") : L2("Провери", "Check"))}</button>`;
    h += `<button class="small secondary" data-act="csv" ${state.report ? "" : "disabled"}>${esc(L2("Експорт CSV", "Export CSV"))}</button></div>`;
    h += `<div class="sub">${esc(L2("Само четене: нищо не се променя.", "Read only: nothing is changed."))}</div>`;
    const r = state.report;
    if (!r) return h;
    if (state.orphanNote) h += `<div class="note">${esc(state.orphanNote)}</div>`;
    const hot = (n) => (n ? ` class="n hot"` : ` class="n"`);
    // round 19 L7: the wide tables scroll inside their own box, not the page (375 px)
    const WRAP = `<div class="hscroll" style="overflow-x:auto;max-width:100%">`;
    h += `<h2>${esc(L2("По дефиниции", "By definition"))}</h2>${WRAP}<table><tr><th>${esc(L2("Библиотека · дефиниция", "Library · definition"))}</th><th>${esc(L2("Записи", "Records"))}</th>
      <th title="frn:entity:…$…">${esc(L2("Сурови $", "Raw $"))}</th><th title="frn:entity:…%2524…">%2524</th><th>${esc(L2("Тестови", "Test"))}</th><th title="${esc(L2("над 90 % от лимита на историята на инструмента", "over 90 % of the tool's history cap"))}">${esc(L2("Дълги истории", "Long logs"))}</th><th>${esc(L2("Сираци", "Orphans"))}</th><th title="${esc(L2("не са намерени, но може да са в незареден модел или търсенето им се е провалило", "not found, but may be in a model that is not loaded, or their lookup failed"))}">${esc(L2("Неизвестни", "Unknown"))}</th></tr>`;
    for (const x of r.rows) h += x.noAccess ? `<tr class="bad"><td>${esc(x.lib)} · <b>${esc(x.def)}</b></td><td colspan="7">${esc(L2("няма достъп – записите не могат да се прочетат с вашите права", "no access – the records cannot be read with your rights"))}</td></tr>` : `<tr><td>${esc(x.lib)} · <b>${esc(x.def)}</b></td><td class="n">${x.count}</td><td${hot(x.raw)}>${x.raw}</td><td${hot(x.double)}>${x.double || 0}</td><td${hot(x.test)}>${x.test}</td><td${hot(x.longLogs)} title="&gt; ${H.logCap(x.def)}">${x.longLogs}</td><td${hot(x.orphans)}>${x.orphans == null ? "–" : x.orphans}</td><td class="n">${x.unknown == null ? "–" : x.unknown}</td></tr>`;
    h += `</table></div>`;
    for (const kind of KIND_ORDER) {
      const list = r.issues.filter((i) => i.kind === kind);
      if (!list.length) continue;
      h += `<h2>${esc(H.KIND[kind][lang === "bg" ? 0 : 1])} · ${list.length}</h2>`;
      if (kind === "raw") h += `<div class="sub" style="margin-bottom:4px">${esc(L2("Connect и Tekla не показват тези записи. Стомана ги премества с „Премести“; другите панели още не.", "Connect and Tekla never show these records. Steel moves them with \"Премести\"; the other panels do not yet."))}</div>`;
      h += `${WRAP}<table><tr><th>${esc(L2("Дефиниция", "Definition"))}</th><th>${esc(L2("Такт / марка", "Pour / mark"))}</th><th>${esc(L2("Линк", "Link"))}</th><th>${esc(L2("Подробно", "Detail"))}</th><th></th></tr>`;
      for (const [k, i] of list.slice(0, 200).entries()) h += `<tr><td>${esc(i.def)}</td><td>${esc(i.label)}</td><td class="mono">${esc(i.link)}</td><td>${esc(i.detail)}</td>
        <td>${i.guids.length && kind !== "orphan" ? `<button class="small secondary" data-act="showIssue" data-kind="${kind}" data-i="${k}">${esc(L2("Покажи", "Show"))}</button>` : ""}</td></tr>`;
      h += `</table></div>${list.length > 200 ? `<div class="sub">${esc(L2(`… и още ${list.length - 200} (всички са в CSV)`, `… and ${list.length - 200} more (all in the CSV)`))}</div>` : ""}`;
    }
    return h;
  }

  function feedRows() {
    if (!state.data) return [];
    return H.feed(state.data.records, { since: H.daysAgo(state.feed.days) });
  }
  function renderFeed() {
    let h = `<div class="bar"><button class="small ${state.feed.days === 7 ? "" : "secondary"}" data-act="days" data-d="7">${esc(L2("7 дни", "7 days"))}</button>
      <button class="small ${state.feed.days === 30 ? "" : "secondary"}" data-act="days" data-d="30">${esc(L2("30 дни", "30 days"))}</button>
      <button class="small secondary" data-act="feedReload" ${state.busy ? "disabled" : ""}>${esc(L2("Обнови", "Reload"))}</button>
      <button class="small secondary" data-act="backup" ${state.busy ? "disabled" : ""}>${esc(L2("Изтегли архив (JSON)", "Download archive (JSON)"))}</button></div>`;
    if (!state.data) return h + `<div class="note">${esc(L2("Зареждане…", "Loading…"))}</div>`;
    const all = feedRows();
    const people = [...new Set(all.map((r) => r.who).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const tools = [...new Set(all.map((r) => T(r.tool)))].sort((a, b) => a.localeCompare(b));
    h += `<div class="bar"><select id="selWho"><option value="">${esc(L2("Всички хора", "Everyone"))}</option>${people.map((p) => `<option ${p === state.feed.who ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
      <select id="selTool"><option value="">${esc(L2("Всички инструменти", "All tools"))}</option>${tools.map((p) => `<option ${p === state.feed.tool ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>`;
    const rows = H.filterFeed(all, state.feed.who, state.feed.tool);
    state.feedShown = rows;
    if (!rows.length) return h + `<div class="note">${esc(L2("Няма промени за периода.", "No changes in this period."))}</div>`;
    h += `<div class="sub">${esc(L2(`${rows.length} промени`, `${rows.length} changes`))}</div><div class="feed">`;
    for (const [k, r] of rows.slice(0, 500).entries()) {
      h += `<div class="row"><div class="hd"><b>${esc(I18N ? I18N.fmtDate(r.date, lang) : r.date)} ${esc(r.time)}</b><span>${esc(r.who || "?")}</span><span class="tag">${esc(T(r.tool))}</span>${r.label ? `<span>${esc(r.label)}</span>` : ""}
        ${r.guids.length ? `<button class="small secondary" style="margin-left:auto" data-act="showFeed" data-i="${k}">${esc(L2("Покажи в модела", "Show in model"))}</button>` : ""}</div>
        <div class="sub">${esc(I18N ? I18N.logText(r.what, lang) : r.what)}</div></div>`;
    }
    h += `</div>${rows.length > 500 ? `<div class="sub">${esc(L2("Показани са първите 500.", "The first 500 are shown."))}</div>` : ""}`;
    return h;
  }

  function render() {
    if (!state.project) return;
    document.documentElement.lang = lang;
    $("title").textContent = L2("Администрация", "Administration");
    $("selLang").value = lang;
    $("tabs").innerHTML = TABS.map(([id, bg, en]) => `<button class="small ${state.tab === id ? "on" : ""}" data-tab="${id}">${esc(L2(bg, en))}</button>`).join("");
    $("pane").innerHTML = state.tab === "setup" ? renderSetup() : state.tab === "health" ? renderHealth() : renderFeed();
    const w = $("selWho"), t = $("selTool");
    if (w) w.onchange = (e) => { state.feed.who = e.target.value; render(); };
    if (t) t.onchange = (e) => { state.feed.tool = e.target.value; render(); };
  }

  const run = (fn) => { if (state.busy) return; state.busy = true; render(); return guarded(fn); };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !state.project) return;
    if (b.dataset.tab) {
      state.tab = b.dataset.tab; render();
      if (state.tab === "health" && !state.report) run(runHealth);
      if (state.tab === "feed" && !state.data) run(loadData);
      return;
    }
    const act = b.dataset.act;
    if (act === "setup") run(async () => { state.fixLog = []; await runSetup(); });
    else if (act === "create") run(createMissing);
    else if (act === "policyAsk") run(() => prepareRewrite(b.dataset.lib));
    else if (act === "policyNo") { state.confirm = null; render(); }
    else if (act === "policyGo") run(() => rewritePolicy(b.dataset.lib));
    else if (act === "oldPolicy") { const o = state.originals[b.dataset.lib]; if (o) download(`policy_${o.name.replace(/[^\p{L}\p{N}_-]+/gu, "_")}_${fileStem()}.json`, JSON.stringify(o.policy, null, 1), "application/json"); }
    else if (act === "health") run(runHealth);
    else if (act === "csv") { if (state.report) download(`arsten-health_${fileStem()}.csv`, H.toCsv(state.report, lang), "text/csv;charset=utf-8"); }
    else if (act === "showIssue") { const i = state.report.issues.filter((x) => x.kind === b.dataset.kind)[+b.dataset.i]; if (i) guarded(() => selectGuids(i.guids)); }
    else if (act === "days") { state.feed.days = +b.dataset.d; render(); }
    else if (act === "feedReload") run(loadData);
    else if (act === "showFeed") { const r = (state.feedShown || [])[+b.dataset.i]; if (r) guarded(() => selectGuids(r.guids)); }
    else if (act === "backup") run(backup);
  });
  $("selLang").onchange = (e) => { lang = I18N ? I18N.setLang(e.target.value) : e.target.value; render(); relabelStatus(); };

  async function start(api, client, core) {
    state.api = api;
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Администрация (admin)", lang: () => lang });   // round 19 M1: before the access check, so a denied screen's diagnostics name the panel
    const access = window.ARSTEN_DEMO ? (window.ARSTEN_DEMO_ACCESS || { allowed: true, role: "admin", caps: [] })
      : await ArstenAccess.check({ api, getToken, app: "projectAdmin", config: ACCESS_CONFIG });
    if (I18N) { lang = await I18N.pickLang(api, access, OLD_LANG); $("selLang").value = lang; }   // stored choice, else the Connect user's language
    if (!access.allowed) { state.api = null; ArstenAccess.renderDenied(document.body, lang, access); return; }
    state.access = access;
    try { const u = await api.user.getUser(); if (u) state.me = { id: u.id, email: u.email, tiduuid: u.tiduuid, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "" }; } catch {}
    state.project = (await api.project.getProject()) || {};
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Администрация (admin)", projectId: state.project.id, redact: [state.me && state.me.name], lang: () => lang });   // A23
    state.client = client || new A.PsetClient({ region: state.project.location || "europe", getToken });
    state.core = core || PH.coreClient(ArstenAccess.coreBase(state.project.location), getToken);
    $("main").hidden = false;
    await run(runSetup);
  }
  window.AdminApp = { start, state, _token: { getToken, onToken, waiting: () => waiters.length } };   // _token: tests (round 17 L3)

  function onEvent(event, data) { if (event === "extension.accessToken") onToken(data); }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus(I18N ? I18N.word("notInside", lang) : "Not inside Trimble Connect.", true);
    return;
  }
  if (I18N) setStatus(I18N.word("connecting", lang));
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus((I18N ? I18N.word("connectFail", lang) : "Could not connect to Trimble Connect") + ": " + errText(e), true));
})();
