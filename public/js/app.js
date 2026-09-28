/* RemoteWay client behaviour. Progressive enhancement only: every form and link works without JS. */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var csrf = ($('meta[name="csrf-token"]') || {}).content;

  function storage(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  /* ---------- Theme ---------- */
  function effectiveTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeIcons() {
    var dark = effectiveTheme() === 'dark';
    $$('.theme-moon').forEach(function (el) { el.classList.toggle('hidden', dark); });
    $$('.theme-sun').forEach(function (el) { el.classList.toggle('hidden', !dark); });
  }
  syncThemeIcons();
  $$('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.cookie = 'rw_theme=' + next + ';path=/;max-age=31536000;samesite=lax';
      syncThemeIcons();
    });
  });

  /* ---------- Mobile navigation ---------- */
  $$('[data-nav-toggle]').forEach(function (b) { b.addEventListener('click', function () { document.body.classList.toggle('nav-open'); }); });
  $$('[data-nav-close]').forEach(function (b) { b.addEventListener('click', function () { document.body.classList.remove('nav-open'); }); });

  /* ---------- Dropdowns: close on outside click / Escape ---------- */
  document.addEventListener('click', function (e) {
    $$('details.dropdown[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });

  /* ---------- Dismissible alerts ---------- */
  $$('[data-dismiss]').forEach(function (b) { b.addEventListener('click', function () { var a = b.closest('[data-dismissible]'); if (a) a.remove(); }); });

  /* ---------- Dialogs ---------- */
  function fillForm(form, data) {
    Object.keys(data).forEach(function (key) {
      var fields = form.querySelectorAll('[name="' + key + '"]');
      Array.prototype.forEach.call(fields, function (field) {
        var val = data[key];
        if (field.type === 'checkbox') {
          field.checked = Array.isArray(val) ? val.indexOf(field.value) >= 0 : Boolean(val);
        } else {
          field.value = val === null || val === undefined ? '' : val;
        }
      });
    });
  }
  function resetForm(form) {
    form.reset();
    var id = form.querySelector('[name="id"]');
    if (id) id.value = '';
    $$('input[type=checkbox]', form).forEach(function (c) { if (c.name === 'permissions') c.checked = false; });
    $$('.field-error', form).forEach(function (el) { el.remove(); });
    $$('.is-invalid', form).forEach(function (el) { el.classList.remove('is-invalid'); });
  }
  $$('[data-open-dialog]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var dlg = document.getElementById(btn.getAttribute('data-open-dialog'));
      if (!dlg || typeof dlg.showModal !== 'function') return;
      e.preventDefault();
      var form = dlg.querySelector('form');
      if (form && (btn.hasAttribute('data-fill') || btn.hasAttribute('data-reset-form'))) resetForm(form);
      if (form && btn.hasAttribute('data-fill')) {
        try { fillForm(form, JSON.parse(btn.getAttribute('data-fill'))); } catch (err) { /* ignore malformed data */ }
      }
      var menu = btn.closest('details'); if (menu) menu.removeAttribute('open');
      dlg.showModal();
      var first = dlg.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus();
    });
  });
  $$('[data-close-dialog]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  $$('dialog.dialog').forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    if (d.hasAttribute('data-open-on-load') && typeof d.showModal === 'function') d.showModal();
  });

  /* ---------- Confirmations for destructive forms ---------- */
  var confirmDlg;
  function confirmBox(message, onYes) {
    if (!confirmDlg) {
      confirmDlg = document.createElement('dialog');
      confirmDlg.className = 'dialog';
      var isAr = document.documentElement.lang === 'ar';
      confirmDlg.innerHTML = '<div class="dialog-body" style="padding-top:20px"><p data-msg style="font-weight:600"></p></div>' +
        '<div class="dialog-foot"><button class="btn btn-ghost" type="button" data-no>' + (isAr ? 'إلغاء' : 'Cancel') + '</button>' +
        '<button class="btn btn-danger" type="button" data-yes>' + (isAr ? 'تأكيد' : 'Confirm') + '</button></div>';
      document.body.appendChild(confirmDlg);
      confirmDlg.querySelector('[data-no]').addEventListener('click', function () { confirmDlg.close(); });
    }
    confirmDlg.querySelector('[data-msg]').textContent = message;
    var yes = confirmDlg.querySelector('[data-yes]');
    var clone = yes.cloneNode(true); yes.parentNode.replaceChild(clone, yes);
    clone.addEventListener('click', function () { confirmDlg.close(); onYes(); });
    if (typeof confirmDlg.showModal === 'function') confirmDlg.showModal(); else if (window.confirm(message)) onYes();
  }
  $$('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (form.dataset.confirmed) return;
      e.preventDefault();
      confirmBox(form.getAttribute('data-confirm'), function () { form.dataset.confirmed = '1'; form.submit(); });
    });
  });

  /* ---------- Auto-submit filter forms ---------- */
  $$('form[data-autosubmit]').forEach(function (form) {
    var timer;
    $$('select, input[type=checkbox], input[type=date]', form).forEach(function (s) { s.addEventListener('change', function () { form.submit(); }); });
    $$('input[type=search]', form).forEach(function (i) {
      i.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { form.submit(); }, 400); });
    });
  });

  /* ---------- Column visibility (saved per table) ---------- */
  $$('[data-col-menu]').forEach(function (menu) {
    var key = 'rw.cols.' + menu.getAttribute('data-col-menu');
    var table = $('[data-col-table="' + menu.getAttribute('data-col-menu') + '"]');
    var hidden = [];
    try { hidden = JSON.parse(storage(key) || '[]'); } catch (e) { hidden = []; }
    function apply() {
      if (!table) return;
      $$('[data-col]', table).forEach(function (cell) { cell.classList.toggle('col-toggle-hidden', hidden.indexOf(cell.getAttribute('data-col')) >= 0); });
    }
    $$('input[data-col]', menu).forEach(function (cb) {
      cb.checked = hidden.indexOf(cb.getAttribute('data-col')) < 0;
      cb.addEventListener('change', function () {
        var c = cb.getAttribute('data-col');
        hidden = hidden.filter(function (x) { return x !== c; });
        if (!cb.checked) hidden.push(c);
        storage(key, JSON.stringify(hidden));
        apply();
      });
    });
    apply();
  });

  /* ---------- Copy to clipboard ---------- */
  $$('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = btn.parentNode.querySelector('[data-copy-source]');
      if (!src || !navigator.clipboard) return;
      navigator.clipboard.writeText(src.textContent.trim()).then(function () {
        var old = btn.innerHTML; btn.textContent = '✓'; setTimeout(function () { btn.innerHTML = old; }, 1400);
      });
    });
  });

  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  /* ---------- Sign-up wizard ---------- */
  $$('[data-wizard]').forEach(function (form) {
    var steps = $$('[data-step]', form);
    var inds = $$('[data-step-ind]', form);
    var current = Number(form.getAttribute('data-start') || 0);
    function show(i) {
      current = i;
      steps.forEach(function (s, idx) { s.classList.toggle('hidden', idx !== i); });
      inds.forEach(function (s, idx) { s.classList.toggle('done', idx < i); s.classList.toggle('current', idx === i); });
      var f = steps[i].querySelector('input:not([type=hidden]):not([type=radio]), select'); if (f) f.focus();
    }
    function valid(step) {
      var ok = true;
      $$('input, select', step).forEach(function (el) { if (ok && typeof el.checkValidity === 'function' && !el.checkValidity()) { el.reportValidity(); ok = false; } });
      return ok;
    }
    $$('[data-next]', form).forEach(function (b) { b.addEventListener('click', function () { if (valid(steps[current])) show(current + 1); }); });
    $$('[data-prev]', form).forEach(function (b) { b.addEventListener('click', function () { show(current - 1); }); });
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && current < steps.length - 1 && e.target.tagName === 'INPUT') { e.preventDefault(); if (valid(steps[current])) show(current + 1); }
    });
    show(current);
  });

  /* ---------- Command palette (Ctrl/⌘ + K) ---------- */
  var cmdk = $('[data-cmdk]');
  if (cmdk) {
    var input = $('[data-cmdk-input]', cmdk);
    var results = $('[data-cmdk-results]', cmdk);
    var pages = JSON.parse($('[data-cmdk-pages]', cmdk).textContent);
    var i18n = JSON.parse($('[data-cmdk-i18n]', cmdk).textContent);
    var items = []; var active = 0; var seq = 0; var debounce;

    var esc = function (s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
    var iconSvg = function (name) { return '<svg class="icon icon-sm" aria-hidden="true"><use href="/icons.svg?v=' + (document.documentElement.getAttribute('data-v') || '') + '#i-' + name + '"></use></svg>'; };

    function render(groups) {
      items = [];
      var html = '';
      groups.forEach(function (g) {
        if (!g.items.length) return;
        html += '<div class="cmdk-group">' + esc(g.title) + '</div>';
        g.items.forEach(function (it) {
          items.push(it);
          html += '<a class="cmdk-item" href="' + esc(it.href) + '" data-idx="' + (items.length - 1) + '">' + iconSvg(it.icon || 'arrow-right') + '<span>' + esc(it.title) + '</span>' + (it.subtitle ? '<span class="sub">' + esc(it.subtitle) + '</span>' : '') + '</a>';
        });
      });
      results.innerHTML = html || '<div class="cmdk-empty">' + esc(i18n.empty) + '</div>';
      active = 0; highlight();
    }
    function highlight() {
      $$('.cmdk-item', results).forEach(function (el, i) { el.classList.toggle('active', i === active); if (i === active) el.scrollIntoView({ block: 'nearest' }); });
    }
    function search() {
      var q = input.value.trim();
      var ql = q.toLowerCase();
      var matchedPages = pages.filter(function (p) { return !ql || p.title.toLowerCase().indexOf(ql) >= 0; });
      if (q.length < 2) { render([{ title: i18n.pages, items: matchedPages }]); return; }
      var mine = ++seq;
      fetch('/api/v1/search?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : { data: { employees: [], departments: [] } }; })
        .then(function (res) {
          if (mine !== seq) return;
          var d = res.data || {};
          render([
            { title: i18n.employees, items: (d.employees || []).map(function (x) { return Object.assign({ icon: 'user' }, x); }) },
            { title: i18n.departments, items: (d.departments || []).map(function (x) { return Object.assign({ icon: 'building-2' }, x); }) },
            { title: i18n.jobs, items: (d.jobs || []).map(function (x) { return Object.assign({ icon: 'briefcase' }, x); }) },
            { title: i18n.candidates, items: (d.candidates || []).map(function (x) { return Object.assign({ icon: 'user' }, x); }) },
            { title: i18n.pages, items: matchedPages },
          ]);
        })
        .catch(function () { render([{ title: i18n.pages, items: matchedPages }]); });
    }
    function open() { cmdk.classList.add('open'); input.value = ''; search(); setTimeout(function () { input.focus(); }, 10); }
    function close() { cmdk.classList.remove('open'); }

    $$('[data-cmdk-open]').forEach(function (b) { b.addEventListener('click', open); });
    cmdk.addEventListener('click', function (e) { if (e.target === cmdk) close(); });
    input.addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(search, 180); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
      else if (e.key === 'Enter' && items[active]) { e.preventDefault(); window.location.href = items[active].href; }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (cmdk.classList.contains('open')) close(); else open(); }
      if (e.key === 'Escape') close();
    });
    var kbd = $('.search-trigger .kbd');
    if (kbd && /Mac|iPhone|iPad/.test(navigator.platform || '')) kbd.textContent = '⌘K';
  }

  /* ---------- Board drag & drop (tasks, recruitment pipeline). Falls back to plain forms without JS ----------
     Board: data-board, data-endpoint="/app/x/:id/status", data-field="status". Column: data-status. Card: data-id.
     A column with data-dialog opens that dialog instead of posting (e.g. "Hired" opens the hire form). */
  $$('[data-board]').forEach(function (board) {
    var endpoint = board.getAttribute('data-endpoint') || '/app/tasks/:id/status';
    var field = board.getAttribute('data-field') || 'status';
    var dragged = null;
    $$('[draggable="true"]', board).forEach(function (card) {
      card.addEventListener('dragstart', function (e) { dragged = card; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      card.addEventListener('dragend', function () { card.classList.remove('dragging'); dragged = null; });
    });
    $$('.board-col', board).forEach(function (col) {
      col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', function () { col.classList.remove('drop'); });
      col.addEventListener('drop', function (e) {
        e.preventDefault();
        col.classList.remove('drop');
        if (!dragged) return;
        var card = dragged;
        var from = card.closest('.board-col');
        if (from === col) return;
        var id = card.getAttribute('data-id') || card.getAttribute('data-task');
        var dialogTpl = col.getAttribute('data-dialog');
        if (dialogTpl) {
          var dlg = document.getElementById(dialogTpl.replace(':id', id));
          if (dlg && dlg.showModal) dlg.showModal(); else window.location.href = card.querySelector('a').href;
          return;
        }
        col.querySelector('.board-list').prepend(card);
        var body = new URLSearchParams({ _csrf: csrf });
        body.set(field, col.getAttribute('data-status'));
        fetch(endpoint.replace(':id', id), { method: 'POST', body: body, credentials: 'same-origin', headers: { 'x-csrf-token': csrf, 'x-requested-with': 'fetch' } })
          .then(function () { window.location.reload(); }) // the server flashes the outcome (including refusals)
          .catch(function () { from.querySelector('.board-list').prepend(card); });
      });
    });
  });

  /* ---------- Repeatable rows (onboarding template editor) ---------- */
  $$('[data-repeater]').forEach(function (box) {
    var rows = box.querySelector('[data-rows]');
    var tpl = box.querySelector('template[data-row-template]');
    box.addEventListener('click', function (e) {
      var add = e.target.closest('[data-add-row]');
      var rm = e.target.closest('[data-remove-row]');
      if (add && rows && tpl) { rows.appendChild(tpl.content.cloneNode(true)); var inputs = rows.querySelectorAll('input[name="item_title"]'); if (inputs.length) inputs[inputs.length - 1].focus(); }
      if (rm) { var row = rm.closest('[data-row]'); if (row && rows.querySelectorAll('[data-row]').length > 1) row.remove(); else if (row) row.querySelector('input').value = ''; }
    });
  });

  // Keep csrf available for fetch-based features.
  window.RemoteWay = { csrf: csrf };
})();
