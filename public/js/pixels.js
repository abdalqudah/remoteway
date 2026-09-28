// Advertising and analytics pixels for the public website. Settings come from <meta name="rw-pixels">
// (set in Super Admin → Marketing); nothing loads until the visitor accepts on the cookie notice.
// The vendors' standard snippets are rewritten here because the site's security policy blocks inline scripts.
(function () {
  'use strict';
  var tag = document.querySelector('meta[name="rw-pixels"]');
  if (!tag) return;
  var cfg;
  try { cfg = JSON.parse(tag.getAttribute('content')); } catch (e) { return; }
  if (!cfg || cfg.consent !== 'yes') return;
  var ids = cfg.ids || {};
  var ev = cfg.event || '';
  var w = window;

  function load(src) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    document.head.appendChild(s);
    return s;
  }

  // Google Analytics 4 and Google Tag Manager
  if (ids.ga4 || ids.gtm) {
    w.dataLayer = w.dataLayer || [];
    w.gtag = w.gtag || function () { w.dataLayer.push(arguments); };
  }
  if (ids.ga4) {
    load('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ids.ga4));
    w.gtag('js', new Date());
    w.gtag('config', ids.ga4);
  }
  if (ids.gtm) {
    w.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    load('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(ids.gtm));
  }

  // Meta (Facebook / Instagram)
  if (ids.meta && !w.fbq) {
    var fbq = w.fbq = function () { fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
    if (!w._fbq) w._fbq = fbq;
    fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
    load('https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', ids.meta);
    fbq('track', 'PageView');
  }

  // TikTok
  if (ids.tiktok && !w.ttq) {
    var ttq = w.ttq = [];
    ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie'];
    ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
    for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
    ttq._i = {}; ttq._i[ids.tiktok] = []; ttq._t = {}; ttq._t[ids.tiktok] = +new Date(); ttq._o = {}; ttq._o[ids.tiktok] = {};
    load('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=' + encodeURIComponent(ids.tiktok) + '&lib=ttq');
    ttq.page();
  }

  // Snapchat
  if (ids.snap && !w.snaptr) {
    var snaptr = w.snaptr = function () { snaptr.handleRequest ? snaptr.handleRequest.apply(snaptr, arguments) : snaptr.queue.push(arguments); };
    snaptr.queue = [];
    load('https://sc-static.net/scevent.min.js');
    snaptr('init', ids.snap, {});
    snaptr('track', 'PAGE_VIEW');
  }

  // LinkedIn Insight
  if (ids.linkedin) {
    w._linkedin_partner_id = ids.linkedin;
    w._linkedin_data_partner_ids = w._linkedin_data_partner_ids || [];
    w._linkedin_data_partner_ids.push(ids.linkedin);
    if (!w.lintrk) { w.lintrk = function (a, b) { w.lintrk.q.push([a, b]); }; w.lintrk.q = []; }
    load('https://snap.licdn.com/li.lms-analytics/insight.min.js');
  }

  // X (Twitter)
  if (ids.x && !w.twq) {
    var twq = w.twq = function () { twq.exe ? twq.exe.apply(twq, arguments) : twq.queue.push(arguments); };
    twq.version = '1.1'; twq.queue = [];
    load('https://static.ads-twitter.com/uwt.js');
    twq('config', ids.x);
  }

  // Conversions reported by the server after a sign-up or a demo request (once, on the next page).
  var EVENTS = {
    signup: { ga4: 'sign_up', meta: 'CompleteRegistration', tiktok: 'CompleteRegistration', snap: 'SIGN_UP' },
    join: { ga4: 'sign_up', meta: 'CompleteRegistration', tiktok: 'CompleteRegistration', snap: 'SIGN_UP' },
    lead: { ga4: 'generate_lead', meta: 'Lead', tiktok: 'SubmitForm', snap: 'SIGN_UP' },
  };
  var e = EVENTS[ev];
  if (e) {
    if (w.gtag && (ids.ga4 || ids.gtm)) w.gtag('event', e.ga4, { method: ev });
    if (ids.gtm) w.dataLayer.push({ event: 'rw_' + ev });
    if (w.fbq && ids.meta) w.fbq('track', e.meta);
    if (w.ttq && ids.tiktok) w.ttq.track(e.tiktok);
    if (w.snaptr && ids.snap) w.snaptr('track', e.snap);
  }
})();
