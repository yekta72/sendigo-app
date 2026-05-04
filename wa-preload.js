// ══════════════════════════════════════════════════════════════════════════
//  wa-preload.js — WhatsApp Web yüklenmeden ÖNCE çalışır
//  Bu script webview'ın preload attribute'u ile inject edilir.
//  Sayfa JS'inden önce çalıştığı için WhatsApp'ın tüm tespit kontrolleri
//  bu overridelar devredeyken başlar.
// ══════════════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // ── 1. Electron / Node izlerini HEMEN temizle ──────────────────────────
  const globalProps = [
    'process', 'require', '__electronRequire',
    '__dirname', '__filename', 'module', 'exports',
    '__webpack_require__',
  ];
  globalProps.forEach(k => {
    try {
      if (k in window) {
        Object.defineProperty(window, k, {
          get: () => undefined,
          set: () => {},
          configurable: true,
        });
      }
    } catch(e) {}
  });

  // ── 2. navigator.webdriver ─────────────────────────────────────────────
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch(e) {}

  // ── 3. navigator temel alanları ────────────────────────────────────────
  const navProps = {
    plugins:            { get: () => Object.assign([1,2,3,4,5], { item: ()=>null, namedItem: ()=>null, refresh: ()=>{} }) },
    languages:          { get: () => ['tr-TR','tr','en-US','en'] },
    platform:           { get: () => 'Win32' },
    hardwareConcurrency:{ get: () => 8 },
    deviceMemory:       { get: () => 8 },
    maxTouchPoints:     { get: () => 0 },
    vendor:             { get: () => 'Google Inc.' },
    productSub:         { get: () => '20030107' },
    appName:            { get: () => 'Netscape' },
    appVersion:         { get: () => '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    doNotTrack:         { get: () => null },
  };
  Object.keys(navProps).forEach(k => {
    try { Object.defineProperty(navigator, k, navProps[k]); } catch(e) {}
  });

  // ── 4. navigator.userAgentData — Chrome UA Client Hints API ───────────
  // Electron bunu tanımlamaz; WhatsApp bunu kontrol edebilir
  try {
    if (!navigator.userAgentData) {
      const uaData = {
        brands: [
          { brand: 'Chromium',      version: '124' },
          { brand: 'Google Chrome', version: '124' },
          { brand: 'Not-A.Brand',   version: '99'  },
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async function(hints) {
          return {
            architecture:    'x86',
            bitness:         '64',
            brands:          uaData.brands,
            fullVersionList: [
              { brand: 'Chromium',      version: '124.0.6367.78' },
              { brand: 'Google Chrome', version: '124.0.6367.78' },
              { brand: 'Not-A.Brand',   version: '99.0.0.0'      },
            ],
            mobile:          false,
            model:           '',
            platform:        'Windows',
            platformVersion: '10.0.0',
            uaFullVersion:   '124.0.6367.78',
          };
        },
        toJSON: function() {
          return { brands: uaData.brands, mobile: uaData.mobile, platform: uaData.platform };
        },
      };
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => uaData,
        configurable: true,
      });
    }
  } catch(e) {}

  // ── 5. window.chrome gerçekçi nesnesi ──────────────────────────────────
  if (!window.chrome) {
    window.chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED:'disabled', INSTALLED:'installed', NOT_INSTALLED:'not_installed' },
        RunningState: { CANNOT_RUN:'cannot_run', READY_TO_RUN:'ready_to_run', RUNNING:'running' },
        getDetails: function(){}, getIsInstalled: function(){},
        installState: function(){}, runningState: function(){},
      },
      runtime: {
        id: undefined,
        connect: function(){},
        sendMessage: function(){},
        OnInstalledReason: {}, PlatformArch: {}, PlatformOs: {},
      },
      loadTimes: function() {
        return {
          commitLoadTime: Date.now()/1000-2, connectionInfo:'h2',
          finishDocumentLoadTime:0, finishLoadTime:0, firstPaintAfterLoadTime:0,
          firstPaintTime:0, navigationType:'Other', npnNegotiatedProtocol:'h2',
          requestTime: Date.now()/1000-3, startLoadTime: Date.now()/1000-3,
          wasAlternateProtocolAvailable:false, wasFetchedViaSpdy:true, wasNpnNegotiated:true,
        };
      },
      csi: function() {
        return { onloadT: Date.now(), pageT: Date.now(), startE: Date.now(), tran: 15 };
      },
    };
  }

  // ── 6. Permissions API ─────────────────────────────────────────────────
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const _orig = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (p) => {
        if (p.name === 'notifications') return Promise.resolve({ state:'prompt', onchange:null });
        return _orig(p);
      };
    }
  } catch(e) {}

  // ── 7. Canvas parmak izi gürültüsü ─────────────────────────────────────
  try {
    const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      if (type === 'image/png' && this.width > 16) {
        try {
          const ctx = this.getContext('2d');
          if (ctx) {
            const px = ctx.getImageData(0, 0, 1, 1);
            px.data[0] = (px.data[0] ^ 1);
            ctx.putImageData(px, 0, 0);
          }
        } catch(e) {}
      }
      return _origToDataURL.apply(this, arguments);
    };
  } catch(e) {}

  // ── 8. WebGL renderer maskeleme ────────────────────────────────────────
  try {
    const _origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return _origGetParam.apply(this, arguments);
    };
  } catch(e) {}

  // ── 9. RTCPeerConnection — WebRTC IP sızıntısı önle ───────────────────
  try {
    const _OrigRTC = window.RTCPeerConnection;
    if (_OrigRTC) {
      window.RTCPeerConnection = function(cfg, con) {
        if (cfg && Array.isArray(cfg.iceServers)) cfg.iceServers = [];
        return new _OrigRTC(cfg, con);
      };
      window.RTCPeerConnection.prototype = _OrigRTC.prototype;
    }
  } catch(e) {}

  // ── 10. Performance.now mikro-gürültüsü ───────────────────────────────
  try {
    const _origNow = performance.now.bind(performance);
    performance.now = function() { return _origNow() + Math.random() * 0.12; };
  } catch(e) {}

  // ── 11. Function.prototype.toString — native gibi göster ──────────────
  try {
    const _origFnToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === Function.prototype.toString) return 'function toString() { [native code] }';
      const result = _origFnToString.call(this);
      if (result.includes('=> ') && result.length < 80) {
        return 'function () { [native code] }';
      }
      return result;
    };
  } catch(e) {}

  // ── 12. Selenium / otomasyon kalıntılarını temizle ─────────────────────
  try {
    [
      '__driver_evaluate','__webdriver_script_fn','__driver_unwrapped',
      '__webdriver_evaluate','__selenium_evaluate','__fxdriver_evaluate',
      '__webdriver_unwrapped','__selenium_unwrapped','__fxdriver_unwrapped',
      '__webdriverFunc','_Selenium_IDE_Recorder','calledSelenium',
    ].forEach(k => {
      try {
        Object.defineProperty(window, k, { get: () => undefined, configurable: true });
      } catch(e) {}
    });
  } catch(e) {}

  // ── 13. Connection API ─────────────────────────────────────────────────
  try {
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g', rtt: 45, downlink: 12.5,
          saveData: false, type: 'wifi',
          addEventListener: () => {}, removeEventListener: () => {},
        }),
        configurable: true,
      });
    }
  } catch(e) {}

  // ── 14. document.hidden / visibilityState — her zaman aktif görün ──────
  try {
    Object.defineProperty(document, 'hidden',          { get: () => false,     configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.hasFocus = () => true;
  } catch(e) {}

})();
