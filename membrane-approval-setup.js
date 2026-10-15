/*
 * DugganUSA Membrane -> ServiceNow: verdicts as approval stages.
 *
 * Paste into System Definition > Scripts - Background and Run (admin). Idempotent: running it again
 * updates the same records instead of duplicating them. Creates three things, all removable:
 *
 *   1. Script Include  DugganUSAMembrane   calls the DugganUSA package check (public, no key)
 *   2. Catalog item    "Install a software package" (name, ecosystem, version)
 *   3. Two business rules on sc_req_item (fail closed): gate (sync, after insert) and guard (before
 *      update, runs last). The verdict of record is the first Membrane work note (journal), never an
 *      editable field; no verdict means ERROR, which waits for a person:
 *        BLOCK  -> request rejected and closed, with the reason
 *        REVIEW -> an approval is created for the approver group/user below
 *        ALLOW  -> approved automatically
 *        error  -> left for a human (never auto-approved on a failed check)
 *      Every verdict, its reason and the raw source are written to the request's work notes:
 *      the platform's own audit trail.
 *
 * Undo: delete the Script Include, the catalog item and the business rules named DugganUSA Membrane. Nothing else is changed.
 * Data sent to DugganUSA: the package name, ecosystem and version. Nothing about the requester.
 */
(function membraneSetup() {
  var APPROVER_USER = 'admin';           // user_name who approves REVIEW verdicts; change for production
  var ENDPOINT = 'https://analytics.dugganusa.com/api/v1/mcp';

  function upsert(table, keyField, keyValue, fields) {
    var gr = new GlideRecord(table);
    gr.addQuery(keyField, keyValue);
    gr.query();
    var exists = gr.next();
    if (!exists) { gr.initialize(); gr.setValue(keyField, keyValue); }
    for (var f in fields) gr.setValue(f, fields[f]);
    var id = exists ? gr.update() : gr.insert();
    gs.info('[membrane-setup] ' + (exists ? 'updated ' : 'created ') + table + ' ' + keyValue + ' -> ' + id);
    return id;
  }

  // 1. Script Include
  var includeScript = [
    "var DugganUSAMembrane = Class.create();",
    "DugganUSAMembrane.prototype = {",
    "  initialize: function () { this.endpoint = '" + ENDPOINT + "'; },",
    "  // Returns { verdict: 'block'|'review'|'allow'|'error', reason, source, raw }",
    "  checkPackage: function (name, ecosystem, version) {",
    "    var args = { name: String(name || ''), ecosystem: String(ecosystem || 'npm') };",
    "    if (version) args.version = String(version);",
    "    try {",
    "      var r = new sn_ws.RESTMessageV2();",
    "      r.setEndpoint(this.endpoint); r.setHttpMethod('post'); r.setHttpTimeout(20000);",
    "      r.setRequestHeader('Content-Type', 'application/json');",
    "      r.setRequestHeader('Accept', 'application/json, text/event-stream');",
    "      r.setRequestBody(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check-package', arguments: args } }));",
    "      var resp = r.execute();",
    "      if (resp.getStatusCode() != 200) return { verdict: 'error', reason: 'HTTP ' + resp.getStatusCode() };",
    "      var body = JSON.parse(resp.getBody());",
    "      var t = JSON.parse(body.result.content[0].text);",
    "      var v = String(t.verdict || '').toLowerCase();",
    "      if (['block', 'review', 'allow'].indexOf(v) < 0) v = 'error';",
    "      return { verdict: v, reason: t.reason || '', source: t.source || '', raw: t };",
    "    } catch (e) { return { verdict: 'error', reason: 'check failed: ' + e }; }",
    "  },",
    "  type: 'DugganUSAMembrane'",
    "};"
  ].join('\n');
  upsert('sys_script_include', 'api_name', 'global.DugganUSAMembrane', {
    name: 'DugganUSAMembrane', script: includeScript, active: true, access: 'public',
    description: 'DugganUSA Membrane: package verdicts (block/review/allow) for approval stages.'
  });

  // 2. Catalog item + variables
  var catId = upsert('sc_cat_item', 'name', 'Install a software package', {
    short_description: 'Request a dependency. The DugganUSA Membrane checks it first: blocked packages are refused with the reason, known-vulnerable versions go to an approver, clean ones are approved automatically.',
    active: true
  });
  var cat = new GlideRecord('sc_category'); cat.addQuery('title', 'Software'); cat.query();
  if (cat.next()) { var ci = new GlideRecord('sc_cat_item'); if (ci.get(catId)) { ci.setValue('category', cat.getUniqueValue()); ci.update(); } }
  var cats = new GlideRecord('sc_catalog'); cats.addQuery('title', 'Service Catalog'); cats.query();
  if (cats.next()) { var ci2 = new GlideRecord('sc_cat_item'); if (ci2.get(catId)) { ci2.setValue('sc_catalogs', cats.getUniqueValue()); ci2.update(); } }
  var vars = [
    ['dusa_package_name', 'Package name', 100, true],
    ['dusa_ecosystem', 'Ecosystem (npm, PyPI or RubyGems)', 200, true],
    ['dusa_version', 'Exact version (recommended)', 300, false]
  ];
  for (var i = 0; i < vars.length; i++) {
    var vr = new GlideRecord('item_option_new');
    vr.addQuery('cat_item', catId); vr.addQuery('name', vars[i][0]); vr.query();
    var ex = vr.next(); if (!ex) vr.initialize();
    vr.setValue('cat_item', catId); vr.setValue('name', vars[i][0]); vr.setValue('question_text', vars[i][1]);
    vr.setValue('type', 6); vr.setValue('order', vars[i][2]); vr.setValue('mandatory', vars[i][3]);
    if (vars[i][0] === 'dusa_ecosystem') vr.setValue('default_value', 'npm');
    ex ? vr.update() : vr.insert();
  }

  // 3. Business rules: the gate FAILS CLOSED (security review 2026-10-15: the first version ran async,
  //    so the platform's request-level auto-approval could cascade "approved" onto REVIEW and BLOCK
  //    items). Now: decide synchronously right after insert (variables exist then); create the approver; and a guard
  //    reverts any later attempt to approve a gated item that still has a pending approval or a BLOCK.
  // Seal secret (security review of the public v3: a work note is forgeable by anyone who can add one).
  // Admin-only, private (never in update sets). The gate seals its verdict with it; the guard verifies.
  var prop = new GlideRecord('sys_properties'); prop.addQuery('name', 'dugganusa.membrane.seal_secret'); prop.query();
  if (!prop.next()) {
    prop.initialize(); prop.setValue('name', 'dugganusa.membrane.seal_secret'); prop.setValue('type', 'password2');
    prop.setValue('value', gs.generateGUID() + gs.generateGUID()); prop.setValue('read_roles', 'admin'); prop.setValue('write_roles', 'admin');
    prop.setValue('private', true); prop.setValue('description', 'DugganUSA Membrane: seals gate verdicts so they cannot be forged in a work note.'); prop.insert();
    gs.info('[membrane-setup] created seal secret (admin-only, private)');
  }
  var approver = new GlideRecord('sys_user'); approver.get('user_name', APPROVER_USER);
  var approverId = approver.isValidRecord() ? approver.getUniqueValue() : '';
  // The verdict of record is the FIRST "DugganUSA Membrane verdict:" work note: journal entries can't be
  // edited by requesters or fulfillers, unlike short_description (an automated security review found the
  // guard trusted a field any editor could rewrite). short_description is display only.
  var gateScript = [
    "(function executeRule(current, previous) {",
    "  var res, name = '', eco = '', ver = '';",
    "  try {",
    "    name = current.variables.dusa_package_name + ''; eco = current.variables.dusa_ecosystem + ''; ver = current.variables.dusa_version + '';",
    "    // Strict charset on every signed field (security review: delimiter/control characters made the seal ambiguous).",
    "    var SAFE = /^[A-Za-z0-9@._\\/+~-]{1,214}$/;",
    "    if (!SAFE.test(name) || !SAFE.test(eco) || (ver && !SAFE.test(ver))) res = { verdict: 'error', reason: 'package, ecosystem or version contains characters outside [A-Za-z0-9@._/+~-]; a person must review' };",
    "    else res = new global.DugganUSAMembrane().checkPackage(name, eco, ver);",
    "  } catch (e) { res = { verdict: 'error', reason: 'gate failed: ' + e }; }",
    "  // Seal binds the verdict to THIS item and THESE exact values (a later edit to the package voids it).",
    "  // JSON (unambiguous) and a nested keyed hash SHA256(k||SHA256(k||m)): resists length extension.",
    "  var payload = JSON.stringify([current.getUniqueValue(), res.verdict, eco, name, ver]), k = gs.getProperty('dugganusa.membrane.seal_secret'), D = new GlideDigest();",
    "  var seal = (D.getSHA256Hex(k + (D.getSHA256Hex(k + payload) + '').toLowerCase()) + '').toLowerCase();",
    "  current.work_notes = 'DugganUSA Membrane verdict: ' + res.verdict.toUpperCase() + ' for ' + eco + ' ' + name + (ver ? '@' + ver : '') + '\\nReason: ' + res.reason + (res.source ? '\\nSource: ' + res.source : '') + '\\nSeal: ' + seal + ' ' + encodeURIComponent(payload);",
    "  current.short_description = 'Package request (Membrane: ' + res.verdict + ') ' + eco + ' ' + name + (ver ? '@' + ver : '');  // display only",
    "  if (res.verdict === 'block') { current.approval = 'rejected'; current.state = 4; }",
    "  else if (res.verdict === 'allow') { current.approval = 'approved'; }",
    "  else { current.approval = 'requested'; }  // review AND error: a person decides; never auto-approved",
    "  current.setWorkflow(false); current.update();",
    "  if (res.verdict === 'review' || res.verdict === 'error') {",
    "    var ap = new GlideRecord('sysapproval_approver'); ap.initialize();",
    "    ap.setValue('sysapproval', current.getUniqueValue()); ap.setValue('document_id', current.getUniqueValue()); ap.setValue('source_table', 'sc_req_item');",
    "    ap.setValue('approver', '" + approverId + "'); ap.setValue('state', 'requested');",
    "    ap.setValue('comments', 'DugganUSA Membrane: ' + res.verdict.toUpperCase() + ' — ' + res.reason); ap.insert();",
    "  }",
    "})(current, previous);"
  ].join('\n');
  var guardScript = [
    "(function executeRule(current, previous) {",
    "  // Scope check in the script, not a filter: moving an item to another catalog item must not escape the guard.",
    "  var CAT = '" + catId + "'; if (current.cat_item != CAT && !(previous && previous.cat_item == CAT)) return;",
    "  if (previous && previous.cat_item == CAT && current.cat_item != CAT) { current.cat_item = CAT; gs.warn('[membrane-guard] kept catalog item on ' + current.number); }",
    "  // Verdict of record: the first Membrane work note whose SEAL verifies (admin-only secret), bound to",
    "  // this item and its current package values. A forged note, an edited package, or no note at all = error.",
    "  var secret = gs.getProperty('dugganusa.membrane.seal_secret'), verdict = 'error';",
    "  var cur = [current.getUniqueValue(), '', current.variables.dusa_ecosystem + '', current.variables.dusa_package_name + '', current.variables.dusa_version + ''];",
    "  var j = new GlideRecord('sys_journal_field'); j.addQuery('element_id', current.getUniqueValue()); j.addQuery('element', 'work_notes');",
    "  j.addQuery('value', 'STARTSWITH', 'DugganUSA Membrane verdict:'); j.orderBy('sys_created_on'); j.query();",
    "  var sawNote = false;",
    "  while (j.next()) {",
    "    sawNote = true;",
    "    var sm = /\\nSeal: ([0-9a-fA-F]{64}) (\\S+)$/.exec(j.value + ''); if (!sm || !secret) continue;",
    "    var payload = decodeURIComponent(sm[2]), D = new GlideDigest();",
    "    var expect = (D.getSHA256Hex(secret + (D.getSHA256Hex(secret + payload) + '').toLowerCase()) + '').toLowerCase();",
    "    if (expect != sm[1].toLowerCase()) { gs.warn('[membrane-guard] ignored forged verdict note on ' + current.number); continue; }",
    "    var parts; try { parts = JSON.parse(payload); } catch (pe) { continue; }",
    "    if (!(parts instanceof Array) || parts.length != 5 || parts[0] != cur[0]) continue;",
    "    if (parts[2] != cur[2] || parts[3] != cur[3] || parts[4] != cur[4]) { gs.warn('[membrane-guard] package changed after the verdict on ' + current.number + ': verdict void'); verdict = 'error'; break; }",
    "    verdict = ['allow', 'review', 'block', 'error'].indexOf(parts[1]) >= 0 ? parts[1] : 'error'; break;",
    "  }",
    "  if (!sawNote && current.isNewRecord()) return;  // the gate writes the sealed verdict right after insert",
    "  if (verdict === 'allow') return;",
    "  if (verdict === 'block') {",
    "    if (current.approval != 'rejected' || current.state != 4) { current.approval = 'rejected'; current.state = 4; gs.warn('[membrane-guard] kept BLOCK rejected and closed on ' + current.number); }",
    "    return;",
    "  }",
    "  // review / error: nothing proceeds until a person's approval record says approved.",
    "  // A person's approval counts only if that person is not the requester or the opener (no self-approval).",
    "  var ok = new GlideRecord('sysapproval_approver'); ok.addQuery('sysapproval', current.getUniqueValue()); ok.addQuery('state', 'approved');",
    "  ok.addQuery('approver', '!=', current.request.requested_for + ''); ok.addQuery('approver', '!=', current.opened_by + ''); ok.query();",
    "  if (ok.hasNext()) return;",
    "  if (current.approval != 'requested') { gs.warn('[membrane-guard] reverted approval ' + current.approval + ' -> requested on ' + current.number + ' (' + verdict + ')'); current.approval = 'requested'; }",
    "  if (current.state == 3) { gs.warn('[membrane-guard] reverted Closed Complete on unapproved ' + current.number); current.state = previous ? previous.state : 1; }",
    "})(current, previous);"
  ].join('\n');
  // Retire the first (async) version if present.
  var old = new GlideRecord('sys_script'); old.addQuery('name', 'DugganUSA Membrane gate'); old.addQuery('when', 'async'); old.query();
  while (old.next()) { old.setValue('active', false); old.update(); gs.info('[membrane-setup] deactivated async gate ' + old.getUniqueValue()); }
  var cond = 'cat_item=' + catId + '^EQ';
  // After insert, SYNCHRONOUS: catalog variables are written after the item row, so a before-insert
  // rule would read an empty package name. The guard below enforces the verdict on every later update.
  upsert('sys_script', 'name', 'DugganUSA Membrane gate (sync)', {
    collection: 'sc_req_item', when: 'after', action_insert: true, action_update: false, active: true, order: 50,
    filter_condition: cond, script: gateScript,
    description: 'Decides the Membrane verdict synchronously on insert; fails closed (review and error wait for a person).'
  });
  // v2's separate approver rule read short_description; the gate creates the approval itself now.
  var oldAp = new GlideRecord('sys_script'); oldAp.addQuery('name', 'DugganUSA Membrane approver'); oldAp.query();
  while (oldAp.next()) { oldAp.setValue('active', false); oldAp.update(); gs.info('[membrane-setup] deactivated v2 approver rule'); }
  upsert('sys_script', 'name', 'DugganUSA Membrane guard', {
    collection: 'sc_req_item', when: 'before', action_insert: false, action_update: true, active: true, order: 10000,
    filter_condition: '', script: guardScript,
    description: 'Reverts any approval that would bypass a pending Membrane review or a BLOCK.'
  });

  gs.info('[membrane-setup] done. Catalog item sys_id ' + catId + '. Test: request it with npm zod 3.23.8 (ALLOW), npm lodash 4.17.21 (REVIEW: 3 published vulnerabilities), RubyGems eth-keystore-utils (BLOCK).');
})();
