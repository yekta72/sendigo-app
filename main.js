const { app, BrowserWindow, session, ipcMain, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// ── userData yolunu sabit tut — dev ve exe aynı veriyi okur ──
// Bu satır app.whenReady'den ÖNCE çağrılmalı
app.setPath('userData', path.join(app.getPath('appData'), 'Sendigo'));

const WA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// Electron'un kendi UA'sını global olarak ezeriz
app.userAgentFallback = WA_UA;

const ICON_PATH = path.join(__dirname, 'icon.ico');

let mainWin = null;
let tray    = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
    title: 'Sendigo',
    icon: ICON_PATH,
    backgroundColor: '#0d1418',
    show: false,
  });

  mainWin.loadFile('index.html');
  mainWin.once('ready-to-show', () => { mainWin.maximize(); mainWin.show(); });

  // ── Pencere kapatılınca tray'e küçült — uygulamayı sonlandırma ──
  mainWin.on('close', e => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
}

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch(e) {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Sendigo — Multi-Account WhatsApp');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Sendigo\'yi Aç',
      click: () => { mainWin.show(); mainWin.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Çıkış',
      click: () => { app.isQuiting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(contextMenu);

  // Tray ikonuna tıklayınca pencereyi aç/öne getir
  tray.on('click', () => {
    if (mainWin.isVisible()) {
      mainWin.focus();
    } else {
      mainWin.show();
      mainWin.focus();
    }
  });
}

// ── Auto Updater ──
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', () => {
  if (mainWin) mainWin.webContents.send('update-available');
});
autoUpdater.on('update-downloaded', () => {
  if (mainWin) mainWin.webContents.send('update-downloaded');
});

