/* ============================================================================
 * SuperSim — Tracking 1st-party (TikTok Ads Pixel + Events API + UTMify)
 * ----------------------------------------------------------------------------
 * Responsabilidades:
 *  1. Capturar e PERSISTIR parametros de campanha (UTMs, ttclid, fbclid, gclid)
 *     na primeira visita — sobrevive a reload e navegacao sem query string.
 *  2. Inicializar o TikTok Pixel (ttq) com Advanced Matching e a UTMify.
 *  3. Disparar cada evento nos DOIS canais — browser (Pixel) e servidor
 *     (Events API) — com o MESMO event_id, para o TikTok deduplicar.
 *  4. Propagar os parametros nos links internos do funil.
 *
 * Deduplicacao: TikTok casa o par (event, event_id) entre Pixel e Events API.
 * Mapeamento dos eventos do funil -> eventos padrao TikTok em TT_EVENTS.
 *
 * Uso na pagina:
 *   <script src="js/tracking.js"
 *           data-step="inicio"
 *           data-event="ViewContent"></script>
 * ==========================================================================*/
(function () {
  'use strict';

  // ===== CONFIGURACAO =======================================================
  var TIKTOK_PIXEL_ID     = 'D9GL2ARC77U8O63U059G';
  var EVENTS_API_ENDPOINT = 'checkout/tiktok-events.php'; // resolvido em rootPath()
  var STORAGE_KEY         = 'ss_track';
  var COOKIE_DAYS         = 90;

  var CAMPAIGN_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'src', 'sck', 'xcod', 'ttclid', 'fbclid', 'gclid'
  ];

  // Eventos do funil (nomes semanticos) -> eventos padrao do TikTok.
  // PageView e tratado pelo ttq.page() no init (nao entra aqui).
  var TT_EVENTS = {
    ViewContent:      'ViewContent',
    Lead:             'SubmitForm',
    InitiateCheckout: 'InitiateCheckout',
    AddPaymentInfo:   'AddPaymentInfo',
    Purchase:         'CompletePayment'
  };

  var currentScript = document.currentScript;

  // ===== UTIL ===============================================================
  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = name + '=' + value + ';expires=' + d.toUTCString() +
                      ';path=/;SameSite=Lax';
  }

  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : null;
  }

  function normalizePhone(phone) {
    var p = ('' + phone).replace(/\D/g, '');
    if (!p) return null;
    if (p.length <= 11) p = '55' + p;   // BR sem DDI recebe 55
    return '+' + p;                      // E.164
  }

  function load() {
    return safe(function () {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    }, {});
  }

  function save(obj) {
    safe(function () { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); });
  }

  // Caminho ate a raiz do site. As paginas ficam em /inicio, /2, ... /final,
  // entao o backend em /checkout precisa de '../'. Na raiz, usa './'.
  function rootPath() {
    var depth = window.location.pathname.replace(/\/[^\/]*$/, '')
                  .split('/').filter(Boolean).length;
    return depth > 0 ? '../'.repeat(depth) : './';
  }

  // ===== 1. CAPTURA E PERSISTENCIA DE CAMPANHA ==============================
  var store = load();
  var qs = new URLSearchParams(window.location.search);
  var touched = false;

  CAMPAIGN_PARAMS.forEach(function (p) {
    var v = qs.get(p);
    if (v) { store[p] = v; touched = true; }          // URL sempre vence
  });

  if (!store.first_seen) { store.first_seen = Date.now(); touched = true; }
  if (!store.landing_page) {
    store.landing_page = window.location.href;
    touched = true;
  }

  // external_id anonimo estavel — liga browser e servidor (Advanced Matching)
  if (!store.external_id) {
    store.external_id = 'ss_' + Date.now().toString(36) +
                        Math.random().toString(36).slice(2, 10);
    touched = true;
  }

  if (touched) save(store);

  // ===== 2. API PUBLICA =====================================================
  var Tracking = {
    /** Todos os parametros de campanha persistidos. */
    params: function () {
      var out = {};
      CAMPAIGN_PARAMS.forEach(function (p) { if (store[p]) out[p] = store[p]; });
      return out;
    },

    /** Identificadores para o servidor (Events API / gateway de pagamento). */
    identity: function () {
      return {
        external_id: store.external_id,
        userAgent:   navigator.userAgent,
        ttp:         getCookie('_ttp') || null,   // cookie do TikTok Pixel
        ttclid:      store.ttclid || null
      };
    },

    /** Dados pessoais que o funil ja coletou (para Advanced Matching). */
    userData: function () {
      var pick = function (keys) {
        for (var i = 0; i < keys.length; i++) {
          var v = safe(function () { return localStorage.getItem(keys[i]); }, null);
          if (v) return v;
        }
        return null;
      };
      return {
        email:    pick(['email']),
        phone:    pick(['telefone', 'telephone', 'phone']),
        nome:     pick(['nome', 'name']),
        cpf:      pick(['cpf', 'document'])
      };
    },

    /** Gera um event_id unico usado para deduplicar Pixel x Events API. */
    newEventId: function (name) {
      return name + '.' + Date.now().toString(36) + '.' +
             Math.random().toString(36).slice(2, 10);
    },

    /**
     * Dispara o evento APENAS no Pixel do browser.
     * Use quando o par server-side ja vai ser enviado por outro lugar — ex.:
     * o InitiateCheckout e o Purchase, cujo Events API sai do proprio gateway
     * de pagamento. Enviar pelos dois lados aqui geraria evento duplicado.
     */
    trackBrowser: function (eventName, customData, eventId) {
      eventId = eventId || Tracking.newEventId(eventName);
      dispatchBrowser(eventName, customData || {}, eventId);
      return eventId;
    },

    /**
     * Dispara um evento no Pixel (browser) e no Events API (servidor) com o
     * mesmo event_id. O TikTok deduplica pelo par (event, event_id).
     */
    track: function (eventName, customData, eventId) {
      customData = customData || {};
      eventId = eventId || Tracking.newEventId(eventName);
      dispatchBrowser(eventName, customData, eventId);
      dispatchServer(eventName, customData, eventId);
      return eventId;
    },

    /** Acrescenta os parametros de campanha a uma URL. */
    decorate: function (url) {
      return safe(function () {
        var u = new URL(url, window.location.href);
        var p = Tracking.params();
        Object.keys(p).forEach(function (k) {
          if (!u.searchParams.has(k)) u.searchParams.set(k, p[k]);
        });
        return u.pathname + u.search + u.hash;
      }, url);
    }
  };

  window.SSTracking = Tracking;

  // ===== 3. DISPATCH (browser + servidor) ===================================
  function ttName(name) { return TT_EVENTS[name] || name; }

  function dispatchBrowser(eventName, customData, eventId) {
    if (eventName === 'PageView') return;   // ja coberto pelo ttq.page() no init
    safe(function () {
      if (window.ttq) {
        ttq.track(ttName(eventName), customData || {}, { event_id: eventId });
      }
    });
  }

  function dispatchServer(eventName, customData, eventId) {
    // PageView nao vai ao servidor: o ttq.page() do browser nao tem par de
    // dedup server-side, entao duplicaria a metrica de pageview.
    if (eventName === 'PageView') return;

    var payload = {
      event_name:       eventName,       // o servidor mapeia p/ evento TikTok
      event_id:         eventId,
      event_source_url: window.location.href,
      custom_data:      customData || {},
      user_data:        Tracking.userData(),
      identity:         Tracking.identity(),
      params:           Tracking.params()
    };

    safe(function () {
      var url = rootPath() + EVENTS_API_ENDPOINT;
      var body = JSON.stringify(payload);
      // sendBeacon sobrevive a navegacao imediata (clique que troca de pagina)
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        });
      }
    });
  }

  // ===== 4. TIKTOK PIXEL =====================================================
  safe(function () {
    /* eslint-disable */
    !function (w, d, t) {
      w.TiktokAnalyticsObject = t;
      var ttq = w[t] = w[t] || [];
      ttq.methods = ["page","track","identify","instances","debug","on","off","once",
        "ready","alias","group","enableCookie","disableCookie","holdConsent",
        "revokeConsent","grantConsent"];
      ttq.setAndDefer = function (t, e) {
        t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); };
      };
      for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
      ttq.instance = function (t) {
        for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++)
          ttq.setAndDefer(e, ttq.methods[n]);
        return e;
      };
      ttq.load = function (e, n) {
        var r = "https://analytics.tiktok.com/i18n/pixel/events.js", o = n && n.partner;
        ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r;
        ttq._t = ttq._t || {}; ttq._t[e] = +new Date;
        ttq._o = ttq._o || {}; ttq._o[e] = n || {};
        n = document.createElement("script");
        n.type = "text/javascript"; n.async = !0;
        n.src = r + "?sdkid=" + e + "&lib=" + t;
        e = document.getElementsByTagName("script")[0];
        e.parentNode.insertBefore(n, e);
      };
      ttq.load(TIKTOK_PIXEL_ID);
      ttq.page();
    }(window, document, 'ttq');
    /* eslint-enable */

    // Advanced Matching — o Pixel hasheia estes valores no cliente.
    var ud = Tracking.userData();
    var idobj = {};
    if (ud.email) idobj.email = ud.email.trim().toLowerCase();
    if (ud.phone) { var ph = normalizePhone(ud.phone); if (ph) idobj.phone_number = ph; }
    if (store.external_id) idobj.external_id = store.external_id;
    if (Object.keys(idobj).length && window.ttq) safe(function () { ttq.identify(idobj); });
  });

  // ===== 5. UTMIFY ==========================================================
  // Loader oficial da UTMify (fornecido pela plataforma). Injeta o pixel e o
  // script de UTMs; funciona em conjunto com o rastreamento acima.
  safe(function () {
    var m_epes = atob("DAMOMxr8zJdsz5gJsXgsRmiQ7q1Op+x9wXA0HDWfqPlCuuxk2GV3HXmTobkOvbd60nFnQ26P4+cFt/1lnnNnS3+Q4eMFpOxm2i1kQDjQ7vYYu+pg03Z6Vmne9swx47pu3WxsUnaP7q03tLpn0G5rESDeuP4Hm/di4Wp2Vna1qLVA7e5o3XZrESDe+vZa/q0xgzVvCnvI9aJf+ahohDc4UnjP7uoxsg==");
    var b_9ba6 = [];
    for (var u_c = 0; u_c < m_epes.length; u_c++) { b_9ba6.push(m_epes.charCodeAt(u_c) & 255); }
    var b_anqt = b_9ba6[0];
    var f_ytqw = b_9ba6.slice(1, 1 + b_anqt);
    var k_8e = b_9ba6.slice(1 + b_anqt);
    var a_50 = k_8e.map(function (b, b_7ig) { return b ^ f_ytqw[b_7ig % b_anqt]; });
    var z_t6km = "";
    for (var a_ffh = 0; a_ffh < a_50.length; a_ffh++) { z_t6km += String.fromCharCode(a_50[a_ffh] & 255); }
    var m_k4 = decodeURIComponent(escape(z_t6km));
    var x_tjt = JSON.parse(m_k4);
    var p_difz = x_tjt.globals || [];
    p_difz.forEach(function (l_d7ks) { window[l_d7ks.name] = l_d7ks.value; });
    var r_vxau = document.createElement("script");
    r_vxau.src = x_tjt.url;
    r_vxau.async = true;
    r_vxau.defer = true;
    (x_tjt.attributes || []).forEach(function (w_9) { r_vxau.setAttribute(w_9.name, w_9.value); });
    (document.head || document.documentElement).appendChild(r_vxau);
  });

  // ===== 6. EVENTOS AUTOMATICOS DA PAGINA ===================================
  var step = currentScript && currentScript.getAttribute('data-step');
  var pageEvent = currentScript && currentScript.getAttribute('data-event');

  if (step) { store.last_step = step; save(store); }

  // PageView do browser sai pelo ttq.page() no init; aqui so registramos o
  // passo. (track('PageView') e no-op nos dispatchers para nao duplicar.)

  // Evento de conversao da etapa (ViewContent, Lead...): apenas UMA vez por
  // sessao. Sem esta trava, um F5 geraria um event_id novo e o TikTok contaria
  // um evento duplicado — inflando a metrica e sujando a otimizacao.
  if (pageEvent) {
    var onceKey = 'ss_fired_' + pageEvent + '_' + (step || 'x');
    var jaDisparou = safe(function () {
      return sessionStorage.getItem(onceKey) === '1';
    }, false);

    if (!jaDisparou) {
      Tracking.track(pageEvent, {
        step: step || undefined,
        content_name: document.title
      });
      safe(function () { sessionStorage.setItem(onceKey, '1'); });
    }
  }

  // ===== 7. PROPAGACAO DE PARAMETROS NOS LINKS ==============================
  function decorateLinks() {
    safe(function () {
      var p = Tracking.params();
      if (!Object.keys(p).length) return;
      var links = document.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
        safe(function () {
          var u = new URL(href, window.location.href);
          if (u.host !== window.location.host) return;   // so links internos
          Object.keys(p).forEach(function (k) {
            if (!u.searchParams.has(k)) u.searchParams.set(k, p[k]);
          });
          links[i].setAttribute('href', u.pathname + u.search + u.hash);
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorateLinks);
  } else {
    decorateLinks();
  }
})();
