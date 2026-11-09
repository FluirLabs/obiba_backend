export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Obiba Support</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#0b0b0c;--ink2:#3a3a3c;--muted:#6e6e73;--line:#e5e5ea;--hair:#ececf0;--canvas:#f7f8fa;--brand:#0a84ff;--brandInk:#005bb5;--soft:#eaf4ff;--ok:#18804a;--warn:#9a6212;--bad:#c7353b}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,system-ui,sans-serif;color:var(--ink);background:#fff;font-size:14px;line-height:1.45}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;border-bottom:1px solid var(--hair);position:sticky;top:0;background:#fff;z-index:2}
header h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em}
header .who{display:flex;align-items:center;gap:10px;color:var(--muted)}
select,textarea,input[type=text]{font:inherit;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#fff}
textarea{width:100%;min-height:84px;resize:vertical}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;background:var(--brand);color:#fff}
button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
button.danger{background:#fff;color:var(--bad);border:1px solid #f0c9cb}
button:disabled{opacity:.45;cursor:not-allowed}
main{display:grid;grid-template-columns:minmax(320px,420px) 1fr;min-height:calc(100vh - 57px)}
@media (max-width:900px){main{grid-template-columns:1fr}}
#queue{border-right:1px solid var(--hair);background:var(--canvas)}
.qhead{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 8px}
.qhead h2{margin:0;font-size:13px;font-weight:600;color:var(--brandInk);text-transform:uppercase;letter-spacing:.06em}
.case{display:block;width:100%;text-align:left;background:transparent;color:var(--ink);border:0;border-bottom:1px solid var(--hair);border-radius:0;padding:14px 20px;font-weight:400}
.case:hover{background:#fff}
.case.on{background:#fff;box-shadow:inset 3px 0 0 var(--brand)}
.case .n{font-weight:600}
.case .m{color:var(--muted);font-size:13px;margin-top:2px}
#detail{padding:28px 32px 64px;max-width:980px}
h3{font-size:13px;font-weight:600;color:var(--brandInk);text-transform:uppercase;letter-spacing:.06em;margin:32px 0 10px}
.title{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0}
.sub{color:var(--muted);margin-top:4px}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:8px 10px 8px 0;border-bottom:1px solid var(--hair);vertical-align:top}
th{font-weight:500;color:var(--muted);width:200px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}
.status-OPEN{color:var(--warn);font-weight:600}.status-VERIFIED{color:var(--brandInk);font-weight:600}.status-APPROVED{color:var(--brandInk);font-weight:600}.status-SUBMITTED{color:var(--ok);font-weight:600}.status-REJECTED,.status-CANCELLED{color:var(--muted);font-weight:600}
.panel{border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-top:16px}
.panel h4{margin:0 0 6px;font-size:15px}
.panel p{margin:0 0 12px;color:var(--ink2)}
label.check{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--hair)}
label.check input{margin-top:3px}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.msg{margin-top:12px;font-weight:500}
.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
.empty{color:var(--muted);padding:24px 20px}
.note{color:var(--muted);font-size:13px}
</style>
</head>
<body>
<header>
  <h1>Obiba Support</h1>
  <div class="who"><span id="who">Not signed in</span><select id="staff" hidden aria-label="Local staff login"></select></div>
</header>
<main>
  <section id="queue" aria-label="Support cases">
    <div class="qhead"><h2>Account restores</h2>
      <select id="filter" aria-label="Filter cases"><option value="open">Open</option><option value="SUBMITTED">Submitted</option><option value="REJECTED">Rejected</option><option value="CANCELLED">Cancelled</option></select>
    </div>
    <div id="list"></div>
  </section>
  <section id="detail"><p class="empty">Choose a case to investigate.</p></section>
</main>
<script>
(function(){
  var devStaff = null, staff = null, current = null;
  var CHECKS = {
    called_registered_phone: ['Called the registered number', 'You spoke to the account holder on the phone number saved on the account, or confirmed the number is lost and verified them another way.'],
    id_name_matches: ['Ghana Card name matches the account', 'Seen on a video call. Do not record the card number or keep a photo.'],
    knows_recent_activity: ['Knows recent account activity', 'They described recent payments, amounts or contacts that match the activity below.']
  };
  function el(tag, attrs){
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (attrs[k] == null) continue; if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else if (k.slice(0,2) === 'on') n.addEventListener(k.slice(2), attrs[k]); else n.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  }
  function when(iso){ return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'; }
  function headers(){ var h = { 'content-type': 'application/json' }; if (devStaff && staff) h['x-goog-iap-jwt-assertion'] = 'dev:' + staff; return h; }
  function call(method, path, body){
    return fetch(path, { method: method, headers: headers(), body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error(j.message || ('Request failed (' + r.status + ')')); return j; });
    });
  }
  function kv(rows){ var t = el('table'); rows.forEach(function(r){ t.appendChild(el('tr', null, el('th', { text: r[0] }), el('td', r[2] ? { class: r[2] } : null, r[1] == null ? '-' : String(r[1])))); }); return t; }
  function list(rows, cols){ if (!rows.length) return el('p', { class: 'note', text: 'None.' }); var t = el('table'); t.appendChild(el('tr', null, cols.map(function(c){ return el('th', { text: c[0] }); }))); rows.forEach(function(r){ t.appendChild(el('tr', null, cols.map(function(c){ return el('td', c[2] ? { class: c[2] } : null, String(c[1](r) == null ? '-' : c[1](r))); }))); }); return t; }
  function loadMe(){
    return call('GET', '/v1/me').then(function(m){ document.getElementById('who').textContent = m.email + ' (' + m.role + ')'; return m; }, function(){ document.getElementById('who').textContent = 'Not authorised'; return null; });
  }
  function loadList(){
    var box = document.getElementById('list');
    return call('GET', '/v1/support-cases?status=' + encodeURIComponent(document.getElementById('filter').value)).then(function(rows){
      box.textContent = '';
      if (!rows.length) { box.appendChild(el('p', { class: 'empty', text: 'No cases here.' })); return; }
      rows.forEach(function(c){
        box.appendChild(el('button', { class: 'case' + (current === c.id ? ' on' : ''), onclick: function(){ open(c.id); } },
          el('div', { class: 'n', text: c.displayName }),
          el('div', { class: 'm', text: c.accountId }),
          el('div', { class: 'm' }, el('span', { class: 'status-' + c.status, text: c.status.charAt(0) + c.status.slice(1).toLowerCase() }), ' \\u00b7 opened ' + when(c.createdAt))));
      });
    }, function(e){ box.textContent = ''; box.appendChild(el('p', { class: 'empty', text: e.message })); });
  }
  function msg(box, text, ok){ var m = box.querySelector('.msg'); if (!m) { m = el('p', { class: 'msg' }); box.appendChild(m); } m.className = 'msg ' + (ok ? 'ok' : 'err'); m.textContent = text; }
  function actions(c, me){
    var wrap = el('div');
    var open = ['OPEN', 'VERIFIED', 'APPROVED'].indexOf(c.status) >= 0;
    if (c.status === 'OPEN') {
      var p = el('div', { class: 'panel' }, el('h4', { text: 'Verify the person' }), el('p', { text: 'Confirm every check yourself. A different admin approves after you.' }));
      var boxes = {};
      c.requiredChecks.forEach(function(k){ var cb = el('input', { type: 'checkbox' }); boxes[k] = cb; p.appendChild(el('label', { class: 'check' }, cb, el('span', null, el('strong', { text: CHECKS[k] ? CHECKS[k][0] : k }), el('br'), el('span', { class: 'note', text: CHECKS[k] ? CHECKS[k][1] : '' })))); });
      var notes = el('textarea', { placeholder: 'What you checked and how. Never write ID numbers, codes or passwords.' });
      p.appendChild(el('h4', { text: 'Investigation notes', style: 'margin-top:14px' })); p.appendChild(notes);
      p.appendChild(el('div', { class: 'row' }, el('button', { onclick: function(){
        var checks = {}; Object.keys(boxes).forEach(function(k){ checks[k] = boxes[k].checked; });
        call('POST', '/v1/support-cases/' + c.id + '/verify', { checks: checks, notes: notes.value }).then(function(){ open2(c.id); }, function(e){ msg(p, e.message); });
      }, text: 'Mark verified' })));
      wrap.appendChild(p);
    }
    if (c.status === 'VERIFIED') {
      var mine = me && c.verifiedBy && me.email.toLowerCase() === c.verifiedBy.toLowerCase();
      var a = el('div', { class: 'panel' }, el('h4', { text: 'Approve the restore' }), el('p', { text: mine ? 'You verified this case, so another admin must approve it.' : 'The move starts after ' + when(c.earliestAt) + ' and then waits 48 hours on the blockchain. The account holder can cancel from any signed-in device.' }));
      var note = el('textarea', { placeholder: 'Why you are approving.' });
      a.appendChild(note);
      a.appendChild(el('div', { class: 'row' }, el('button', { disabled: mine || !me || me.role !== 'admin' ? 'disabled' : null, onclick: function(){ call('POST', '/v1/support-cases/' + c.id + '/approve', { note: note.value }).then(function(){ open2(c.id); }, function(e){ msg(a, e.message); }); }, text: 'Approve' })));
      if (!mine && (!me || me.role !== 'admin')) a.appendChild(el('p', { class: 'note', text: 'Only admins can approve.' }));
      wrap.appendChild(a);
    }
    if (c.status === 'APPROVED') wrap.appendChild(el('div', { class: 'panel' }, el('h4', { text: 'Waiting for the review period' }), el('p', { text: 'Obiba asks the guardian to start the move automatically after ' + when(c.earliestAt) + '. The guardian re-checks the approvals, the password and session history, and the account on the blockchain.' })));
    if (open) {
      var r = el('div', { class: 'panel' }, el('h4', { text: 'Reject' }), el('p', { text: 'Ends the request and removes the new device. The account holder is emailed.' }));
      var reason = el('textarea', { placeholder: 'Reason, shown to the account holder.' });
      r.appendChild(reason);
      r.appendChild(el('div', { class: 'row' }, el('button', { class: 'danger', onclick: function(){ call('POST', '/v1/support-cases/' + c.id + '/reject', { reason: reason.value }).then(function(){ open2(c.id); }, function(e){ msg(r, e.message); }); }, text: 'Reject request' })));
      wrap.appendChild(r);
    }
    return wrap;
  }
  var meCache = null;
  function open2(id){ loadList(); open(id); }
  function open(id){
    current = id;
    var d = document.getElementById('detail');
    d.textContent = '';
    d.appendChild(el('p', { class: 'note', text: 'Loading\\u2026' }));
    Promise.all([call('GET', '/v1/support-cases/' + id), meCache ? Promise.resolve(meCache) : loadMe().then(function(m){ meCache = m; return m; })]).then(function(res){
      var c = res[0], me = res[1];
      d.textContent = '';
      d.appendChild(el('p', { class: 'title', text: c.displayName }));
      d.appendChild(el('p', { class: 'sub' }, el('span', { class: 'status-' + c.status, text: c.status.charAt(0) + c.status.slice(1).toLowerCase() }), ' \\u00b7 opened ' + when(c.createdAt) + ' \\u00b7 earliest move ' + when(c.earliestAt)));
      d.appendChild(actions(c, me));
      d.appendChild(el('h3', { text: 'Request' }));
      d.appendChild(kv([['Case', c.id, 'mono'], ['New device key', c.newPublicKey, 'mono'], ['Verified by', c.verifiedBy ? c.verifiedBy + ', ' + when(c.verifiedAt) : null], ['Approved by', c.approvedBy ? c.approvedBy + ', ' + when(c.approvedAt) : null], ['Closed', c.closedBy ? c.closedBy + ': ' + (c.closedReason || '') : null], ['Notes', c.notes]]));
      d.appendChild(el('h3', { text: 'Person' }));
      d.appendChild(kv([['Email', c.email], ['Registered phone', c.phone + (c.user.phoneVerifiedAt ? ' (verified ' + when(c.user.phoneVerifiedAt) + ')' : ' (not verified by SMS)')], ['Handle', c.user.handle ? '@' + c.user.handle : null], ['Joined', when(c.user.joinedAt)], ['Profile status', c.user.status]]));
      d.appendChild(el('h3', { text: 'Account' }));
      d.appendChild(kv([['Account', c.account.accountId, 'mono'], ['Status', c.account.status]]));
      d.appendChild(el('h3', { text: 'Devices' }));
      d.appendChild(list(c.devices, [['Key', function(x){ return x.publicKey; }, 'mono'], ['Status', function(x){ return x.status + (x.initial ? ' (first)' : ''); }], ['Added', function(x){ return when(x.createdAt); }]]));
      d.appendChild(el('h3', { text: 'Recent payments on NEAR' }));
      d.appendChild(list(c.chainActivity, [['When', function(x){ return when(x.at); }], ['Direction', function(x){ return x.direction === 'in' ? 'Received' : 'Sent'; }], ['Amount (base units)', function(x){ return x.amount; }], ['Counterparty', function(x){ return x.counterparty; }, 'mono']]));
      d.appendChild(el('h3', { text: 'Recent local services' }));
      d.appendChild(list(c.localActivity, [['When', function(x){ return when(x.at); }], ['Service', function(x){ return x.kind + ' ' + x.provider; }], ['Status', function(x){ return x.status; }]]));
      d.appendChild(el('h3', { text: 'Earlier recoveries and requests' }));
      d.appendChild(list(c.recoveries.map(function(x){ return { a: when(x.createdAt), b: 'Recovery by ' + x.method, c: x.status + (x.reason ? ': ' + x.reason : '') }; }).concat(c.otherCases.map(function(x){ return { a: when(x.createdAt), b: 'Support request', c: x.status + (x.closedReason ? ': ' + x.closedReason : '') }; })), [['When', function(x){ return x.a; }], ['What', function(x){ return x.b; }], ['Outcome', function(x){ return x.c; }]]));
      if (c.guardian.length) { d.appendChild(el('h3', { text: 'Guardian decisions' })); d.appendChild(list(c.guardian, [['When', function(x){ return when(x.at); }], ['Outcome', function(x){ return x.outcome; }], ['Failed checks', function(x){ var r = x.rules || {}; var f = Object.keys(r).filter(function(k){ return r[k] === false; }); return f.length ? f.join(', ') : (r.reason || 'none'); }]])); }
      d.appendChild(el('h3', { text: 'Audit trail' }));
      d.appendChild(list(c.trail, [['When', function(x){ return when(x.at); }], ['Who', function(x){ return x.actor; }], ['Action', function(x){ return x.action; }], ['Outcome', function(x){ return x.outcome; }]]));
    }, function(e){ d.textContent = ''; d.appendChild(el('p', { class: 'msg err', text: e.message })); });
  }
  document.getElementById('filter').addEventListener('change', loadList);
  fetch('/console/settings').then(function(r){ return r.json(); }).then(function(s){
    devStaff = s.devStaff;
    if (devStaff && devStaff.length) {
      var sel = document.getElementById('staff');
      sel.hidden = false;
      devStaff.forEach(function(e){ sel.appendChild(el('option', { value: e, text: e })); });
      var saved = null; try { saved = localStorage.getItem('obiba-staff'); } catch (e) {}
      staff = devStaff.indexOf(saved) >= 0 ? saved : devStaff[0];
      sel.value = staff;
      sel.addEventListener('change', function(){ staff = sel.value; try { localStorage.setItem('obiba-staff', staff); } catch (e) {} meCache = null; loadMe(); loadList(); if (current) open(current); });
    }
    loadMe(); loadList();
  });
})();
</script>
</body>
</html>`;