app.whenReady().then(() => {
  // Uygulama ikonu (görev çubuğu dahil)
  if (process.platform === 'win32') app.setAppUserModelId('com.sendigo.app');
  // Menü çubuğunu tamamen kaldır (File, Edit, View vs.)
  Menu.setApplicationMenu(null);
  app.on('web-contents-created', (_, contents) => {
    if (contents.getType() !== 'webview') return;

    // 0. Webview'in kendi Node entegrasyonunu kapat — Electron API sızıntısı önle
    try {
      contents.executeJavaScript('void 0').catch(() => {});
    } catch(e) {}

    // 1. UA — webview'ın useragent attribute'u per-account UA'yı yönetir.
    // setUserAgent() KASITLI olarak çağrılmıyor: tüm hesapları tek bir UA'ya
    // zorlamak yerine her hesabın atanmış UA'sını (Chrome veya Firefox) korumalıyız.

    // 2. Her istekte Electron parmak izini temizle + tarayıcıya uygun başlıklar
    contents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const h = { ...details.requestHeaders };
      // UA'yı webview'ın kendi değerinden oku (useragent attribute ile atandı)
      // Eksikse Chrome fallback uygula
      const ua = h['User-Agent'] || WA_UA;
      if (!h['User-Agent']) h['User-Agent'] = WA_UA;
      const _isFF = /Firefox\//.test(ua);
      if (!_isFF) {
        // Chrome: Sec-Ch-Ua başlıklarını UA'daki major sürümle eşleştir
        const major = (ua.match(/Chrome\/(\d+)/) || [, '148'])[1];
        h['Sec-Ch-Ua']          = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not/A)Brand";v="24"`;
        h['Sec-Ch-Ua-Mobile']   = '?0';
        h['Sec-Ch-Ua-Platform'] = '"Windows"';
      } else {
        // Firefox: Client Hints API desteklemez — Sec-Ch-* başlıklarını kaldır
        delete h['Sec-Ch-Ua'];
        delete h['Sec-Ch-Ua-Mobile'];
        delete h['Sec-Ch-Ua-Platform'];
      }
      // Dil
      h['Accept-Language'] = 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7';
      // Electron-özgü başlıkları sil
      delete h['X-Electron-Version'];
      delete h['Electron-Version'];
      delete h['X-Requested-With'];
      // NOT: Accept başlığını SILME — her istek türü için farklı olmalı
      callback({ requestHeaders: h });
    });

    // 3. Medya / bildirim izinleri
    contents.session.setPermissionRequestHandler((wc, permission, cb) => {
      cb(['notifications', 'media', 'microphone', 'camera', 'geolocation'].includes(permission));
    });

    // 4. Popup / yeni pencere isteklerini yakala — WhatsApp içi dialoglar için
    contents.setWindowOpenHandler(({ url, disposition }) => {
      // about:blank veya blob: URL'leri → renderer içinde yeni BrowserWindow aç
      const popup = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          session: contents.session,
        },
        backgroundColor: '#0d1418',
        autoHideMenuBar: true,
        show: false,
      });
      popup.once('ready-to-show', () => popup.show());
      if (url && url !== 'about:blank') {
        popup.loadURL(url);
      }
      return { action: 'deny' }; // Electron'un varsayılan açılışını iptal et, biz açtık
    });

    // 5. Her sayfa yüklenince otomasyon işaretlerini gizle + banner kapat
    contents.on('did-finish-load', () => {
      contents.executeJavaScript(`
        try {
          // ── Tarayıcı türü tespiti (Layer 1) ────────────────────────
          const _ua1   = navigator.userAgent;
          const _isFF1 = /Firefox\\//.test(_ua1);
          const _isChr1= !_isFF1 && /Chrome\\//.test(_ua1);

          // ── Temel otomasyon bayrakları (her tarayıcı) ───────────────
          Object.defineProperty(navigator, 'webdriver',           { get: () => undefined });
          Object.defineProperty(navigator, 'plugins',             { get: () => [1,2,3,4,5] });
          Object.defineProperty(navigator, 'languages',           { get: () => ['tr-TR','tr','en-US','en'] });
          Object.defineProperty(navigator, 'platform',            { get: () => 'Win32' });
          Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
          Object.defineProperty(navigator, 'maxTouchPoints',      { get: () => 0 });
          // deviceMemory: Chrome'a özgü API — Firefox'ta tanımlanmaz
          if (_isChr1) Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

          // ── Gerçekçi window.chrome nesnesi — yalnızca Chrome ───────
          if (_isChr1) {
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
                connect: function(){}, sendMessage: function(){},
                OnInstalledReason: {}, PlatformArch: {}, PlatformOs: {},
              },
              loadTimes: function() {
                return { commitLoadTime: Date.now()/1000-2, connectionInfo:'h2',
                  finishDocumentLoadTime:0, finishLoadTime:0, firstPaintAfterLoadTime:0,
                  firstPaintTime:0, navigationType:'Other', npnNegotiatedProtocol:'h2',
                  requestTime: Date.now()/1000-3, startLoadTime: Date.now()/1000-3,
                  wasAlternateProtocolAvailable:false, wasFetchedViaSpdy:true, wasNpnNegotiated:true };
              },
              csi: function() {
                return { onloadT: Date.now(), pageT: Date.now(), startE: Date.now(), tran: 15 };
              },
            };
          }

          // ── Electron izlerini sil (defineProperty ile — delete bazen çalışmaz) ──
          ['process','require','__electronRequire','electron','_electron',
           'ElectronUpdater','ipcRenderer','shell','nativeImage',
           '__webpack_require__'].forEach(k => {
            try {
              if (k in window) {
                Object.defineProperty(window, k, { get: ()=>undefined, set:()=>{}, configurable:true });
              }
            } catch(e) {}
          });

          // ── Canvas parmak izi gürültüsü ─────────────────────────────
          const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(type) {
            if (type === 'image/png' && this.width > 16) {
              try {
                const ctx = this.getContext('2d');
                if (ctx) {
                  const px = ctx.getImageData(0, 0, 1, 1);
                  px.data[0] = (px.data[0] ^ 1); ctx.putImageData(px, 0, 0);
                }
              } catch(e) {}
            }
            return _origToDataURL.apply(this, arguments);
          };

          // ── WebGL renderer string maskeleme ────────────────────────
          try {
            const _origGetParam = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(param) {
              if (param === 37445) return _isFF1 ? 'Mozilla' : 'Intel Inc.';
              if (param === 37446) return _isFF1 ? 'Mozilla' : 'Intel Iris OpenGL Engine';
              return _origGetParam.apply(this, arguments);
            };
          } catch(e) {}

          // ── Permissions API yanıltma ────────────────────────────────
          if (navigator.permissions && navigator.permissions.query) {
            const _origQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (p) => {
              if (p.name === 'notifications') return Promise.resolve({ state:'prompt', onchange:null });
              return _origQuery(p);
            };
          }
        } catch(e) {}

        // ── İndirme banner'ını gizle ────────────────────────────────
        if (!document.getElementById('_wabm_style')) {
          const s = document.createElement('style');
          s.id = '_wabm_style';
          s.textContent = \`
            [data-testid="app-download-banner"],
            a[href*="dl.whatsapp.com"] { display:none!important; }
          \`;
          /* NOT: [data-animate-modal-popup] KASITLI olarak kaldırıldı —
             o seçici WhatsApp'ın iç onay dialoglarını (sohbet sil, profil fotoğrafı vb.) de gizliyordu */
          document.head && document.head.appendChild(s);
        }
      `).catch(() => {});

      // ════════════════════════════════════════════════════════════
      //  2. KATMAN — Derin fingerprint + sahte presence altyapısı
      // ════════════════════════════════════════════════════════════
      contents.executeJavaScript(`
        try {
          // ── Tarayıcı türü tespiti (Layer 2) ──────────────────────────
          const _ua2   = navigator.userAgent;
          const _isFF2 = /Firefox\\//.test(_ua2);
          const _isChr2= !_isFF2 && /Chrome\\//.test(_ua2);
          const _cvM2  = _isChr2 ? (_ua2.match(/Chrome\\/(\\d+)/) || [,'148'])[1] : null;

          // ── navigator tarayıcı-spesifik alanlar ──────────────────────
          Object.defineProperty(navigator, 'vendor',     { get: () => _isFF2 ? '' : 'Google Inc.' });
          Object.defineProperty(navigator, 'productSub', { get: () => _isFF2 ? '20100101' : '20030107' });
          Object.defineProperty(navigator, 'appName',    { get: () => 'Netscape' });
          Object.defineProperty(navigator, 'appVersion', {
            get: () => _isFF2
              ? '5.0 (Windows)'
              : \`5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/\${_cvM2}.0.0.0 Safari/537.36\`
          });
          // Firefox'a özgü: oscpu
          if (_isFF2) try { Object.defineProperty(navigator, 'oscpu', { get: () => 'Windows NT 10.0; Win64; x64' }); } catch(e) {}

          // ── Connection API (4G Wi-Fi gibi görün) — yalnızca Chrome ──
          if (_isChr2) {
            try {
              if (!navigator.connection) {
                Object.defineProperty(navigator, 'connection', { get: () => ({
                  effectiveType: '4g', rtt: 45, downlink: 12.5, saveData: false, type: 'wifi',
                  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
                }) });
              }
            } catch(e) {}
          }

          // ── Battery API — yalnızca Chrome (Firefox kısmi destek) ────
          if (_isChr2) {
            try {
              navigator.getBattery = () => Promise.resolve({
                charging: true, chargingTime: 0, dischargingTime: Infinity,
                level: 0.93 + Math.random() * 0.06,
                addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
              });
            } catch(e) {}
          }

          // ── Screen renk derinliği ─────────────────────────────────
          try {
            Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
            Object.defineProperty(screen, 'pixelDepth',  { get: () => 24 });
          } catch(e) {}

          // ── document.hasFocus — hesap her zaman "aktif" görünsün ─
          try { document.hasFocus = () => true; } catch(e) {}

          // ── WebRTC IP sızıntı önlemi: STUN listesini boşalt ──────
          // (sesli/görüntülü aramayı korur ama gerçek IP sızmasını önler)
          try {
            const _OrigRTC = window.RTCPeerConnection;
            if (_OrigRTC) {
              window.RTCPeerConnection = function(cfg, con) {
                if (cfg && Array.isArray(cfg.iceServers)) cfg.iceServers = [];
                return new _OrigRTC(cfg, con);
              };
              window.RTCPeerConnection.prototype = _OrigRTC.prototype;
              if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = window.RTCPeerConnection;
            }
          } catch(e) {}

          // ── Performance.now mikro-gürültüsü (timing fingerprint) ─
          try {
            const _origNow = performance.now.bind(performance);
            performance.now = function() { return _origNow() + Math.random() * 0.12; };
          } catch(e) {}

          // ── AudioContext sampleRate gürültüsü ─────────────────────
          try {
            const _OrigAC = window.AudioContext || window.webkitAudioContext;
            if (_OrigAC && !window.__acPatched) {
              window.__acPatched = true;
              const PatchedAC = function(opts) {
                if (opts && opts.sampleRate) opts.sampleRate = 44100;
                return new _OrigAC(opts);
              };
              PatchedAC.prototype = _OrigAC.prototype;
              window.AudioContext = PatchedAC;
              if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
            }
          } catch(e) {}

          // ── MediaDevices — gerçekçi cihaz listesi ────────────────
          try {
            if (navigator.mediaDevices) {
              navigator.mediaDevices.enumerateDevices = async () => [
                { deviceId:'default', kind:'audioinput',  label:'Varsayılan - Mikrofon (Realtek)',  groupId:'grp1' },
                { deviceId:'default', kind:'audiooutput', label:'Varsayılan - Hoparlörler (Realtek)', groupId:'grp1' },
                { deviceId:'default', kind:'videoinput',  label:'HP TrueVision HD Camera',           groupId:'grp2' },
              ];
            }
          } catch(e) {}

          // ── Otomasyon DOM kalıntılarını temizle ───────────────────
          try {
            [
              '__driver_evaluate','__webdriver_script_fn','__driver_unwrapped',
              '__webdriver_evaluate','__selenium_evaluate','__fxdriver_evaluate',
              '__webdriver_unwrapped','__selenium_unwrapped','__fxdriver_unwrapped',
              '__webdriverFunc','_Selenium_IDE_Recorder','__lastWatirAlert',
              '__lastWatirConfirm','__lastWatirPrompt','calledSelenium',
            ].forEach(k => { try { if (k in window) delete window[k]; } catch(e) {} });
          } catch(e) {}

          // ── Object.prototype.__defineGetter__ maskeleme ───────────
          // Bazı fingerprint scriptleri getter tanımını test eder
          try {
            const _origFunctionToString = Function.prototype.toString;
            Function.prototype.toString = function() {
              if (this === Function.prototype.toString) return 'function toString() { [native code] }';
              const result = _origFunctionToString.call(this);
              // Özelleştirilmiş getter'larımızı native gibi göster
              if (result.includes('=> ') && result.length < 80) {
                return 'function () { [native code] }';
              }
              return result;
            };
          } catch(e) {}

        } catch(globalErr) {}

        // ── Sahte presence altyapısı: tab odak simülasyonu ───────────
        // configurable:true zorunlu — renderer.js simulateFocusLoss/Return
        // bu property'leri geçici olarak redefine eder; non-configurable
        // olursa try-catch içinde sessizce başarısız olur ve döngü çalışmaz.
        try {
          Object.defineProperty(document, 'hidden',           { get: () => false,     configurable: true });
          Object.defineProperty(document, 'visibilityState',  { get: () => 'visible', configurable: true });
          document.hasFocus = () => true;
          // NOT: visibilitychange event blocker KASITLI olarak kaldırıldı —
          // renderer.js visibility cycle sistemi olayları kendisi yönetiyor.
        } catch(e) {}
      `).catch(() => {});
    });
  });

  createWindow();
  createTray();

  // Güncelleme kontrolü (sadece paketlenmiş .exe'de çalışır)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates(), 3000);
  }

  app.on('activate', () => {
    // macOS: dock'tan tıklanınca pencereyi göster
    if (mainWin) { mainWin.show(); mainWin.focus(); }
    else createWindow();
  });
});

// ── Uygulama versiyonu ──
ipcMain.handle('get-app-version', () => app.getVersion());

// ── Dış bağlantıyı varsayılan tarayıcıda aç ──
ipcMain.on('open-external', (_event, url) => { shell.openExternal(url); });

// ── Güncellemeyi şimdi yükle ve yeniden başlat ──
ipcMain.handle('install-update', () => autoUpdater.quitAndInstall());

// ── Popup penceresi aç — renderer'dan gelen new-window isteklerini işle ──
ipcMain.handle('open-popup', async (_event, { url }) => {
  try {
    const popup = new BrowserWindow({
      width: 900,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
      backgroundColor: '#0d1418',
      autoHideMenuBar: true,
      show: false,
    });
    popup.once('ready-to-show', () => popup.show());
    popup.loadURL(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Proxy IPC handler — renderer session.setProxy'yi doğrudan çağıramaz ──
ipcMain.handle('set-proxy', async (_event, { partition, proxyRules }) => {
  try {
    await session.fromPartition(partition).setProxy({ proxyRules });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-proxy', async (_event, { partition }) => {
  try {
    const sess = session.fromPartition(partition);
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
});

// ── OpenAI API proxy ────────────────────────────────────────────────────
ipcMain.handle('openai-generate', async (_event, { apiKey, prompt, maxTokens }) => {
  const https = require('https');
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model:      'gpt-4o-mini',
      max_tokens: maxTokens || 4096,
      messages:   [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.openai.com',
      path:     '/v1/chat/completions',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // OpenAI format → Anthropic-benzeri sarmalayıcı
          if (res.statusCode === 200) {
            const text = parsed?.choices?.[0]?.message?.content || '';
            resolve({ ok: true, status: 200, body: { content: [{ text }] } });
          } else {
            resolve({ ok: false, status: res.statusCode, body: { error: { message: parsed?.error?.message || data } } });
          }
        } catch {
          resolve({ ok: false, status: res.statusCode, body: { error: { message: data } } });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: { error: { message: e.message } } }));
    req.write(body);
    req.end();
  });
});

// ── Anthropic API proxy — CORS bypass için main process üzerinden istek ──
ipcMain.handle('anthropic-generate', async (_event, { apiKey, prompt, maxTokens }) => {
  const https = require('https');
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 4096,
      messages:   [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ ok: false, status: res.statusCode, body: { error: { message: data } } });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: { error: { message: e.message } } }));
    req.write(body);
    req.end();
  });
});

// ── CSV / Excel numara import ────────────────────────────────────────────
ipcMain.handle('import-numbers', async () => {
  const fs   = require('fs');

  const result = await dialog.showOpenDialog({
    title: 'Numara Listesi İçe Aktar',
    filters: [
      { name: 'Desteklenen Dosyalar', extensions: ['csv', 'txt', 'xlsx', 'xls'] },
      { name: 'CSV / Metin',          extensions: ['csv', 'txt'] },
      { name: 'Excel',                extensions: ['xlsx', 'xls'] },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'canceled' };

  const filePath = result.filePaths[0];
  const ext      = path.extname(filePath).toLowerCase();

  try {
    let rows = [];

    if (ext === '.xlsx' || ext === '.xls') {
      // Excel — xlsx paketi gerekli
      let XLSX;
      try { XLSX = require('xlsx'); } catch {
        return { ok: false, reason: 'xlsx_missing' };
      }
      const wb = XLSX.readFile(filePath);
      wb.SheetNames.forEach(name => {
        const ws = wb.Sheets[name];
        const data = XLSX.utils.sheet_to_csv(ws);
        rows = rows.concat(data.split('\n'));
      });
    } else {
      // CSV / TXT
      const content = fs.readFileSync(filePath, 'utf-8');
      rows = content.split(/\r?\n/);
    }

    // Her satırdan telefon numarası benzeri token'ları topla
    const numbers = [];
    rows.forEach(row => {
      // Sütunları virgül, noktalı virgül veya tab ile böl
      const cells = row.split(/[,;\t]/);
      cells.forEach(cell => {
        const cleaned = cell.replace(/["'\s]/g, '').trim();
        // Telefon gibi görünen: opsiyonel '+', ardından 7-15 rakam
        if (/^\+?\d{7,15}$/.test(cleaned)) {
          numbers.push(cleaned);
        }
      });
    });

    return { ok: true, numbers, total: rows.length };
  } catch (err) {
    return { ok: false, reason: 'read_error', message: err.message };
  }
});

app.on('window-all-closed', () => {
  // Pencere kapatılınca app.quit() ÇAĞIRMA — tray'de çalışmaya devam et.
  // Gerçek çıkış sadece tray menüsündeki "Çıkış" butonuyla yapılır.
  // macOS'ta bu event zaten tetiklenmez (dock davranışı farklı).
});

// ── Ana process beklenmedik hata yakalayıcı ──────────────────────────────
process.on('uncaughtException',  (err) => { console.error('[main] uncaughtException:', err); });
process.on('unhandledRejection', (err) => { console.warn('[main] unhandledRejection:', err);  });
