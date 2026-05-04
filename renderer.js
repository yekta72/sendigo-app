const { ipcRenderer } = require('electron');

// ══════════════════════════════════════════════════════════════════════════
//  LİSANS DOĞRULAMA
// ══════════════════════════════════════════════════════════════════════════
const FIREBASE_PROJECT = 'sendigo-dc1b3';
const FIREBASE_API_KEY = 'AIzaSyCObDyko3vNGAnpMXijbQy5s4yDxxuRdqw';
const LS_LICENSE_KEY   = 'sendigo_license';

async function validateLicenseKey(key) {
  try {
    // Owner anahtarı — her zaman geçerli
    if (key === 'SNDG-OWNS-UNLM-YEKT') {
      return { valid: true, plan: 'owner', info: 'Owner lisansı aktif.' };
    }

    const https = require('https');
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/licenses/${encodeURIComponent(key)}?key=${FIREBASE_API_KEY}`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        });
      }).on('error', reject);
    });
    if (!data) return { valid: false, reason: 'Lisans anahtarı bulunamadı.' };
    const f = data.fields || {};

    const plan      = f.plan?.stringValue      || 'trial';
    const expiresAt = f.expiresAt?.stringValue || null;

    if (plan === 'trial' && expiresAt) {
      if (new Date() > new Date(expiresAt)) {
        return { valid: false, reason: 'Deneme süreniz dolmuştur. sendigo.pro adresinden bir plan satın alın.' };
      }
      const kalan = Math.ceil((new Date(expiresAt) - new Date()) / 3600000);
      return { valid: true, plan, info: `Deneme lisansı aktif — ${kalan} saat kaldı.` };
    }

    return { valid: true, plan, info: `${plan.charAt(0).toUpperCase()+plan.slice(1)} planı aktif.` };
  } catch (e) {
    return { valid: false, reason: 'Bağlantı hatası. İnternet bağlantınızı kontrol edin.' };
  }
}

function showLicenseGate() {
  const gate = document.getElementById('license-gate');
  if (gate) gate.style.display = 'flex';
}

function hideLicenseGate() {
  const gate = document.getElementById('license-gate');
  if (gate) gate.style.display = 'none';
}

window.submitLicense = async function() {
  const input = document.getElementById('license-input');
  const btn   = document.getElementById('license-btn');
  const err   = document.getElementById('license-err');
  const info  = document.getElementById('license-info');
  const key   = (input?.value || '').trim().toUpperCase();

  if (!key || key.length < 10) {
    err.textContent = 'Lütfen geçerli bir lisans anahtarı girin.';
    err.style.display = 'block'; info.style.display = 'none'; return;
  }

  btn.textContent = 'Doğrulanıyor…'; btn.disabled = true;
  err.style.display = 'none'; info.style.display = 'none';

  const result = await validateLicenseKey(key);

  if (result.valid) {
    localStorage.setItem(LS_LICENSE_KEY, key);
    info.textContent = result.info;
    info.style.display = 'block';
    btn.textContent = '✓ Giriş yapılıyor…';
    setTimeout(() => hideLicenseGate(), 1000);
  } else {
    err.textContent = result.reason;
    err.style.display = 'block';
    btn.textContent = 'Doğrula & Giriş Yap';
    btn.disabled = false;
  }
};

async function checkLicenseOnStartup() {
  const saved = localStorage.getItem(LS_LICENSE_KEY);
  if (!saved) { showLicenseGate(); return; }

  const result = await validateLicenseKey(saved);
  if (!result.valid) {
    localStorage.removeItem(LS_LICENSE_KEY);
    showLicenseGate();
    // Hata mesajını göster
    const err = document.getElementById('license-err');
    const inp = document.getElementById('license-input');
    if (err) { err.textContent = result.reason; err.style.display = 'block'; }
    if (inp)   inp.value = saved;
  }
  // valid ise gate zaten gizli, devam et
}

// Enter tuşu ile doğrulama
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('license-input');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') window.submitLicense(); });
  checkLicenseOnStartup();
});

// ══════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════
let accounts         = [];   // [{ id, name, phone, proxies:[], proxyIdx:0, proxyRotate:true, createdAt }]
let activeAccountId  = null;
let panelAccountId   = null;
let contextMenuAccId = null;
let editingAccountId = null;
let editingTmplId    = null;
let dragSrcId        = null;
let soundEnabled     = true;
let darkTheme        = true;
let typingSpeed      = 3;   // 1=Çok Yavaş  2=Yavaş  3=Normal  4=Hızlı  5=Çok Hızlı

// Güvenlik ayarları
let securitySettings = { settleCooldown: true, addCooldown: true };

// Sidebar canlı aktivite logu
let slogOpen = false;
const SLOG_MAX = 20;  // en fazla bu kadar satır tutulur
const prevCounts     = {};
const sessionStarted  = {};  // { accountId: timestamp } — webview ilk yüklendiğinde
const presenceTimers  = {};  // { accountId: timeoutHandle } — sahte presence zamanlayıcıları

// Gerçek zamanlı hesap durum metinleri — sidebar'da gösterilir
const accountStatusText = {};   // { accountId: string }
const accountCountdowns = {};   // { accountId: intervalHandle }

// Günlük sayaç rozetini DOM'da yerinde güncelle (renderAccounts gerektirmez)
function updateSentBadge(id) {
  const nameEl = document.querySelector(`.account-item[data-id="${id}"] .account-name`);
  if (!nameEl) return;
  const account = accounts.find(a => a.id === id);
  if (!account) return;
  const sent  = getDailySent(id);
  const limit = account.dailyLimit || 20;
  // Rozeti bul veya oluştur
  let badge = nameEl.querySelector('.sent-badge');
  if (sent > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'sent-badge';
      badge.style.cssText = 'font-size:10px;padding:1px 5px;border-radius:10px;background:var(--accent-glow2);color:var(--accent);margin-left:4px;font-weight:700;';
      nameEl.appendChild(badge);
    }
    badge.textContent = `${sent}/${limit}`;
  } else if (badge) {
    badge.remove();
  }
  // Progress bar
  const pct = Math.min(100, sent > 0 ? Math.round(sent / limit * 100) : 0);
  const bar = document.querySelector(`.account-item[data-id="${id}"] .acct-progress-bar`);
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.className = 'acct-progress-bar' + (pct >= 90 ? ' full' : pct >= 70 ? ' warn' : '');
  }
  // Stats şeridini güncelle
  updateStatsStrip();
}

// Sidebar istatistik şeridini güncelle
function updateStatsStrip() {
  const el = document.getElementById('sidebar-stats');
  if (!el) return;
  const totalSent   = Object.values(dailySends[todayKey()] || {}).reduce((a, b) => a + b, 0);
  const activeCount = Object.values(campaignRunning).filter(Boolean).length;
  const isWarming   = warmingRunning;
  const banRiskAccounts = accounts.filter(a => getNoWaRate(a.id) >= NO_WA_WARN_THRESHOLD);
  el.innerHTML =
    `<span class="stat-chip neutral">👥 ${accounts.length} Hesap</span>` +
    `<span class="stat-chip">📅 Bugün ${totalSent} Mesaj Gönderildi.</span>` +
    (activeCount > 0 ? `<span class="stat-chip blue">⚡ ${activeCount} Hesap Aktif</span>` : '') +
    (isWarming    ? `<span class="stat-chip hot">🔥 Güçlendirme Aktif</span>` : '') +
    (banRiskAccounts.length > 0 ? `<span class="stat-chip danger pulse">⚠️ ${banRiskAccounts.length} Ban Riski</span>` : '');
  // Hesap sayısı etiketi
  const countEl = document.getElementById('accounts-count');
  if (countEl) countEl.textContent = accounts.length;
}

// Durum metnini anında güncelle + rozeti de yenile
function setAccountStatus(id, text) {
  if (accountCountdowns[id]) { clearInterval(accountCountdowns[id]); delete accountCountdowns[id]; }
  accountStatusText[id] = text;
  const el = document.querySelector(`.account-item[data-id="${id}"] .account-status-text`);
  if (el) el.textContent = text;
  updateSentBadge(id);
}

// Canlı geri sayım: bekleme ve mola sürelerini saniye saniye gösterir
function setAccountCountdown(id, totalMs, prefix = '⏳ Bekliyor') {
  if (accountCountdowns[id]) { clearInterval(accountCountdowns[id]); delete accountCountdowns[id]; }
  const endTime = Date.now() + totalMs;
  const tick = () => {
    const rem  = Math.max(0, endTime - Date.now());
    const text = `${prefix} (${fmtMs(rem)})`;
    accountStatusText[id] = text;
    const el = document.querySelector(`.account-item[data-id="${id}"] .account-status-text`);
    if (el) el.textContent = text;
    if (rem <= 0) { clearInterval(accountCountdowns[id]); delete accountCountdowns[id]; }
  };
  tick();
  accountCountdowns[id] = setInterval(tick, 1000);
}

// Global kampanya verisi — tek kampanya, tüm hesaplar paylaşır
let globalTemplates = [];
let globalCampaign  = {
  templateIds:[],
  minInterval:8, maxInterval:20,
  breakAfter:5,  breakDuration:20,
  dailyLimit:20,
  hoursEnabled:false, hourFrom:'09:00', hourTo:'21:00',
  greetMode:false, greetTimeoutMin:5   // Önce Selam modu
};

// Global numara havuzu — tek liste, tüm hesaplar arasında dağıtılır
let globalCampaignNumbers = '';        // textarea raw içerik
let sentNumbersGlobal     = new Set(); // daha önce gönderilen numaralar (kalıcı)
let campaignQueue         = [];        // aktif çalışma sırasındaki sıra (shift ile alınır)
let globalCampaignRunning = false;     // herhangi bir hesap çalışıyor mu
let globalCampaignPaused  = false;     // duraklatıldı mı (kuyruk korunur)

// Hesap başına son 4 gönderilen şablon ID'si — tekrar önleme
const accountRecentTmplIds   = {};       // { accountId: string[] }
// Hesap başına son gönderilen mesajın ilk kelimesi — aynı kelimeyle başlamayı önle
const accountLastMsgFirstWord = {};      // { accountId: string }
// İç ısınma aralığı (her N kampanya mesajında bir) — Ayarlar'dan değiştirilebilir
let warmInterval = parseInt(localStorage.getItem('wa_warm_interval') || '2') || 2;

// Hesap sağlık durumu — kısıtlanan hesapları izle
const restrictedAccounts = new Set();  // { accountId }

// Çıkış yapılmış hesaplar — QR kodu görünen (oturum dışı) hesaplar
const loggedOutAccounts  = new Set();  // { accountId }

// ── Kara Liste: no_wa veya has_history numaraları kalıcı kayıt ──────────
let blacklistedNumbers = new Set();    // { phone string }

// ── Ban erken uyarı: hesap başına son no_wa eventlerinin timestamp'i ────
const accountNoWaHistory = {};         // { accountId: [timestamp, ...] }
const NO_WA_WARN_THRESHOLD = 0.4;      // %40 oranı geçerse uyar + yavaşlat
const NO_WA_WARN_WINDOW_MS = 3 * 60 * 60 * 1000; // son 3 saat

// ── Zamanlı kampanya başlatma ──────────────────────────────────────────
let scheduledCampaignTimer = null;     // setTimeout handle

// ── Masaüstü bildirim ayarı ────────────────────────────────────────────
let desktopNotifEnabled = true;

// ── OLED tema ─────────────────────────────────────────────────────────
let oledTheme = false;

// ── Aktif tag filtresi (sidebar) ───────────────────────────────────────
let activeTagFilter = '';              // boş = tümü göster

// Kampanya raporu — son kampanyanın istatistikleri
let campaignStats = {};     // { accountId: { name, sent, noWa, hasHistory, failed, replied, startTime, endTime, stopReason } }
let campaignStartTime = null;

// Dönüş yapan müşteri — greet modunda cevap veren / has_history toplam sayısı (kalıcı)
let returningCustomers = 0;

// Günlük gönderim sayacı { 'YYYY-MM-DD': count }
let dailySends = {};

// Her hesap için ayrı döngü kontrolü (paralel çalışma için)
let campaignRunning  = {};   // { accountId: bool }

// Güçlendirme modu
let warmingRunning    = false;
let warmingPaused     = false;           // Güçlendirme duraklat
let scheduledWarmingTimer = null;        // Zamanlı güçlendirme başlatma
let greetCustomPoolOverride    = null;   // Selam paneli özel havuzu
let greetPreviousTemplateIds   = null;   // Kampanya templateIds'i restore için
const GREET_TMP_ID = '__greet_followup_tmp__';
let warmingDailySends = {};  // { 'YYYY-MM-DD': { accountId: count } }

// ── AI API sabitleri (erken tanımlama — greeting + template generator paylaşır) ──
const AI_KEY_ANTHROPIC = 'wa_anthropic_key';
const AI_KEY_OPENAI    = 'wa_openai_key';
const AI_PROVIDER_KEY  = 'wa_ai_provider';

// ── Önce Selam Modu — Greeting Pool ────────────────────────────────────────
// Her seferinde farklı bir hal-hatır sorusu gönderilir.
// Müşteri cevap verirse hazır metin gönderilir.
const GREETING_POOL = [
  'Selam! Nasılsın? 😊',
  'Merhaba, iyi misin?',
  'Selam, umarım iyisindir! 👋',
  'Hey! Nasıl gidiyor?',
  'Merhaba! Günün nasıl geçiyor?',
  'Selam, her şey yolunda mı?',
  'Merhaba, nasılsın bugün?',
  'Hey, iyi misin inşallah? 😊',
  'Selamlar! Keyifler nasıl?',
  'Merhaba! Umarım güzel bir günündür 🌟',
  'Selam! Görüşmemiz üzerinden uzun zaman geçti, nasılsın?',
  'Merhaba, her şey nasıl? 😄',
];

// ── Yemleme (Lure) havuzu — merak uyandıran, cevap almayı garantilemek için tasarlanmış mesajlar ──
const LURE_POOL = [
  'Cüzdanınızı buldum, size ulaşmaya çalışıyorum.',
  'Adınıza bir kargo geldi, müsait misiniz?',
  'Hesabınızda bir sorun fark ettim, kontrol eder misiniz?',
  'Size özel bir teklifim var, uygun bir zaman var mı?',
  'Az önce bir ödeme bildirimi aldım, sizden mi geliyor?',
  'Numaranıza yanlışlıkla para transferi yapıldı, bilginiz var mı?',
  'İş görüşmesi için sizinle iletişime geçmem istendi.',
  'Ortak bir arkadaşımız sizi bana yönlendirdi.',
  'Geçen hafta paylaştığınız ilan hakkında sormak istiyorum.',
  'Sizi yanlış kişiyle mi karıştırıyorum acaba?',
  'Bu numara hâlâ aktif mi, önemli bir konu var.',
  'Bir süre önce yardımınızı istemiştim, hatırladınız mı?',
  'Çok acil bir durumda yardıma ihtiyacım var.',
  'Size ait bir belge bulundu, teslim için uygun musunuz?',
  'Ailenizden biri beni sizinle görüşmem için yönlendirdi.',
  'İlanınızı gördüm, hâlâ satılık mı?',
  'Geçen gün kısaca konuşmuştuk, hatırladınız mı?',
  'Müşterek tanıdığımız biri sizin hakkınızda çok iyi şeyler söyledi.',
  'Şu an neredesiniz, önemli bir paket bırakmam lazım.',
  'Telefonunuzu dün bir yerde gördüm sanırım, emin olmak istedim.',
];

// AI ile yemleme mesajı üret
async function generateAILures(count = 15) {
  const provider = localStorage.getItem(AI_PROVIDER_KEY) || 'anthropic';
  const keyId    = provider === 'anthropic' ? AI_KEY_ANTHROPIC : AI_KEY_OPENAI;
  const apiKey   = localStorage.getItem(keyId) || '';
  if (!apiKey) return null;

  const prompt = `WhatsApp'ta yabancı kişilerden yüksek cevap oranı almak için ${count} farklı Türkçe "yemleme" mesajı yaz.

Kurallar:
- Her mesaj merak uyandırsın, kişi cevap vermek istesin
- Kısa ve doğal olsun (1-2 cümle, max 15 kelime)
- Gerçek hayattan senaryolar: kargo, kayıp eşya, ortak tanıdık, iş teklifi, hata bildirimi gibi
- Emoji YOK, resmi değil ama ciddi ton
- Sadece JSON dizisi döndür, açıklama ekleme

Örnek: ["Cüzdanınızı buldum, size ulaşmaya çalışıyorum.", "Adınıza kargo var, uygun musunuz?", ...]`;

  try {
    const ipcChannel = provider === 'anthropic' ? 'anthropic-generate' : 'openai-generate';
    const result = await ipcRenderer.invoke(ipcChannel, { apiKey, prompt, maxTokens: 1024 });
    if (!result.ok) return null;
    const raw   = result.body?.content?.[0]?.text || result.body?.choices?.[0]?.message?.content || '';
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    const msgs = JSON.parse(match[0]);
    if (!Array.isArray(msgs) || !msgs.length) return null;
    return msgs.map(m => String(m).trim()).filter(Boolean);
  } catch { return null; }
}

// Son gönderilen greeting indeksi — per account, aynı selamı tekrarlamamak için
const lastGreetingIdx = {};
// AI ile üretilmiş selam havuzu — her hesap için ayrı önbellek
const aiGreetingCache = {}; // { accountId: string[] }

function pickGreeting(accountId) {
  // Selam paneli özel havuzu varsa önce oradan al
  if (greetCustomPoolOverride && greetCustomPoolOverride.length > 0) {
    const prev = lastGreetingIdx[accountId] ?? -1;
    let idx;
    do { idx = Math.floor(Math.random() * greetCustomPoolOverride.length); }
    while (idx === prev && greetCustomPoolOverride.length > 1);
    lastGreetingIdx[accountId] = idx;
    return greetCustomPoolOverride[idx];
  }
  // AI havuzu varsa oradan al
  const aiPool = aiGreetingCache[accountId];
  if (aiPool && aiPool.length > 0) {
    const msg = aiPool.shift(); // FIFO — sırayla kullan
    // Havuz 3'e düştüğünde arka planda yenile
    if (aiPool.length <= 3) {
      refillAIGreetings(accountId, 15).catch(() => {});
    }
    return msg;
  }
  // Fallback: statik havuz
  const prev = lastGreetingIdx[accountId] ?? -1;
  let idx;
  do {
    idx = Math.floor(Math.random() * GREETING_POOL.length);
  } while (idx === prev && GREETING_POOL.length > 1);
  lastGreetingIdx[accountId] = idx;
  return GREETING_POOL[idx];
}

// AI ile selam üret ve hesabın cache'ine ekle
// Kampanya başladığında çağrılır; arka planda dolum yapar
async function refillAIGreetings(accountId, count = 15) {
  const provider = localStorage.getItem(AI_PROVIDER_KEY) || 'anthropic';
  const keyId    = provider === 'anthropic' ? AI_KEY_ANTHROPIC : AI_KEY_OPENAI;
  const apiKey   = localStorage.getItem(keyId) || '';
  if (!apiKey) return; // API key yoksa sessizce atla

  const prompt = `Bir WhatsApp kampanyası için ${count} farklı Türkçe selamlama/hal-hatır mesajı yaz.

Kurallar:
- Her mesaj kısa olsun (1 cümle, max 12 kelime)
- Doğal ve samimi olsun — sanki gerçek bir insandan gelen mesaj gibi
- Hepsi birbirinden farklı kelime ve yapıda olsun
- Emoji kullanabilirsin ama abartma (0-1 emoji per mesaj)
- Sadece JSON dizisi döndür, başka hiçbir şey ekleme

Örnek format: ["Selam, nasılsın?", "Merhaba! Umarım güzel bir gündür 😊", ...]`;

  try {
    const ipcChannel = provider === 'anthropic' ? 'anthropic-generate' : 'openai-generate';
    const result = await ipcRenderer.invoke(ipcChannel, { apiKey, prompt, maxTokens: 1024 });
    if (!result.ok) return;

    const raw = (result.body?.content?.[0]?.text || result.body?.choices?.[0]?.message?.content || '');
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return;

    const msgs = JSON.parse(match[0]);
    if (!Array.isArray(msgs) || !msgs.length) return;

    // Cache'e ekle — varolan üstüne yaz (yeni liste ile taze başla)
    aiGreetingCache[accountId] = msgs.map(m => String(m).trim()).filter(Boolean);
    logToPanel(`[AI] 👋 ${accountId} için ${aiGreetingCache[accountId].length} selam üretildi`, 'log-info');
  } catch {
    // Hata durumunda sessizce statik havuza düş
  }
}

// Güçlendirme mesajları — çift sırayla kullanılır: A→B mesajı, B→A cevabı
// Format: [gönderici_mesajı, alıcı_cevabı] — çiftler dönüşümlü uygulanır
// Doğal sohbet zincirleri — her dizi bir konuşma akışı: [A→B, B→A, A→B, ...]
// Güçlendirme modunda çiftler bu konuşma ipliklerinden sırayla ilerlemiş gibi mesajlaşır.
const WARM_THREADS = [
  ['Naber? 😊',               'İyiyim ya, sen?',           'Ben de iyiyim 👍',            'Ne güzel, görüşürüz!'],
  ['Selam, nasılsın?',        'Teşekkürler, iyiyim 😊',    'Çok iyi, iyi günler!',        'Sana da!'],
  ['Müsait misin biraz?',     'Evet niye?',                'Bir şey soracaktım.',         'Söyle tabii?',         'Hallettim aslında 😅',  'Tamam iyi günler!'],
  ['Yarın uygun musun?',      'Evet olur, saat kaçta?',    'Saat 3 olur mu?',             'Olur, tamam 👍'],
  ['Gönderdiniz mi?',         'Evet az önce gönderdim.',   'Harika, aldım teşekkürler.',  'Rica ederim!'],
  ['Kontrol ettin mi?',       'Evet baktım, sorun yok.',   'Süper, teşekkürler.',         'Ne demek 😊'],
  ['Dosyayı aldın mı?',       'Aldım evet, sağ ol.',       'İyi çalışmalar!',             'Sana da!'],
  ['Haberin var mıydı?',      'Bilmiyordum, şimdi öğrendim.', 'Hmm, iyi bilgi.',          'Evet tam öyle!'],
  ['Gelecek misin?',          'Gelmeye çalışırım.',        'Tamam, bekliyoruz seni.',     'Olur görüşürüz 👋'],
  ['Ne zaman dönebilirsin?',  'Yarın sabah dönebilirim.',  'Tamam, beklerim.',            'Görüşürüz o zaman!'],
  ['Bir bakar mısın?',        'Tabii, hemen bakıyorum.',   'Teşekkürler.',                'Bir şey değil!'],
  ['Hallettik mi?',           'Evet, tamam hallettik 👍',  'Süper olmuş 🎉',              'Gerçekten mi? 😄'],
  ['İyi misin?',              'İyiyim evet, sen?',         'Ben de iyiyim, sağ ol.',      'Harika!'],
  ['Biraz zaman alabilir.',   'Sorun değil, bekliyorum.',  'İyi oldu.',                   'Peki görüşürüz!'],
  ['Haberdar ederim.',        'Tamam, bekliyorum.',        'Kısa sürede döneceğim.',      'Olur 👍'],
  ['Merak etme, hallolur.',   'Güveniyorum sana 😊',       'Bir sorun çıkarsa söylerim.',  'Tamam teşekkürler!'],
];
const WARM_EXCHANGES    = WARM_THREADS;  // geriye dönük uyumluluk
const WARMING_MESSAGES  = WARM_THREADS.flat();

// ══════════════════════════════════════════════════════════════════════════
//  DOM
// ══════════════════════════════════════════════════════════════════════════
const accountsList      = document.getElementById('accounts-list');
const mainContent       = document.getElementById('main-content');
const welcomeScreen     = document.getElementById('welcome-screen');
const addAccountBtn     = document.getElementById('add-account-btn');
const soundBtn          = document.getElementById('sound-btn');
const themeBtn          = document.getElementById('theme-btn');
const warmBtn           = document.getElementById('warm-btn');
const warmModalOverlay  = document.getElementById('warm-modal-overlay');
const accountPhoneInput = document.getElementById('account-phone-input');

const modalOverlay      = document.getElementById('modal-overlay');
const modalTitle        = document.getElementById('modal-title');
const accountNameInput  = document.getElementById('account-name-input');
const modalCancel       = document.getElementById('modal-cancel');
const modalConfirm      = document.getElementById('modal-confirm');

const tmplModalOverlay  = document.getElementById('tmpl-modal-overlay');
const tmplModalTitle    = document.getElementById('tmpl-modal-title');
const tmplNameInput     = document.getElementById('tmpl-name-input');
const tmplCatInput      = document.getElementById('tmpl-cat-input');
const tmplTextInput     = document.getElementById('tmpl-text-input');
const tmplModalCancel   = document.getElementById('tmpl-modal-cancel');
const tmplModalConfirm  = document.getElementById('tmpl-modal-confirm');

const campaignPanel     = document.getElementById('campaign-panel');
const cpAccountName     = document.getElementById('cp-account-name');
const cpCloseBtn        = document.getElementById('cp-close-btn');
const cpAddTmplBtn      = document.getElementById('cp-add-tmpl-btn');
const cpTemplatesList   = document.getElementById('cp-templates-list');
const cpNumbers         = document.getElementById('cp-numbers');
const cpMinInt          = document.getElementById('cp-min-int');
const cpMaxInt          = document.getElementById('cp-max-int');
const cpBreakAfter      = document.getElementById('cp-break-after');
const cpBreakDur        = document.getElementById('cp-break-dur');
const cpHoursEnabled    = document.getElementById('cp-hours-enabled');
const cpHoursRow        = document.getElementById('cp-hours-row');
const cpHourFrom        = document.getElementById('cp-hour-from');
const cpHourTo          = document.getElementById('cp-hour-to');
const cpStartBtn        = document.getElementById('cp-start-btn');
const cpStopBtn         = document.getElementById('cp-stop-btn');
const cpProgressFill    = document.getElementById('cp-progress-fill');
const cpProgressText    = document.getElementById('cp-progress-text');

const contextMenu       = document.getElementById('context-menu');
const ctxCampaign       = document.getElementById('ctx-campaign');
const ctxRename         = document.getElementById('ctx-rename');
const ctxDelete         = document.getElementById('ctx-delete');
const toast             = document.getElementById('toast');

// ══════════════════════════════════════════════════════════════════════════
//  GLOBAL HATA YAKALAYICI — beklenmedik crash'leri önle
// ══════════════════════════════════════════════════════════════════════════
window.addEventListener('unhandledrejection', e => {
  // Kampanya/güçlendirme döngülerindeki yakalanmamış promise hatalarını yut
  console.warn('[Sendigo] Yakalanmamış hata:', e.reason);
  e.preventDefault(); // Electron'un varsayılan hata penceresini engelle
});
window.addEventListener('error', e => {
  console.error('[Sendigo] Global hata:', e.message, e.filename, e.lineno);
});

// ══════════════════════════════════════════════════════════════════════════
//  YARDIMCILAR
// ══════════════════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Durdurulabilir + duraklatılabilir bekleme.
// Döndürdüğü değer:
//   true  → süre normal tamamlandı (veya pause'dan çıkıldı)
//   false → campaignRunning[accountId] false oldu (durduruldu)
async function sleepCancellable(ms, accountId) {
  const TICK = 500;
  const end  = Date.now() + ms;
  while (true) {
    if (!campaignRunning[accountId]) return false;
    if (globalCampaignPaused) {
      // Duraklatıldı — 500 ms'de bir kontrol et, end timer'ını dondur
      await sleep(TICK);
      continue;
    }
    if (Date.now() >= end) break;
    await sleep(Math.min(TICK, end - Date.now()));
  }
  return true;
}

// Güçlendirme döngüsü için durdurulabilir/duraklatılabilir bekleme
async function sleepWarm(ms) {
  let remaining = ms;
  while (remaining > 0) {
    if (!warmingRunning) return false;
    if (warmingPaused) {
      await sleep(500); // duraklat: sayaç ilerlemez
      continue;
    }
    const tick = Math.min(1000, remaining);
    await sleep(tick);
    remaining -= tick;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
//  COOLDOWN SABİTLERİ
// ══════════════════════════════════════════════════════════════════════════
// Hesap ekleme cooldown'u: her eklemede 8–15 dk arası rastgele seçilir
// Sabit süre yerine değişken süre kullanmak daha organik görünür
const ACCOUNT_SETTLE_MS = 20 * 60 * 1000;  // Giriş sonrası 20 dk yerleşme süresi (QR tarama → kampanya arası)
const ADD_CD_MIN_MS     = 8  * 60 * 1000;  //  8 dk
const ADD_CD_MAX_MS     = 15 * 60 * 1000;  // 15 dk

function getAddCooldownRemaining() {
  if (accounts.length === 0) return 0; // İlk hesap için cooldown yok
  const last   = parseInt(localStorage.getItem('wa_last_add_time') || '0');
  const cdUsed = parseInt(localStorage.getItem('wa_last_add_cd')   || '0') || ADD_CD_MIN_MS;
  return Math.max(0, cdUsed - (Date.now() - last));
}

function getSettleRemaining(accountId) {
  const started = sessionStarted[accountId];
  if (!started) return ACCOUNT_SETTLE_MS;
  return Math.max(0, ACCOUNT_SETTLE_MS - (Date.now() - started));
}

function fmtMs(ms) {
  const m = Math.floor(ms / 60000), s = Math.ceil((ms % 60000) / 1000);
  return m > 0 ? `${m} dk ${s > 0 ? s + ' sn' : ''}`.trim() : `${s} sn`;
}

function randomInterval(min, max) {
  // Float dakika döndür — tam dakika sınırlarında kalmasın (timing analizi önlemi)
  return min + Math.random() * (max - min);
}

// Hesap sağlık durumu: 'green' | 'yellow' | 'red' | 'blue' | 'gray'
function getAccountHealth(account) {
  if (loggedOutAccounts.has(account.id))  return 'red';
  if (restrictedAccounts.has(account.id)) return 'red';
  // Aktif kampanya veya güçlendirme çalışıyorsa → yeşil
  if (campaignRunning[account.id] || warmingRunning) return 'green';
  const sent  = getDailySent(account.id);
  const limit = account.dailyLimit || 20;
  // Boşta: gönderim varsa mavi, yoksa gri
  if (sent >= limit * 0.70) return 'yellow';
  if (sent > 0) return 'blue';
  return 'gray';
}
function getHealthLabel(health) {
  return {
    green:  'Aktif çalışıyor',
    blue:   'Boşta',
    yellow: 'Limite yakın',
    red:    'Kısıtlı / Çıkış yapıldı',
    gray:   'Bugün gönderim yok',
  }[health] || '';
}
// ── Kara Liste ────────────────────────────────────────────────────────────
function saveBlacklist() {
  localStorage.setItem('wa_blacklist', JSON.stringify([...blacklistedNumbers]));
}
function addToBlacklist(phone) {
  if (!phone) return;
  blacklistedNumbers.add(String(phone).trim());
  saveBlacklist();
}
function removeFromBlacklist(phone) {
  blacklistedNumbers.delete(String(phone).trim());
  saveBlacklist();
}
function isBlacklisted(phone) {
  return blacklistedNumbers.has(String(phone).trim());
}
function renderBlacklistPanel() {
  const listEl  = document.getElementById('blacklist-list');
  const countEl = document.getElementById('bl-count-chip');
  const emptyEl = document.getElementById('bl-empty-msg');
  if (!listEl) return;
  const nums = [...blacklistedNumbers];
  if (countEl) countEl.textContent = `${nums.length} numara`;
  // mevcut satırları temizle (boş mesaj hariç)
  [...listEl.children].forEach(c => { if (c.id !== 'bl-empty-msg') c.remove(); });
  if (nums.length === 0) {
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  nums.forEach(phone => {
    const row = document.createElement('div');
    row.className = 'bl-item';
    row.innerHTML = `<span class="bl-phone">${phone}</span>
      <button class="bl-remove-btn" data-phone="${phone}">✕</button>`;
    row.querySelector('.bl-remove-btn').addEventListener('click', () => {
      removeFromBlacklist(phone);
      renderBlacklistPanel();
    });
    listEl.appendChild(row);
  });
}

// ── Ban Erken Uyarı ────────────────────────────────────────────────────────
function recordNoWaEvent(accountId) {
  if (!accountNoWaHistory[accountId]) accountNoWaHistory[accountId] = [];
  accountNoWaHistory[accountId].push(Date.now());
}
function getNoWaRate(accountId) {
  const history = accountNoWaHistory[accountId];
  if (!history || history.length === 0) return 0;
  const cutoff = Date.now() - NO_WA_WARN_WINDOW_MS;
  // eski kayıtları temizle
  accountNoWaHistory[accountId] = history.filter(t => t >= cutoff);
  const recent = accountNoWaHistory[accountId];
  if (recent.length === 0) return 0;
  // son 3 saatte gönderilen mesajları bul
  const sent = getDailySent(accountId);
  if (sent === 0) return 0;
  return recent.length / sent;
}
function getAccountsAtBanRisk() {
  return accounts.filter(a => getNoWaRate(a.id) >= NO_WA_WARN_THRESHOLD);
}

// ── Masaüstü Bildirim ─────────────────────────────────────────────────────
function sendSystemNotification(title, body) {
  if (!desktopNotifEnabled) return;
  try {
    new Notification(title, { body });
  } catch (e) {
    // Bildirim izni yoksa sessizce geç
  }
}

// ── OLED Tema ─────────────────────────────────────────────────────────────
function applyOledTheme() {
  document.body.classList.toggle('oled', oledTheme && darkTheme);
  localStorage.setItem('wa_oled_theme', oledTheme ? '1' : '0');
}

// ── Etiket Yardımcıları ────────────────────────────────────────────────────
function getTagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  return 'tag-c' + (hash % 8);
}
function renderTagFilter() {
  const row = document.getElementById('tag-filter-row');
  if (!row) return;
  // tüm etiketleri topla
  const allTags = new Set();
  accounts.forEach(a => (a.tags || []).forEach(t => allTags.add(t)));
  if (allTags.size === 0) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.innerHTML = '';
  // "Tümü" pill
  const allPill = document.createElement('button');
  allPill.className = 'tag-filter-pill' + (activeTagFilter === '' ? ' active' : '');
  allPill.textContent = '🏷️ Tümü';
  allPill.addEventListener('click', () => { activeTagFilter = ''; renderAccounts(); });
  row.appendChild(allPill);
  allTags.forEach(tag => {
    const pill = document.createElement('button');
    pill.className = 'tag-filter-pill ' + getTagColor(tag) + (activeTagFilter === tag ? ' active' : '');
    pill.textContent = tag;
    pill.addEventListener('click', () => { activeTagFilter = tag; renderAccounts(); });
    row.appendChild(pill);
  });
}

// ── İstatistik Paneli ─────────────────────────────────────────────────────
function openStatsPanel() {
  // 7 günlük grafik verisi oluştur
  const chartEl = document.getElementById('stats-7day-chart');
  const gridEl  = document.getElementById('stats-acct-grid');
  if (!chartEl || !gridEl) return;

  // Son 7 gün etiketleri
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push({ label: d.toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric' }), key: d.toISOString().slice(0, 10) });
  }

  // Her gün toplam gönderimi hesapla (tüm hesaplar toplamı)
  function getDailySentOnDay(dateKey) {
    let total = 0;
    accounts.forEach(a => {
      const storageKey = `sent_${a.id}_${dateKey}`;
      total += parseInt(localStorage.getItem(storageKey) || '0', 10);
    });
    return total;
  }

  const dayValues = days.map(d => getDailySentOnDay(d.key));
  const maxVal = Math.max(...dayValues, 1);

  // SVG bar chart
  const barW = 36, barGap = 14, chartH = 120, padL = 10, padB = 30;
  const chartW = padL * 2 + days.length * (barW + barGap) - barGap;
  let svgBars = '';
  days.forEach((d, i) => {
    const val = dayValues[i];
    const barH = Math.max(4, Math.round((val / maxVal) * chartH));
    const x = padL + i * (barW + barGap);
    const y = chartH - barH;
    const isToday = (i === 6);
    svgBars += `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}"
        rx="5" ry="5"
        fill="${isToday ? 'var(--accent)' : 'var(--accent-glow2)'}"
        opacity="${isToday ? 1 : 0.65}"/>
      <text x="${x + barW / 2}" y="${chartH + 14}" text-anchor="middle"
        font-size="9" fill="var(--text-muted)">${d.label}</text>
      ${val > 0 ? `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="9" fill="var(--accent)" font-weight="700">${val}</text>` : ''}
    `;
  });

  chartEl.innerHTML = `
    <div class="stats-section-title">Son 7 Gün Toplam Gönderim</div>
    <svg viewBox="0 0 ${chartW} ${chartH + padB}" style="width:100%;overflow:visible">
      ${svgBars}
    </svg>`;

  // Hesap başına bugünkü istatistik
  const todayKey = new Date().toISOString().slice(0, 10);
  gridEl.innerHTML = '';
  if (accounts.length === 0) {
    gridEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Hesap yok.</div>';
  } else {
    const title = document.createElement('div');
    title.className = 'stats-section-title';
    title.style.gridColumn = '1 / -1'; // tüm sütunları kapla
    title.textContent = 'Bugün Hesap Bazlı';
    gridEl.appendChild(title);
    accounts.forEach(a => {
      const sent  = getDailySent(a.id);
      const limit = a.dailyLimit || 20;
      const pct   = Math.min(100, Math.round(sent / limit * 100));
      const health = getAccountHealth(a);
      const noWaRate = getNoWaRate(a.id);
      const card = document.createElement('div');
      card.className = 'stats-acct-card';
      card.innerHTML = `
        <div class="stats-acct-name">${a.name}</div>
        <div class="stats-acct-num">${sent} / ${limit}</div>
        <div class="stats-bar-wrap">
          <div class="stats-bar-fill" style="width:${pct}%;background:${pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : 'var(--accent)'}"></div>
        </div>
        <div class="stats-acct-sub">${getHealthLabel(health)}${noWaRate >= NO_WA_WARN_THRESHOLD ? ' ⚠️ Ban riski' : ''}</div>`;
      gridEl.appendChild(card);
    });
  }

  // ── Dönüş yapan müşteri kartı ──────────────────────────────────────────
  const returnEl = document.getElementById('stats-returning-card');
  if (returnEl) {
    const totalSentAll = accounts.reduce((s, a) => s + getDailySent(a.id), 0);
    const returnPct = totalSentAll > 0 ? Math.round(returningCustomers / Math.max(totalSentAll, returningCustomers) * 100) : 0;
    returnEl.innerHTML = `
      <div class="stats-kpi-icon">🔄</div>
      <div class="stats-kpi-val">${returningCustomers}</div>
      <div class="stats-kpi-lbl">Dönüş Yapan Müşteri</div>
      <div class="stats-kpi-sub">${returnPct > 0 ? `Toplam gönderimin %${returnPct}'i` : 'Henüz kayıt yok'}</div>`;
  }

  document.getElementById('stats-modal-overlay').classList.add('show');
}
function closeStatsPanel() {
  const el = document.getElementById('stats-modal-overlay');
  if (el) el.classList.remove('show');
}

function generateId() {
  return '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}
function getInitials(name) {
  return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}
const COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#ef4444','#06b6d4','#84cc16','#f97316','#a855f7','#14b8a6','#f43f5e'];

// Gradient avatar rengi — iki komşu rengi birleştir
function getAvatarGradient(id) {
  const h = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const c1 = COLORS[h % COLORS.length];
  const c2 = COLORS[(h + 4) % COLORS.length];
  return `linear-gradient(145deg, ${c1} 0%, ${c2} 100%)`;
}

// ── Yazma Hızı ────────────────────────────────────────────────────────────
const TYPING_SPEED_LABELS = ['🐢 Çok Yavaş', 'Yavaş', 'Normal', 'Hızlı', '⚡ Çok Hızlı'];
const TYPING_SPEED_MULS   = [2.5, 1.6, 1.0, 0.6, 0.3];
function getTypingMul() { return TYPING_SPEED_MULS[typingSpeed - 1] || 1.0; }
function applyTypingSpeed() {
  const slider = document.getElementById('typing-speed-slider');
  const label  = document.getElementById('tsb-val');
  if (slider) slider.value = typingSpeed;
  if (label)  label.textContent = TYPING_SPEED_LABELS[typingSpeed - 1];
  localStorage.setItem('wa_typing_speed', typingSpeed.toString());
}
function getColor(id) {
  const h = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return COLORS[h % COLORS.length];
}
function escHtml(t) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(t));
  return d.innerHTML;
}
let toastTimer = null;
function showToast(msg, ms = 2200) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}

// ── Güvenlik engel popup'ı ────────────────────────────────────────────────
// type: 'settle' | 'addcooldown' | 'custom'
function showSecurityBlock({ icon = '🛡️', title, msg, detail }) {
  document.getElementById('sec-block-icon').textContent = icon;
  document.getElementById('sec-block-title').textContent = title;
  document.getElementById('sec-block-msg').textContent = msg;
  document.getElementById('sec-block-detail').innerHTML = detail;
  document.getElementById('sec-block-overlay').classList.add('show');
}
function closeSecurityBlock() {
  document.getElementById('sec-block-overlay')?.classList.remove('show');
}
// Buton bağlantıları — script body sonunda yükleniyor, DOM hazır
// (warmModalOverlay gibi diğer handler'lar da aynı şekilde direkt tanımlanıyor)
// Bağlantılar aşağıda diğer event listener'larla birlikte kurulacak (bkz: initSecBlockModal)
function parseNumbers(raw) {
  return raw.split('\n').map(n => n.replace(/\D/g, '').trim()).filter(n => n.length >= 10);
}

// ── Proxy yardımcıları ────────────────────────────────────────────────────

// Serbest formatlı proxy string'ini Electron proxyRules formatına çevir
function parseProxyString(raw) {
  raw = (raw || '').trim();
  if (!raw) return 'direct://';
  // Zaten URL formatında
  if (/^(socks5?|https?):\/\//i.test(raw)) return raw;
  // user:pass@host:port formatı
  if (raw.includes('@')) return `http://${raw}`;
  const parts = raw.split(':');
  // host:port:user:pass (4 parça)
  if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  // host:port (2 parça)
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return `http://${raw}`;
}

// Hesabın aktif proxy'sini Electron session'ına uygula (IPC üzerinden)
async function applyAccountProxy(accountId) {
  try {
    const account  = accounts.find(a => a.id === accountId);
    const partition = `persist:${accountId}`;
    if (!account || !account.proxies || !account.proxies.length) {
      await ipcRenderer.invoke('set-proxy', { partition, proxyRules: 'direct://' });
      return null;
    }
    const idx        = (account.proxyIdx || 0) % account.proxies.length;
    const proxyStr   = account.proxies[idx];
    const proxyRules = parseProxyString(proxyStr);
    const result     = await ipcRenderer.invoke('set-proxy', { partition, proxyRules });
    if (!result.ok) console.warn('Proxy uygulanamadı:', result.error);
    return proxyStr;
  } catch (e) {
    console.warn('applyAccountProxy hata:', e);
    return null;
  }
}

// Round-robin: proxyIdx'i bir ilerlet, kaydet
function rotateProxy(accountId) {
  const account = accounts.find(a => a.id === accountId);
  if (!account || !account.proxies || account.proxies.length <= 1) return;
  account.proxyIdx = ((account.proxyIdx || 0) + 1) % account.proxies.length;
  saveAccounts();
}

// ── Cihaz parmak izi tutarlılığı — hesap başına sabit ekran çözünürlüğü ──
// Her hesap için bir kez üret ve localStorage'a kaydet; sonraki oturumlarda aynı kalsın
function getDeviceFingerprint(accountId) {
  const key = `wa_fp_${accountId}`;
  let fp = null;
  try { fp = JSON.parse(localStorage.getItem(key)); } catch {}
  if (fp && fp.screenW && fp.screenH) return fp;

  // Gerçekçi ekran çözünürlükleri (ağırlıklı — en yaygın olanlar daha sık çıksın)
  const resPool = [
    [1920, 1080], [1920, 1080], [1920, 1080], [1920, 1080],
    [1366,  768], [1366,  768], [1366,  768],
    [1536,  864], [1536,  864],
    [1440,  900], [1440,  900],
    [1280,  720], [1600,  900],
    [2560, 1440], [1280, 1024],
  ];
  const [w, h]   = resPool[Math.floor(Math.random() * resPool.length)];
  const chromeVs = ['120', '121', '122', '123', '124'];
  const chromeV  = chromeVs[Math.floor(Math.random() * chromeVs.length)];
  fp = { screenW: w, screenH: h, chromeVer: chromeV, createdAt: Date.now() };
  localStorage.setItem(key, JSON.stringify(fp));
  return fp;
}

// Aktif proxy'nin kısa gösterim string'i
function proxyLabel(account) {
  if (!account.proxies || !account.proxies.length) return null;
  const p   = account.proxies[(account.proxyIdx || 0) % account.proxies.length];
  // "user:pass@1.2.3.4:8080" → "1.2.3.4:8080"
  const clean = p.replace(/^(socks5?|https?):\/\//i, '').replace(/^[^@]+@/, '');
  return clean.length > 22 ? clean.slice(0, 22) + '…' : clean;
}

// ── Mesaj çeşitlendirme: {a|b|c} → rastgele seçim ──
function spinMessage(text) {
  return text.replace(/\{([^}]+)\}/g, (_, group) => {
    const opts = group.split('|');
    return opts[Math.floor(Math.random() * opts.length)];
  });
}

// ── Günlük limit takibi — per-account ──
// dailySends formatı: { 'YYYY-MM-DD': { accountId: count } }
function todayKey() { return new Date().toISOString().slice(0, 10); }
function getDailySent(accountId) {
  const day = dailySends[todayKey()];
  if (!day) return 0;
  if (accountId !== undefined) return day[accountId] || 0;
  return Object.values(day).reduce((a, b) => a + b, 0);
}
function incrementDaily(accountId) {
  const k = todayKey();
  if (!dailySends[k]) dailySends[k] = {};
  dailySends[k][accountId] = (dailySends[k][accountId] || 0) + 1;
  // 7 günden eski kayıtları temizle
  Object.keys(dailySends).forEach(d => { if (d < new Date(Date.now() - 7*86400000).toISOString().slice(0,10)) delete dailySends[d]; });
  localStorage.setItem('wa_bm_daily', JSON.stringify(dailySends));
}

// ── Çalışma saati kontrolü ──
function isWithinHours(from, to) {
  const now  = new Date();
  const cur  = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return cur >= fh * 60 + fm && cur < th * 60 + tm;
}

// ── Hesap kısıtlama tespiti ──
async function isAccountRestricted(wv) {
  try {
    const result = await safeExecJS(wv, `
      (function() {
        const body = document.body?.innerText || '';
        return body.includes('temporarily banned')
            || body.includes('geçici olarak yasaklandı')
            || body.includes('kısıtlandı')
            || body.includes('restricted')
            || body.includes('spam')
            || !!document.querySelector('[data-testid="popup-contents"] [data-testid="confirm-popup-ok"]');
      })()
    `, 8000);
    return !!result;
  } catch { return false; }
}

// ── Doğal oturum simülasyonu: gerçek sohbetlere tıkla, mesajları oku ──
// (eski warmUpSession'ın yerini aldı — programatik scroll ban tetikliyor)
async function simulateReading(wv) {
  try {
    await wv.executeJavaScript(`
      (async function() {
        // Sohbet listesindeki bir chate tıkla
        const chats = document.querySelectorAll('[data-testid="cell-frame-container"]');
        if (!chats.length) return;
        const idx = Math.floor(Math.random() * Math.min(chats.length, 6));
        chats[idx].click();
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1200 + 700)));

        // Açık konuşmadaki mesajları geriye doğru kaydır (okuyormuş gibi)
        const msgArea = document.querySelector('[data-testid="msg-container"]')
                     || document.querySelector('#main .copyable-area');
        if (msgArea) {
          const steps = Math.floor(Math.random() * 3) + 2;
          for (let i = 0; i < steps; i++) {
            msgArea.scrollTop -= Math.floor(Math.random() * 180 + 80);
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 700 + 350)));
          }
          await new Promise(r => setTimeout(r, Math.floor(Math.random() * 900 + 400)));
          // Tekrar aşağı kaydır (okundu olarak işaretleme gibi)
          msgArea.scrollTop = msgArea.scrollHeight;
          await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500 + 200)));
        }
      })()
    `);
    await humanDelay(800, 1800);
  } catch {}
}

// ── Mesajlar arası rastgele doğal aktivite (%30 ihtimalle tetiklenir ──
async function addNaturalActivity(wv) {
  if (Math.random() > 0.30) return; // Sadece %30 ihtimalle yap
  try {
    logToPanel('👀 Doğal aktivite…', 'log-wait');
    await simulateReading(wv);
    await humanDelay(1000, 2500);
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════
//  SAHTE PRESENCE PATTERN SİSTEMİ
// ══════════════════════════════════════════════════════════════════════════

// Gerçekçi fare hareketi: Bezier benzeri rastgele yörünge
async function simulateMouseMovement(wv) {
  try {
    await wv.executeJavaScript(`(async function() {
      let x = Math.floor(Math.random() * 500 + 200);
      let y = Math.floor(Math.random() * 350 + 150);
      // 5-9 adımlı yavaş fare hareketi
      const steps = Math.floor(Math.random() * 5) + 5;
      for (let i = 0; i < steps; i++) {
        x = Math.max(60, Math.min(x + Math.floor(Math.random() * 90 - 45), 1300));
        y = Math.max(60, Math.min(y + Math.floor(Math.random() * 70 - 35),  800));
        document.dispatchEvent(new MouseEvent('mousemove', {
          clientX: x, clientY: y, bubbles: true, cancelable: true,
          movementX: Math.floor(Math.random()*6-3),
          movementY: Math.floor(Math.random()*4-2),
        }));
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 90 + 25)));
      }
    })()`);
  } catch {}
}

// Sohbet listesini yumuşak kaydır (programatik scroll ban tetikliyordu — burada event bazlı)
async function simulateSoftScroll(wv) {
  try {
    await wv.executeJavaScript(`(async function() {
      const pane = document.querySelector('#pane-side') || document.querySelector('[data-testid="chat-list"]');
      if (!pane) return;
      const dir   = Math.random() > 0.5 ? 1 : -1;
      const total = Math.floor(Math.random() * 80 + 30);
      const steps = Math.floor(Math.random() * 5) + 4;
      for (let i = 0; i < steps; i++) {
        pane.dispatchEvent(new WheelEvent('wheel', {
          deltaY: dir * (total / steps) * (0.8 + Math.random() * 0.4),
          bubbles: true, cancelable: true,
        }));
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 120 + 40)));
      }
    })()`);
  } catch {}
}

// Tek bir presence aktivitesi — kampanya çalışmıyorken arka planda tetiklenir
async function doPresenceActivity(wv, accountId) {
  if (!wv || !document.getElementById(`wv_${accountId}`)) return;
  if (campaignRunning[accountId]) return; // Kampanya çalışırken dokunma
  if (warmingRunning) return;             // Güçlendirme çalışırken dokunma

  const roll = Math.random();
  try {
    if (roll < 0.30) {
      // Sadece fare hareketi
      await simulateMouseMovement(wv);

    } else if (roll < 0.52) {
      // Sohbet listesi yumuşak scroll
      await simulateSoftScroll(wv);
      await humanDelay(400, 900);
      // %40 ihtimalle scroll'dan sonra da fare hareket ettir
      if (Math.random() < 0.4) await simulateMouseMovement(wv);

    } else if (roll < 0.72) {
      // Bir sohbete tıkla, birkaç mesaj oku, geri çık
      await simulateReading(wv);

    } else if (roll < 0.86) {
      // Fare hareketi + hafif scroll kombinasyonu
      await simulateMouseMovement(wv);
      await humanDelay(300, 700);
      await simulateSoftScroll(wv);

    } else if (roll < 0.93) {
      // WhatsApp Status / Hikayeler sayfasını ziyaret et — çok organik bir eylem
      await wv.executeJavaScript(`(async function() {
        const statusBtn = document.querySelector('[data-testid="status"]')
                       || document.querySelector('[data-icon="status"]')?.closest('[role="button"]')
                       || document.querySelector('span[data-icon="status-tab"]')?.closest('[role="button"]');
        if (statusBtn) {
          statusBtn.click();
          await new Promise(r => setTimeout(r, ${randomInterval(4000, 9000)}));
          // Geri sohbetlere dön
          const chatsBtn = document.querySelector('[data-testid="chats-tab"]')
                        || document.querySelector('[data-icon="chats"]')?.closest('[role="button"]');
          if (chatsBtn) chatsBtn.click();
        }
      })()`).catch(() => {});

    } else {
      // Arşivlenmiş sohbetlere bak, sonra geri dön
      await wv.executeJavaScript(`(async function() {
        const archiveRow = document.querySelector('[data-testid="archived-tabs-btn"]')
                        || document.querySelector('[data-testid="cell-frame-container"][aria-label*="rşiv"]');
        if (archiveRow) {
          archiveRow.click();
          await new Promise(r => setTimeout(r, ${randomInterval(3000, 7000)}));
          // Geri butonu
          const back = document.querySelector('[data-testid="back"]')
                    || document.querySelector('button[aria-label="Geri"]')
                    || document.querySelector('button[aria-label="Back"]');
          if (back) back.click();
        } else {
          // Arşiv yoksa sadece klavye aktivitesi (scroll kısayolu gibi)
          if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
          }
          await new Promise(r => setTimeout(r, ${randomInterval(1500, 4000)}));
          document.dispatchEvent(new MouseEvent('click', {
            clientX: ${Math.floor(Math.random()*300+200)},
            clientY: ${Math.floor(Math.random()*200+100)},
            bubbles: true,
          }));
        }
      })()`).catch(() => {});
    }
  } catch {}
}

// Bir sonraki presence aktivitesini rastgele aralıkta planla
// ── Gece sessiz modu: 23:00–07:30 arası aktivite yok ────────────────────
function isNightMode() {
  const h = new Date().getHours();
  return h >= 23 || h < 7;  // gece 23:00 – sabah 07:00
}

// Bir sonraki gündüz başlangıcına kaç ms kaldığını hesapla
function msUntilMorning() {
  const now  = new Date();
  const wake = new Date(now);
  wake.setHours(7, 30, 0, 0);               // 07:30'da uyan
  if (wake <= now) wake.setDate(wake.getDate() + 1);
  // ±20 dakika rastgelelik — her hesap farklı saatte "uyanıyor"
  // Min floor: sıfır/negatif timeout setTimeout'u hemen tetikler, en az 30sn olsun
  return Math.max(30000, (wake - now) + randomInterval(-20 * 60000, 20 * 60000));
}

// ── Visibility döngüsü — gerçek kullanıcı odak kaybı/kazanımı ────────────
// WhatsApp'ın en kritik izleme sinyali: hasFocus ve visibilityState.
// 7/24 "visible+focused" = kesin bot işareti.
const visibilityTimers = {};   // { accountId: timeoutHandle }

async function simulateFocusLoss(wv, accountId) {
  if (!wv) return;
  try {
    // "Kullanıcı başka pencereye geçti" — hidden + unfocused
    await wv.executeJavaScript(`
      try {
        Object.defineProperty(document, 'hidden',          { get: () => true,      configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'hidden',  configurable: true });
        document.hasFocus = () => false;
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
        window.dispatchEvent(new FocusEvent('blur'));
      } catch(e) {}
      void 0;
    `).catch(() => {});
  } catch {}
}

async function simulateFocusReturn(wv, accountId) {
  if (!wv) return;
  try {
    // "Kullanıcı geri döndü"
    await wv.executeJavaScript(`
      try {
        Object.defineProperty(document, 'hidden',          { get: () => false,     configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        document.hasFocus = () => true;
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
        window.dispatchEvent(new FocusEvent('focus'));
      } catch(e) {}
      void 0;
    `).catch(() => {});
  } catch {}
}

function scheduleVisibilityCycle(wv, accountId) {
  if (visibilityTimers[accountId]) clearTimeout(visibilityTimers[accountId]);

  // Gece modundaysa sabaha kadar bekle, gündüz focus döngüsü yap
  if (isNightMode()) {
    // Gece: focus kaybını simüle et ve sabaha kadar uyu
    simulateFocusLoss(wv, accountId).catch(() => {});
    const wakeMs = msUntilMorning();
    visibilityTimers[accountId] = setTimeout(() => {
      simulateFocusReturn(wv, accountId).catch(() => {});
      // Sabah 07:30'da focus geri geldi, döngüyü yeniden başlat
      scheduleVisibilityCycle(wv, accountId);
    }, wakeMs);
    return;
  }

  // Gündüz: 45–110 dk sonra focus kaybet
  const awayIn = randomInterval(45 * 60000, 110 * 60000);
  visibilityTimers[accountId] = setTimeout(async () => {
    if (campaignRunning[accountId] || warmingRunning) {
      // Kampanya veya güçlendirme çalışırken focus kaybı olmasın
      scheduleVisibilityCycle(wv, accountId);
      return;
    }
    await simulateFocusLoss(wv, accountId);

    // 8–35 dk "uzaktaydı" — sonra geri dön
    const goneMs = randomInterval(8 * 60000, 35 * 60000);
    visibilityTimers[accountId] = setTimeout(async () => {
      await simulateFocusReturn(wv, accountId);
      // Geri döndükten sonra kısa bir aktivite yap
      await humanDelay(3000, 8000);
      await doPresenceActivity(wv, accountId);
      scheduleVisibilityCycle(wv, accountId);  // döngü devam
    }, goneMs);
  }, awayIn);
}

function stopVisibilityCycle(accountId) {
  if (visibilityTimers[accountId]) {
    clearTimeout(visibilityTimers[accountId]);
    delete visibilityTimers[accountId];
  }
}

function schedulePresence(wv, accountId) {
  if (presenceTimers[accountId]) clearTimeout(presenceTimers[accountId]);
  if (isNightMode()) {
    // Gece modunda presence aktivitesi yok — sabaha planla
    const wakeMs = msUntilMorning() + randomInterval(5 * 60000, 20 * 60000);
    presenceTimers[accountId] = setTimeout(() => schedulePresence(wv, accountId), wakeMs);
    return;
  }
  // Gündüz: 3–12 dakika aralıklı aktivite (eskiden 8–22 dk idi, çok seyrекti)
  const delay = randomInterval(3 * 60 * 1000, 12 * 60 * 1000);
  presenceTimers[accountId] = setTimeout(async () => {
    await doPresenceActivity(wv, accountId);
    schedulePresence(wv, accountId);
  }, delay);
}

// Bir hesap için presence pattern'i başlat (webview yüklendikten sonra)
function startPresencePattern(wv, accountId) {
  if (presenceTimers[accountId]) clearTimeout(presenceTimers[accountId]);
  // Gece ise hemen sessiz moda al, gündüzse 60–120 sn sonra başla
  const initDelay = isNightMode() ? 5000 : randomInterval(60 * 1000, 120 * 1000);
  presenceTimers[accountId] = setTimeout(() => {
    schedulePresence(wv, accountId);
    scheduleVisibilityCycle(wv, accountId);  // visibility döngüsünü de başlat
  }, initDelay);
}

// Hesap silindiğinde / kampanya sırasında temizle
function stopPresencePattern(accountId) {
  if (presenceTimers[accountId]) {
    clearTimeout(presenceTimers[accountId]);
    delete presenceTimers[accountId];
  }
  stopVisibilityCycle(accountId);
}

// ══════════════════════════════════════════════════════════════════════════
//  KAYDETME / YÜKLEME
// ══════════════════════════════════════════════════════════════════════════
function loadState() {
  try { const r = localStorage.getItem('wa_bm_accounts');  if (r) accounts = JSON.parse(r); } catch { accounts = []; }
  try { const r = localStorage.getItem('wa_bm_templates'); if (r) globalTemplates = JSON.parse(r); } catch { globalTemplates = []; }
  try {
    const r = localStorage.getItem('wa_bm_campaign');
    if (r) {
      const saved = JSON.parse(r);
      delete saved.numbersRaw; // eski sürüm artık global
      globalCampaign = { ...globalCampaign, ...saved };
    }
  } catch {}
  try {
    const r = localStorage.getItem('wa_bm_daily');
    if (r) {
      const parsed = JSON.parse(r);
      // Eski format { 'YYYY-MM-DD': number } → yeni { 'YYYY-MM-DD': { accountId: count } }
      dailySends = {};
      Object.entries(parsed).forEach(([date, val]) => {
        dailySends[date] = (val !== null && typeof val === 'object') ? val : {};
      });
    }
  } catch { dailySends = {}; }
  try { const r = localStorage.getItem('wa_bm_warm_daily'); if (r) warmingDailySends = JSON.parse(r); } catch {}
  // Global numara havuzu
  try { globalCampaignNumbers = localStorage.getItem('wa_bm_numbers_global') || ''; } catch {}
  // Daha önce gönderilmiş numaralar (kalıcı)
  try {
    const r = localStorage.getItem('wa_bm_sent_global');
    if (r) sentNumbersGlobal = new Set(JSON.parse(r));
  } catch {}
  darkTheme    = localStorage.getItem('wa_bm_dark')  !== '0';
  soundEnabled = localStorage.getItem('wa_bm_sound') !== '0';
  typingSpeed  = Math.min(5, Math.max(1, parseInt(localStorage.getItem('wa_typing_speed') || '3') || 3));
  try {
    const sec = localStorage.getItem('wa_security_settings');
    if (sec) securitySettings = { ...securitySettings, ...JSON.parse(sec) };
  } catch {}
  // Hesap yerleşme zamanlarını yükle — restart sonrası cooldown devam etsin
  try {
    const ss = localStorage.getItem('wa_session_started');
    if (ss) Object.assign(sessionStarted, JSON.parse(ss));
  } catch {}
  // Çıkış yapılmış hesaplar — restart'ta bağlanmasın
  try {
    const lo = localStorage.getItem('wa_logged_out');
    if (lo) JSON.parse(lo).forEach(id => loggedOutAccounts.add(id));
  } catch {}
  // Kara liste
  try {
    const bl = localStorage.getItem('wa_blacklist');
    if (bl) blacklistedNumbers = new Set(JSON.parse(bl));
  } catch {}
  // OLED tema
  oledTheme = localStorage.getItem('wa_oled_theme') === '1';
  // Masaüstü bildirim
  desktopNotifEnabled = localStorage.getItem('wa_desktop_notif') !== '0';
  // Dönüş yapan müşteri sayacı
  returningCustomers = parseInt(localStorage.getItem('wa_returning_customers') || '0', 10) || 0;
}
function saveAccounts() { localStorage.setItem('wa_bm_accounts', JSON.stringify(accounts)); }
function saveSecuritySettings() { localStorage.setItem('wa_security_settings', JSON.stringify(securitySettings)); }
// Yerleşme zamanlarını kalıcı yap — restart sonrası cooldown sıfırlanmasın
function saveSessionStarted() { localStorage.setItem('wa_session_started', JSON.stringify(sessionStarted)); }
// Çıkış yapılmış hesapları kalıcı yap — restart'ta boşuna bağlanmasın
function saveLoggedOut() { localStorage.setItem('wa_logged_out', JSON.stringify([...loggedOutAccounts])); }
function applySecuritySettings() {
  const settleEl = document.getElementById('sec-settle-toggle');
  const addcdEl  = document.getElementById('sec-addcd-toggle');
  if (settleEl) settleEl.checked = securitySettings.settleCooldown;
  if (addcdEl)  addcdEl.checked  = securitySettings.addCooldown;
}
function openSecurityModal() {
  applySecuritySettings();
  document.getElementById('security-modal-overlay').classList.add('show');
}
function closeSecurityModal() {
  document.getElementById('security-modal-overlay').classList.remove('show');
}

// ══════════════════════════════════════════════════════════════════════════
//  AYARLAR MODAL
// ══════════════════════════════════════════════════════════════════════════
function openSettingsModal() {
  // Tema & Ses
  const themeToggle = document.getElementById('st-theme');
  const soundToggle = document.getElementById('st-sound');
  if (themeToggle) themeToggle.checked = darkTheme;
  if (soundToggle) soundToggle.checked = soundEnabled;
  // Yazma hızı
  const typingSlider = document.getElementById('st-typing-slider');
  const typingVal    = document.getElementById('st-typing-val');
  if (typingSlider) typingSlider.value = typingSpeed;
  if (typingVal)    typingVal.textContent = TYPING_SPEED_LABELS[typingSpeed - 1];
  // Güvenlik
  const settleToggle = document.getElementById('st-settle');
  const addcdToggle  = document.getElementById('st-addcd');
  if (settleToggle) settleToggle.checked = securitySettings.settleCooldown;
  if (addcdToggle)  addcdToggle.checked  = securitySettings.addCooldown;
  // Anti-ban
  const warmInp = document.getElementById('st-warm-interval');
  if (warmInp) warmInp.value = warmInterval;
  // OLED tema
  const oledToggle = document.getElementById('st-oled');
  if (oledToggle) oledToggle.checked = oledTheme;
  // Masaüstü bildirim
  const notifToggle = document.getElementById('st-desktop-notif');
  if (notifToggle) notifToggle.checked = desktopNotifEnabled;

  document.getElementById('settings-modal-overlay').classList.add('show');
}
function closeSettingsModal() {
  document.getElementById('settings-modal-overlay').classList.remove('show');
}
function saveGlobalNumbers() {
  localStorage.setItem('wa_bm_numbers_global', globalCampaignNumbers);
}
function saveSentNumbers() {
  localStorage.setItem('wa_bm_sent_global', JSON.stringify([...sentNumbersGlobal]));
}
function saveGlobal() {
  localStorage.setItem('wa_bm_templates', JSON.stringify(globalTemplates));
  localStorage.setItem('wa_bm_campaign',  JSON.stringify(globalCampaign));
}

// ══════════════════════════════════════════════════════════════════════════
//  TEMA & SES
// ══════════════════════════════════════════════════════════════════════════
function applyTheme() {
  document.body.classList.toggle('light', !darkTheme);
  themeBtn.textContent = darkTheme ? '🌙' : '☀️';
  localStorage.setItem('wa_bm_dark', darkTheme ? '1' : '0');
}
function applySound() {
  soundBtn.textContent = soundEnabled ? '🔔' : '🔕';
  localStorage.setItem('wa_bm_sound', soundEnabled ? '1' : '0');
}
function playNotificationSound() {
  try {
    const ctx = new AudioContext(), t = ctx.currentTime;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    o1.type = 'sine'; o1.frequency.setValueAtTime(880, t); o1.frequency.setValueAtTime(1100, t+.1);
    o2.type = 'sine'; o2.frequency.setValueAtTime(660, t); o2.frequency.setValueAtTime(880,  t+.1);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t+.02); g.gain.exponentialRampToValueAtTime(0.001, t+.5);
    [o1,o2].forEach(o => { o.connect(g); o.start(t); o.stop(t+.5); });
    g.connect(ctx.destination);
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════
//  WEBVIEW
// ══════════════════════════════════════════════════════════════════════════
const WA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getOrCreateWebview(account) {
  let wv = document.getElementById(`wv_${account.id}`);
  if (!wv) {
    wv = document.createElement('webview');
    wv.id  = `wv_${account.id}`;
    // src'yi proxy uygulandıktan SONRA set et — race condition önleme
    wv.setAttribute('partition', `persist:${account.id}`);
    wv.setAttribute('useragent', WA_UA);
    wv.setAttribute('allowpopups', 'true');
    // Preload script: WhatsApp JS yüklenmeden ÖNCE fingerprint override'larını uygula
    // Paketlenmiş exe'de __dirname asar içine işaret eder; dosya extraResources'ta olur
    // NOT: Windows'ta file:// + C:/path yanlış — pathToFileURL üç eğik çizgi üretir (file:///C:/...)
    try {
      const path = require('path');
      const { pathToFileURL } = require('url');
      const isAsar = __dirname.includes('app.asar');
      const preloadDir = isAsar ? process.resourcesPath : __dirname;
      const preloadPath = path.join(preloadDir, 'wa-preload.js');
      wv.setAttribute('preload', pathToFileURL(preloadPath).toString());
    } catch(e) { console.error('[Sendigo] preload yolu hatası:', e); }
    wv.addEventListener('page-title-updated', e => {
      const m = e.title.match(/^\((\d+)\)/);
      updateBadge(account.id, m ? parseInt(m[1]) : 0);
    });
    // Webview'dan açılan popup pencerelerini yakala (profil fotoğrafı, medya vs.)
    wv.addEventListener('new-window', (e) => {
      e.preventDefault();
      if (!e.url || e.url === 'about:blank') return;
      // İzin verilen WhatsApp alan adlarını yeni pencerede aç
      ipcRenderer.invoke('open-popup', { url: e.url }).catch(() => {});
    });

    // ── Oturum açık/kapalı tespiti — QR kodu görünüyorsa çıkış yapılmış ────
    async function checkLoginStatus() {
      try {
        const qrVisible = await safeExecJS(wv, `
          (function() {
            // QR ekranı göstergesi: QR canvas/element VAR ve uygulama arayüzü YOK
            var hasQr = !!(
              document.querySelector('[data-testid="qrcode"]') ||
              document.querySelector('canvas[aria-label]')     ||
              document.querySelector('canvas[role="img"]')     ||
              document.querySelector('[data-ref]')
            );
            var hasApp = !!(
              document.querySelector('[data-testid="chat-list"]') ||
              document.querySelector('#pane-side')               ||
              document.querySelector('[data-testid="default-user"]')
            );
            return hasQr && !hasApp;
          })()
        `, 6000);

        const wasLoggedOut = loggedOutAccounts.has(account.id);

        if (qrVisible) {
          if (!wasLoggedOut) {
            loggedOutAccounts.add(account.id);
            saveLoggedOut();
            // Oturum verilerini sıfırla — yeni giriş yapılacak
            delete sessionStarted[account.id];
            saveSessionStarted();
            setAccountStatus(account.id, '🔴 Çıkış yapıldı!');
            renderAccountsDebounced();
            showToast(`⚠️ ${account.name} oturumu kapandı — QR taratın`, 4000);
            sendSystemNotification('🔴 Oturum Kapandı', `${account.name} WhatsApp oturumu kapandı — QR kodu taratın.`);
          }
        } else if (wasLoggedOut && qrVisible === false) {
          // Giriş yapıldı — temizle
          loggedOutAccounts.delete(account.id);
          saveLoggedOut();
          setAccountStatus(account.id, '● Aktif');
          renderAccountsDebounced();
        }
      } catch {}
    }

    // Her 20 saniyede bir oturum kontrolü
    let _loginCheckTimer = null;
    function startLoginCheck() {
      if (_loginCheckTimer) clearInterval(_loginCheckTimer);
      _loginCheckTimer = setInterval(checkLoginStatus, 20000);
    }

    wv.addEventListener('did-finish-load', () => {
      if (!sessionStarted[account.id]) {
        sessionStarted[account.id] = Date.now();
        saveSessionStarted(); // restart'ta kaybolmasın
      }
      // Sayfa yüklendi — 3 sn sonra oturum durumunu kontrol et
      setTimeout(checkLoginStatus, 3000);
      startLoginCheck();

      // ── Cihaz parmak izi tutarlılığı: bu hesaba ait sabit ekran boyutları ──
      const fp = getDeviceFingerprint(account.id);
      wv.executeJavaScript(`
        try {
          Object.defineProperty(screen, 'width',       { get: () => ${fp.screenW} });
          Object.defineProperty(screen, 'height',      { get: () => ${fp.screenH} });
          Object.defineProperty(screen, 'availWidth',  { get: () => ${fp.screenW} });
          Object.defineProperty(screen, 'availHeight', { get: () => ${fp.screenH - 40} });
          Object.defineProperty(window, 'innerWidth',  { get: () => ${Math.floor(fp.screenW * 0.85)} });
          Object.defineProperty(window, 'innerHeight', { get: () => ${Math.floor(fp.screenH * 0.85)} });
          Object.defineProperty(window, 'outerWidth',  { get: () => ${fp.screenW} });
          Object.defineProperty(window, 'outerHeight', { get: () => ${fp.screenH} });
        } catch(e) {}
        void 0;
      `).catch(() => {});
    });

    // ── Sayfa yükleme hatası → 15 sn sonra yeniden dene ─────────────────
    wv.addEventListener('did-fail-load', (e) => {
      // -3 = ağ iptal (sekme değişimi gibi), görmezden gel
      if (e.errorCode === -3) return;
      // Sadece WhatsApp ana sayfası başarısız olursa yeniden dene
      if (!wv.src || !wv.src.includes('whatsapp.com')) return;
      console.warn(`[${account.name}] Sayfa yükleme hatası: ${e.errorCode} — 15 sn sonra yeniden deneniyor`);
      setTimeout(() => {
        try {
          if (document.getElementById(`wv_${account.id}`)) {
            wv.src = 'https://web.whatsapp.com';
          }
        } catch(err) {}
      }, 15000);
    });

    // ── Webview process çökmesi → yeniden yükle ──────────────────────────
    wv.addEventListener('crashed', () => {
      console.error(`[${account.name}] Webview çöktü — yeniden yükleniyor`);
      showToast(`⚠️ ${account.name} yeniden başlatılıyor…`, 3000);
      stopPresencePattern(account.id);
      setTimeout(() => {
        try {
          if (document.getElementById(`wv_${account.id}`)) {
            wv.src = 'https://web.whatsapp.com';
            setTimeout(() => startPresencePattern(wv, account.id), 20000);
          }
        } catch(err) {}
      }, 3000);
    });

    // ── Render process tamamen gitti (Electron 28+ olayı) ────────────────
    wv.addEventListener('render-process-gone', (e) => {
      if (e.details?.reason === 'clean-exit') return;
      console.error(`[${account.name}] Render process sonlandı:`, e.details?.reason);
      showToast(`⚠️ ${account.name} yeniden başlatılıyor…`, 3000);
      stopPresencePattern(account.id);
      setTimeout(() => {
        try {
          if (document.getElementById(`wv_${account.id}`)) {
            wv.src = 'https://web.whatsapp.com';
            setTimeout(() => startPresencePattern(wv, account.id), 20000);
          }
        } catch(err) {}
      }, 3000);
    });

    mainContent.appendChild(wv);

    // Proxy uygula, ardından URL yükle — proxy set edilmeden önce sayfa yüklenmesin
    applyAccountProxy(account.id).then(() => {
      if (!wv.src || wv.src === 'about:blank') wv.src = 'https://web.whatsapp.com';
    }).catch(() => {
      wv.src = 'https://web.whatsapp.com';
    });
  }
  return wv;
}
function updateBadge(accountId, count) {
  const badge = document.querySelector(`[data-id="${accountId}"] .unread-badge`);
  if (!badge) return;
  const prev = prevCounts[accountId] || 0;
  if (soundEnabled && count > prev && accountId !== activeAccountId) playNotificationSound();
  prevCounts[accountId] = count;
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

// ══════════════════════════════════════════════════════════════════════════
//  HESAP LİSTESİ
// ══════════════════════════════════════════════════════════════════════════
function renderAccounts() {
  // ── Arama filtresi
  const searchVal = (document.getElementById('acct-search')?.value || '').toLowerCase();
  accountsList.innerHTML = '';

  // ── Tag filtresi + arama filtresi uygula
  const visibleAccounts = accounts.filter(account => {
    if (activeTagFilter && !(account.tags || []).includes(activeTagFilter)) return false;
    if (searchVal && !account.name.toLowerCase().includes(searchVal) && !account.phone?.toLowerCase().includes(searchVal)) return false;
    return true;
  });

  visibleAccounts.forEach(account => {
    const isActive = account.id === activeAccountId;
    const item = document.createElement('div');
    item.className = 'account-item' + (isActive ? ' active' : '');
    item.setAttribute('data-id', account.id);
    item.setAttribute('draggable', 'true');
    const pLabel   = proxyLabel(account);
    const hasProxy = !!(account.proxies && account.proxies.length);
    const health   = getAccountHealth(account);
    const sent     = getDailySent(account.id);
    const limit    = account.dailyLimit || 20;
    const healthTip = `${getHealthLabel(health)} — bugün: ${sent}/${limit}`;
    // Gerçek zamanlı durum: öncelik sırası — çıkış > kısıtlı > normal
    const isLoggedOut = loggedOutAccounts.has(account.id);
    const isRestricted = restrictedAccounts.has(account.id);
    const statusTxt = isLoggedOut
      ? '🔴 Çıkış yapıldı!'
      : isRestricted
        ? '🚨 Kısıtlı'
        : (accountStatusText[account.id] || (isActive ? '● Aktif' : 'Hazır'));
    // sentBadge kaldırıldı — kota bilgisi avatar içinde gösterilmeyecek
    // ── Alert dot (ban riski veya kısıtlı/çıkış)
    const atBanRisk = getNoWaRate(account.id) >= NO_WA_WARN_THRESHOLD;
    const showAlertDot = isLoggedOut || isRestricted || atBanRisk;
    const alertDotClass = (isLoggedOut || isRestricted) ? 'acct-alert-dot' : 'acct-alert-dot warn';
    const alertDotHtml = showAlertDot ? `<span class="${alertDotClass}" title="${isLoggedOut ? 'Oturum kapandı' : isRestricted ? 'Kısıtlı' : 'Ban riski'}"></span>` : '';
    const avatarBg = isLoggedOut
      ? 'linear-gradient(145deg,rgba(239,68,68,.35),rgba(153,27,27,.4))'
      : isActive
        ? `linear-gradient(145deg,rgba(255,255,255,.28),rgba(0,208,132,.22))`
        : getAvatarGradient(account.id);
    // ── Tag pills
    const tagPills = (account.tags || []).map(t =>
      `<span class="tag-pill ${getTagColor(t)}">${escHtml(t)}</span>`
    ).join('');

    const sentBadgeHtml = sent > 0
      ? `<span class="sent-badge" style="font-size:10px;padding:1px 5px;border-radius:10px;background:var(--accent-glow2);color:var(--accent);margin-left:4px;font-weight:700;">${sent}/${limit}</span>`
      : '';

    item.innerHTML = `
      <div style="position:relative;flex-shrink:0;margin-right:11px;">
        <div class="account-avatar${isLoggedOut ? ' logged-out-avatar' : ''}" style="background:${avatarBg}">
          <span>${escHtml(getInitials(account.name))}</span>
        </div>
        ${alertDotHtml}
      </div>
      <div class="account-info">
        <div class="account-name">${escHtml(account.name)}${sentBadgeHtml}</div>
        <div class="account-status">
          <span class="health-dot ${health}" title="${healthTip}"></span>
          <span class="account-status-text${isLoggedOut ? ' logged-out-text' : ''}">${statusTxt}</span>
          ${pLabel ? `<span class="proxy-badge" title="Proxy: ${escHtml(pLabel)}">🌐 ${escHtml(pLabel)}</span>` : ''}
        </div>
        ${tagPills ? `<div class="acct-tags">${tagPills}</div>` : ''}
        <div class="acct-progress-wrap">
          <div class="acct-progress-bar${isLoggedOut ? ' full' : sent >= limit * 0.9 ? ' full' : sent >= limit * 0.7 ? ' warn' : ''}" style="width:${isLoggedOut ? '100' : Math.min(100, sent > 0 ? Math.round(sent / limit * 100) : 0)}%"></div>
        </div>
      </div>
      <span class="unread-badge hidden">0</span>
      <div class="item-actions">
        <button class="icon-btn proxy-btn ${hasProxy ? 'has-proxy' : ''}" title="${hasProxy ? 'Proxy: ' + escHtml(pLabel) : 'Proxy ekle'}">🌐</button>
        <button class="icon-btn rename-btn" title="Yeniden Adlandır">✏️</button>
        <button class="icon-btn danger delete-btn" title="Sil">✕</button>
      </div>`;

    item.addEventListener('click', e => { if (e.target.closest('.item-actions')) return; switchToAccount(account.id); });
    item.querySelector('.proxy-btn') .addEventListener('click', e => { e.stopPropagation(); showProxyModal(account.id); });
    item.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); showRenameModal(account.id); });
    item.querySelector('.delete-btn').addEventListener('click', e => { e.stopPropagation(); confirmDeleteModal(account.id); });
    item.addEventListener('contextmenu', e => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, account.id); });

    item.addEventListener('dragstart', e => { dragSrcId = account.id; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => item.classList.add('dragging'), 0); });
    item.addEventListener('dragend',   () => { item.classList.remove('dragging'); document.querySelectorAll('.account-item').forEach(el => el.classList.remove('drag-over')); });
    item.addEventListener('dragover',  e => { e.preventDefault(); if (dragSrcId && dragSrcId !== account.id) { document.querySelectorAll('.account-item').forEach(el => el.classList.remove('drag-over')); item.classList.add('drag-over'); } });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault(); item.classList.remove('drag-over');
      if (!dragSrcId || dragSrcId === account.id) return;
      const si = accounts.findIndex(a => a.id === dragSrcId), di = accounts.findIndex(a => a.id === account.id);
      if (si !== -1 && di !== -1) { const [m] = accounts.splice(si, 1); accounts.splice(di, 0, m); saveAccounts(); renderAccounts(); }
      dragSrcId = null;
    });
    accountsList.appendChild(item);
  });
  // Her hesabın günlük gönderim rozetini render sonrası güncelle
  accounts.forEach(a => updateSentBadge(a.id));
  renderTagFilter();
  updateStatsStrip();
}

// Performans: renderAccounts'u debounce et — hızlı ardışık çağrılarda tek render
let _renderAccountsTimer = null;
function renderAccountsDebounced() {
  if (_renderAccountsTimer) clearTimeout(_renderAccountsTimer);
  _renderAccountsTimer = setTimeout(() => { _renderAccountsTimer = null; renderAccounts(); }, 60);
}

// ══════════════════════════════════════════════════════════════════════════
//  HESAP CRUD
// ══════════════════════════════════════════════════════════════════════════
function switchToAccount(id) {
  activeAccountId = id;
  document.querySelectorAll('webview').forEach(w => w.classList.remove('active'));
  const account = accounts.find(a => a.id === id);
  if (account) {
    // Çıkış yapılmış hesaba manuel tıklandı → yeniden bağlanmak istiyor
    if (loggedOutAccounts.has(id)) {
      loggedOutAccounts.delete(id);
      saveLoggedOut();
    }
    const wv = getOrCreateWebview(account);
    wv.classList.add('active');
    // Webview yüklendikten sonra presence pattern'i başlat
    startPresencePattern(wv, id);
  }
  welcomeScreen.classList.add('hidden');
  renderAccounts();
}
function addAccount(name, phone = '', dailyLimit = 20) {
  const a = { id: generateId(), name: name.trim(), phone: phone.trim(), dailyLimit: Math.max(1, parseInt(dailyLimit) || 20), proxies: [], proxyIdx: 0, proxyRotate: true, createdAt: Date.now() };
  accounts.push(a); saveAccounts(); renderAccounts(); switchToAccount(a.id);
  // ── Bir sonraki hesap için rastgele cooldown belirle (4–7 dk) ────────────
  // Yalnızca cooldown aktifken kaydet — kapalıyken stale timestamp bırakma
  let cdMs;
  if (securitySettings.addCooldown) {
    cdMs = ADD_CD_MIN_MS + Math.floor(Math.random() * (ADD_CD_MAX_MS - ADD_CD_MIN_MS + 1));
    localStorage.setItem('wa_last_add_time', Date.now().toString());
    localStorage.setItem('wa_last_add_cd',   cdMs.toString());
  } else {
    cdMs = ADD_CD_MIN_MS; // toast için fallback
  }
  // İlk hesap eklendiyse cooldown uyarısı gösterme (sadece 2. ve sonrası için)
  if (accounts.length > 1 && securitySettings.addCooldown) {
    showToast(`✅ "${a.name}" eklendi — Sonraki hesap için ${fmtMs(cdMs)} bekleyin`);
  } else {
    showToast(`✅ "${a.name}" eklendi`);
  }
}
// ── Silme onayı ─────────────────────────────────────────────────────────────
let pendingDeleteId = null;

function confirmDeleteModal(id) {
  hideContextMenu();
  const a = accounts.find(x => x.id === id); if (!a) return;
  pendingDeleteId = id;
  document.getElementById('confirm-delete-name').textContent = a.name;
  document.getElementById('confirm-delete-overlay').classList.add('show');
}
function closeConfirmDelete() {
  document.getElementById('confirm-delete-overlay').classList.remove('show');
  pendingDeleteId = null;
}

function deleteAccount(id) {
  const a = accounts.find(x => x.id === id);
  campaignRunning[id] = false;
  restrictedAccounts.delete(id);
  loggedOutAccounts.delete(id); saveLoggedOut();
  stopPresencePattern(id);
  const wv = document.getElementById(`wv_${id}`); if (wv) wv.remove();
  delete prevCounts[id];
  delete sessionStarted[id]; saveSessionStarted(); // yerleşme zamanını temizle
  accounts = accounts.filter(x => x.id !== id); saveAccounts();
  if (panelAccountId === id) closeCampaignPanel();
  if (activeAccountId === id) { accounts.length ? switchToAccount(accounts[0].id) : (() => { activeAccountId = null; welcomeScreen.classList.remove('hidden'); })(); }
  renderAccounts();
  if (a) showToast(`🗑️ "${a.name}" silindi`);
}
function renameAccount(id, name, phone = '', dailyLimit = 20) {
  const a = accounts.find(x => x.id === id); if (!a) return;
  const old = a.name;
  a.name       = name.trim();
  a.phone      = phone.trim();
  a.dailyLimit = Math.max(1, parseInt(dailyLimit) || 20);
  saveAccounts(); renderAccounts();
  if (panelAccountId === id) cpAccountName.textContent = a.name;
  showToast(`✏️ "${old}" → "${a.name}" · limit: ${a.dailyLimit}/gün`);
}

// ══════════════════════════════════════════════════════════════════════════
//  KAMPANYA PANELİ
// ══════════════════════════════════════════════════════════════════════════
function openCampaignPanel(preSelectAccountId) {
  panelAccountId = null; // artık per-account değil
  cpAccountName.textContent = 'Global — tüm hesaplara dağıtılır';

  document.querySelectorAll('.cp-tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.cp-tab-content').forEach(c => c.classList.add('hidden'));
  document.querySelector('.cp-tab-btn[data-tab="templates"]').classList.add('active');
  document.getElementById('cp-tab-templates').classList.remove('hidden');

  renderTemplatesPanel();
  renderCampaignAccountSelect(preSelectAccountId);
  // AI selam durumunu göster
  const greetAiStatus = document.getElementById('cp-greet-ai-status');
  if (greetAiStatus) {
    const prov    = localStorage.getItem(AI_PROVIDER_KEY) || 'anthropic';
    const keyId   = prov === 'anthropic' ? AI_KEY_ANTHROPIC : AI_KEY_OPENAI;
    const hasKey  = !!(localStorage.getItem(keyId) || '').trim();
    const provLbl = prov === 'anthropic' ? 'Anthropic' : 'OpenAI';
    greetAiStatus.innerHTML = hasKey
      ? `🤖 <span style="color:var(--accent);">AI aktif (${provLbl})</span> — kampanya başladığında selamlar otomatik üretilir`
      : `⚠️ AI key yok — <a href="#" id="cp-greet-ai-link" style="color:var(--accent);text-decoration:none;">🤖 Ayarla</a> veya statik havuz kullanılır`;
    document.getElementById('cp-greet-ai-link')?.addEventListener('click', e => {
      e.preventDefault();
      closeCampaignPanel();
      openAiGenModal();
    });
  }
  campaignPanel.classList.add('open');
}
function closeCampaignPanel() { campaignPanel.classList.remove('open'); }

// ── Kampanya Raporu ───────────────────────────────────────────────────────
function showCampaignReport() {
  const entries = Object.values(campaignStats);
  if (!entries.length) { showToast('ℹ️ Henüz kampanya çalışmadı'); return; }

  const totalSent    = entries.reduce((s, e) => s + e.sent,       0);
  const totalNoWa    = entries.reduce((s, e) => s + e.noWa,       0);
  const totalHistory = entries.reduce((s, e) => s + e.hasHistory, 0);
  const totalFailed  = entries.reduce((s, e) => s + e.failed,     0);
  const totalSkipped = totalNoWa + totalHistory;

  const reasonLabel = { done:'✅ Tamamlandı', stop:'⏹ Durduruldu', limit:'🛑 Günlük Limit', ban:'🚨 Kısıtlandı', fail:'❌ Hata Serisi', running:'▶️ Devam Ediyor' };
  const reasonClass = { done:'done', stop:'stop', limit:'limit', ban:'ban', fail:'fail', running:'done' };

  function fmtDur(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} sn`;
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return `${m} dk ${r} sn`;
    return `${Math.floor(m/60)} sa ${m%60} dk`;
  }

  const acctRows = entries.map(e => {
    const dur = (e.endTime && e.startTime) ? e.endTime - e.startTime : null;
    return `
    <div class="report-acct">
      <div class="report-acct-header">
        <span class="report-acct-name">${escHtml(e.name)}</span>
        <span class="report-acct-reason ${reasonClass[e.stopReason] || 'done'}">${reasonLabel[e.stopReason] || e.stopReason}</span>
      </div>
      <div class="report-acct-bars">
        <div class="report-mini-stat"><div class="report-mini-val" style="color:#00d084">${e.sent}</div><div class="report-mini-lbl">Gönderildi</div></div>
        <div class="report-mini-stat"><div class="report-mini-val" style="color:#f59e0b">${e.noWa}</div><div class="report-mini-lbl">WA Yok</div></div>
        <div class="report-mini-stat"><div class="report-mini-val" style="color:#818cf8">${e.hasHistory}</div><div class="report-mini-lbl">Mevcut Sohbet</div></div>
        <div class="report-mini-stat"><div class="report-mini-val" style="color:#ef4444">${e.failed}</div><div class="report-mini-lbl">Başarısız</div></div>
      </div>
      ${dur ? `<div class="report-duration">⏱ Süre: ${fmtDur(dur)}</div>` : ''}
    </div>`;
  }).join('');

  const lastEnd  = Math.max(...entries.map(e => e.endTime || 0).filter(t => t > 0));
  const totalDur = (campaignStartTime && lastEnd > 0) ? lastEnd - campaignStartTime : null;

  document.getElementById('campaign-report-body').innerHTML = `
    <div class="report-summary">
      <div class="report-stat"><div class="report-stat-val" style="color:#00d084">${totalSent}</div><div class="report-stat-lbl">Toplam Gönderildi</div></div>
      <div class="report-stat"><div class="report-stat-val" style="color:#f59e0b">${totalSkipped}</div><div class="report-stat-lbl">Atlanan</div></div>
      <div class="report-stat"><div class="report-stat-val" style="color:#ef4444">${totalFailed}</div><div class="report-stat-lbl">Başarısız</div></div>
    </div>
    ${totalDur ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">⏱ Toplam süre: ${fmtDur(totalDur)} &nbsp;·&nbsp; ${entries.length} hesap</div>` : ''}
    <div class="report-acct-list">${acctRows}</div>`;

  document.getElementById('campaign-report-overlay').classList.add('show');
}
function closeCampaignReport() {
  document.getElementById('campaign-report-overlay').classList.remove('show');
}

function renderCampaignAccountSelect(preSelectId) {
  const container = document.getElementById('cp-account-select');
  if (!container) return;
  container.innerHTML = '';
  if (!accounts.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">Henüz hesap yok.</div>';
    return;
  }
  accounts.filter(a => !loggedOutAccounts.has(a.id)).forEach(a => {
    const label = document.createElement('label');
    label.className = 'tmpl-check-item';
    label.style.cursor = 'pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = a.id;
    cb.style.accentColor = 'var(--accent)';
    cb.style.width = '15px'; cb.style.height = '15px'; cb.style.flexShrink = '0'; cb.style.marginTop = '3px';
    // Running hesapları işaretle, yoksa hepsini seçili getir
    cb.checked = globalCampaignRunning ? !!campaignRunning[a.id] : (preSelectId ? a.id === preSelectId : true);
    if (globalCampaignRunning) cb.disabled = true;
    cb.addEventListener('change', () => label.classList.toggle('selected', cb.checked));
    if (cb.checked) label.classList.add('selected');
    const info = document.createElement('div');
    info.innerHTML = `<div class="tmpl-check-name">${escHtml(a.name)}</div>
      <div class="tmpl-check-preview">${a.phone ? '📞 ' + escHtml(a.phone) : '📵 Numara girilmemiş'}${
        campaignRunning[a.id] ? ' <span style="color:var(--accent)">● Çalışıyor</span>' : ''}</div>`;
    label.appendChild(cb); label.appendChild(info);
    container.appendChild(label);
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  HAZIR METİNLER (GLOBAL)
// ══════════════════════════════════════════════════════════════════════════
let tmplCategoryFilter = ''; // aktif kategori filtresi

function renderTemplatesPanel() {
  // Kampanya sekmesi checklist
  renderTmplChecklist();

  // Kategori filtre dropdown'ını güncelle
  const filterSel = document.getElementById('tmpl-cat-filter');
  if (filterSel) {
    const cats = [...new Set(globalTemplates.map(t => t.category).filter(Boolean))].sort();
    const prev = filterSel.value;
    filterSel.innerHTML = '<option value="">— Tümü —</option>' +
      cats.map(c => `<option value="${escHtml(c)}" ${c === prev ? 'selected' : ''}>${escHtml(c)}</option>`).join('');
    tmplCategoryFilter = filterSel.value; // sync after rebuild
  }

  // Hazır Metinler sekmesi listesi
  if (!globalTemplates.length) {
    cpTemplatesList.innerHTML = '<div id="cp-no-templates">Henüz hazır metin yok.</div>'; return;
  }
  const visible = tmplCategoryFilter
    ? globalTemplates.filter(t => (t.category || '') === tmplCategoryFilter)
    : globalTemplates;

  if (!visible.length) {
    cpTemplatesList.innerHTML = '<div id="cp-no-templates">Bu kategoride metin yok.</div>'; return;
  }
  cpTemplatesList.innerHTML = '';
  visible.forEach(t => {
    const div = document.createElement('div'); div.className = 'tmpl-item';
    const catBadge = t.category
      ? `<span class="tmpl-cat-badge">${escHtml(t.category)}</span>`
      : '';
    div.innerHTML = `
      <div class="tmpl-item-info">
        <div class="tmpl-item-name">${escHtml(t.name)} ${catBadge}</div>
        <div class="tmpl-item-preview">${escHtml(t.text.slice(0, 80))}${t.text.length > 80 ? '…' : ''}</div>
      </div>
      <div class="tmpl-item-actions">
        <button class="tmpl-btn edit-tmpl"   title="Düzenle">✏️</button>
        <button class="tmpl-btn danger delete-tmpl" title="Sil">🗑️</button>
      </div>`;
    div.querySelector('.edit-tmpl')  .addEventListener('click', () => showTmplModal(t.id));
    div.querySelector('.delete-tmpl').addEventListener('click', () => deleteTmpl(t.id));
    cpTemplatesList.appendChild(div);
  });
}

function renderTmplChecklist() {
  const container = document.getElementById('cp-tmpl-checklist'); if (!container) return;
  container.innerHTML = '';
  if (!globalTemplates.length) {
    container.innerHTML = '<div class="cp-no-tmpl-msg">Önce "Hazır Metinler" sekmesinden metin ekleyin.</div>'; return;
  }
  globalTemplates.forEach(t => {
    const isChecked = globalCampaign.templateIds.includes(t.id);
    const label = document.createElement('label');
    label.className = 'tmpl-check-item' + (isChecked ? ' selected' : '');
    label.innerHTML = `
      <input type="checkbox" value="${t.id}" ${isChecked ? 'checked' : ''}>
      <div>
        <div class="tmpl-check-name">${escHtml(t.name)}</div>
        <div class="tmpl-check-preview">${escHtml(t.text.slice(0, 70))}${t.text.length > 70 ? '…' : ''}</div>
      </div>`;
    label.querySelector('input').addEventListener('change', e => label.classList.toggle('selected', e.target.checked));
    container.appendChild(label);
  });
}

function showTmplModal(tmplId = null) {
  editingTmplId = tmplId;
  if (tmplId) {
    const t = globalTemplates.find(x => x.id === tmplId); if (!t) return;
    tmplModalTitle.textContent = 'Hazır Metni Düzenle';
    tmplNameInput.value = t.name;
    tmplCatInput.value  = t.category || '';
    tmplTextInput.value = t.text;
  } else {
    tmplModalTitle.textContent = 'Yeni Hazır Metin';
    tmplNameInput.value = ''; tmplCatInput.value = ''; tmplTextInput.value = '';
  }
  // Mevcut kategorileri datalist'e doldur
  const dl = document.getElementById('tmpl-cat-datalist');
  if (dl) {
    const cats = [...new Set(globalTemplates.map(t => t.category).filter(Boolean))].sort();
    dl.innerHTML = cats.map(c => `<option value="${escHtml(c)}">`).join('');
  }
  tmplModalOverlay.classList.add('show');
  setTimeout(() => tmplNameInput.focus(), 50);
}
function closeTmplModal() { tmplModalOverlay.classList.remove('show'); editingTmplId = null; }
// ── Spam tetikleyici kelimeler ────────────────────────────────────────────
const SPAM_WORDS_TR = [
  'kazandın','kazandınız','kazan','bedava','ücretsiz','parasız',
  'tıkla','hemen tıkla','şimdi tıkla','buraya tıkla',
  'hemen','acele','son gün','son şans','son fırsat','son dakika',
  'ödül','hediye','çekiliş','kura','büyük fırsat',
  'kampanya','promosyon','özel teklif','sınırlı teklif',
  'kredi','nakit','para kazan','gelir','ikramiye','para ödül',
  'yatırım','kripto','bitcoin','borsa','kazanç',
  'doğrula','onay kodu','hesabınız','bilgileriniz','şifreniz',
  'tıkla ve kazan','hemen üye ol','kayıt ol ve kazan',
];
const SPAM_WORDS_EN = [
  'click here','click now','click link','click to',
  'free','win','winner','won','prize','gift','reward',
  'limited offer','urgent','act now','hurry','last chance',
  'credit','cash','earn money','income','bonus',
  'congratulations','you have been selected','you have won',
  'crypto','bitcoin','investment','verify your','account suspended',
  'confirm your','password reset','log in now',
];

// ── Kapsamlı spam & risk içerik denetleyici ──────────────────────────────
function checkSpamContent(text) {
  const warnBox = document.getElementById('tmpl-warn-box');
  if (!warnBox) return;
  const warnings = [];   // { level: 'red'|'yellow', msg: string }
  const tl = text.toLowerCase();

  // 1. URL tespiti
  if (/https?:\/\/|bit\.ly|wa\.me|tinyurl/i.test(text)) {
    warnings.push({ level: 'red', msg: '🔴 URL tespit edildi — yeni kişilere URL içeren ilk mesaj yüksek ban riski taşır.' });
  }

  // 2. Spin syntax yoksa
  if (!/\{[^}]+\|[^}]+\}/.test(text)) {
    warnings.push({ level: 'yellow', msg: '🟡 Spin syntax yok — tüm alıcılara aynı metin gider. {seçenek1|seçenek2} eklemen ban riskini ciddi ölçüde düşürür.' });
  }

  // 3. ALL CAPS oranı
  const letters = text.replace(/[^a-zA-ZğĞüÜşŞıİöÖçÇ]/g, '');
  if (letters.length > 8) {
    const upperCount = (text.match(/[A-ZĞÜŞİÖÇ]/g) || []).length;
    const ratio = upperCount / letters.length;
    if (ratio > 0.60) {
      warnings.push({ level: 'red',    msg: `🔴 Büyük harf oranı çok yüksek (%${Math.round(ratio * 100)}) — spam sistemleri bu tür metinleri anında flagler.` });
    } else if (ratio > 0.35) {
      warnings.push({ level: 'yellow', msg: `🟡 Büyük harf oranı yüksek (%${Math.round(ratio * 100)}) — bazı kelimeleri küçük yazarsan daha doğal görünür.` });
    }
  }

  // 4. Emoji sayısı
  const emojiMatches = [...(text.matchAll(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu))];
  if (emojiMatches.length > 10) {
    warnings.push({ level: 'red',    msg: `🔴 Çok fazla emoji (${emojiMatches.length} adet) — spam mesajların en belirgin özelliği. 3-4 ile sınırlı tut.` });
  } else if (emojiMatches.length > 5) {
    warnings.push({ level: 'yellow', msg: `🟡 Fazla emoji (${emojiMatches.length} adet) — 5'ten fazlası spam skorunu artırır.` });
  }

  // 5. Tekrarlayan noktalama (!!!, ???, ...)
  if (/[!?]{3,}/.test(text)) {
    warnings.push({ level: 'yellow', msg: '🟡 Tekrarlayan noktalama (!!!,???) tespit edildi — spam imzası. En fazla 1-2 kullan.' });
  }

  // 6. Türkçe spam tetikleyicileri
  const foundTR = SPAM_WORDS_TR.filter(w => tl.includes(w));
  if (foundTR.length >= 2) {
    warnings.push({ level: 'red',    msg: `🔴 Spam tetikleyici kelimeler: "${foundTR.slice(0, 4).join('", "')}"${foundTR.length > 4 ? '…' : ''} — bu kelimeleri değiştir veya spin syntax içine göm.` });
  } else if (foundTR.length === 1) {
    warnings.push({ level: 'yellow', msg: `🟡 Riskli kelime: "${foundTR[0]}" — spam filtrelerini tetikleyebilir.` });
  }

  // 7. İngilizce spam tetikleyicileri
  const foundEN = SPAM_WORDS_EN.filter(w => tl.includes(w));
  if (foundEN.length > 0) {
    warnings.push({ level: 'red',    msg: `🔴 İngilizce spam kelimeleri: "${foundEN.slice(0, 3).join('", "')}" — yüksek risk.` });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  if (!warnings.length) { warnBox.style.display = 'none'; return; }
  const hasRed = warnings.some(w => w.level === 'red');
  warnBox.style.display    = 'block';
  warnBox.style.background = hasRed ? 'rgba(239,68,68,0.12)'    : 'rgba(251,191,36,0.12)';
  warnBox.style.color      = hasRed ? '#ef4444' : '#fbbf24';
  warnBox.innerHTML        = warnings.map(w => w.msg).join('<br>');
}

function confirmTmplModal() {
  const name     = tmplNameInput.value.trim();
  const category = tmplCatInput.value.trim();
  const text     = tmplTextInput.value.trim();
  if (!name || !text) { showToast('⚠️ Ad ve metin zorunlu'); return; }
  if (editingTmplId) {
    const t = globalTemplates.find(x => x.id === editingTmplId);
    if (t) { t.name = name; t.category = category; t.text = text; }
  } else {
    globalTemplates.push({ id: generateId(), name, category, text });
  }
  saveGlobal(); renderTemplatesPanel(); closeTmplModal();
  showToast(editingTmplId ? '✅ Metin güncellendi' : '✅ Metin eklendi');
}
function deleteTmpl(tmplId) {
  globalTemplates = globalTemplates.filter(t => t.id !== tmplId);
  globalCampaign.templateIds = globalCampaign.templateIds.filter(id => id !== tmplId);
  saveGlobal(); renderTemplatesPanel();
  showToast('🗑️ Metin silindi');
}

// ══════════════════════════════════════════════════════════════════════════
//  KAMPANYA AYARLARI
// ══════════════════════════════════════════════════════════════════════════
function saveCampaignSettings() {
  const checked = document.querySelectorAll('#cp-tmpl-checklist input[type="checkbox"]:checked');
  globalCampaign.templateIds = Array.from(checked).map(cb => cb.value);
  // Global numara havuzu — tüm hesaplar paylaşır
  globalCampaignNumbers = cpNumbers.value;
  saveGlobalNumbers();
  globalCampaign.minInterval   = parseInt(cpMinInt.value)    || 5;
  globalCampaign.maxInterval   = parseInt(cpMaxInt.value)    || 10;
  globalCampaign.breakAfter    = parseInt(cpBreakAfter?.value)  || 10;
  globalCampaign.breakDuration = parseInt(cpBreakDur?.value)    || 15;
  globalCampaign.hoursEnabled  = cpHoursEnabled?.checked || false;
  globalCampaign.hourFrom      = cpHourFrom?.value || '09:00';
  globalCampaign.hourTo        = cpHourTo?.value   || '21:00';
  // Önce Selam modu
  const greetEl = document.getElementById('cp-greet-mode');
  const greetToEl = document.getElementById('cp-greet-timeout');
  globalCampaign.greetMode       = greetEl?.checked || false;
  globalCampaign.greetTimeoutMin = parseInt(greetToEl?.value) || 5;
  saveGlobal();
}

function loadCampaignSettings() {
  renderTmplChecklist();
  // Global numara havuzunu yükle
  cpNumbers.value = globalCampaignNumbers || '';
  cpMinInt.value  = globalCampaign.minInterval   || 8;
  cpMaxInt.value  = globalCampaign.maxInterval   || 20;
  if (cpBreakAfter)  cpBreakAfter.value       = globalCampaign.breakAfter    || 5;
  if (cpBreakDur)    cpBreakDur.value         = globalCampaign.breakDuration || 20;
  if (cpHoursEnabled) cpHoursEnabled.checked  = globalCampaign.hoursEnabled  || false;
  if (cpHourFrom)    cpHourFrom.value          = globalCampaign.hourFrom      || '09:00';
  if (cpHourTo)      cpHourTo.value            = globalCampaign.hourTo        || '21:00';
  if (cpHoursRow)    cpHoursRow.style.display  = globalCampaign.hoursEnabled ? 'flex' : 'none';
  // Önce Selam modu
  const greetEl = document.getElementById('cp-greet-mode');
  const greetToEl = document.getElementById('cp-greet-timeout');
  const greetRow = document.getElementById('cp-greet-timeout-row');
  if (greetEl) greetEl.checked = globalCampaign.greetMode || false;
  if (greetToEl) greetToEl.value = globalCampaign.greetTimeoutMin || 5;
  if (greetRow) greetRow.style.display = globalCampaign.greetMode ? 'flex' : 'none';

  cpProgressFill.style.width = '0%';
  cpProgressText.textContent = 'Hazır';
  updateCampaignControls();
}

function updateCampaignControls() {
  const isRun    = globalCampaignRunning;
  const isPaused = globalCampaignPaused;
  const pauseBtn = document.getElementById('cp-pause-btn');

  cpStartBtn.disabled = isRun;
  cpStopBtn.disabled  = !isRun;
  if (pauseBtn) {
    pauseBtn.disabled   = !isRun;
    pauseBtn.textContent = isPaused ? '▶ Devam' : '⏸ Duraklat';
    pauseBtn.className   = isPaused
      ? 'cp-btn cp-btn-primary'
      : 'cp-btn cp-btn-secondary';
  }
  // Duraklat modunda ayarlar düzenlenebilir
  const locked = isRun && !isPaused;
  cpNumbers.disabled  = locked;
  cpMinInt.disabled   = locked;
  cpMaxInt.disabled   = locked;
  if (cpBreakAfter) cpBreakAfter.disabled = locked;
  if (cpBreakDur)   cpBreakDur.disabled   = locked;
  document.querySelectorAll('#cp-tmpl-checklist input').forEach(cb => cb.disabled = locked);
  if (cpHoursEnabled) cpHoursEnabled.disabled = locked;
  if (cpHourFrom)     cpHourFrom.disabled     = locked;
  if (cpHourTo)       cpHourTo.disabled       = locked;
  const importBtn = document.getElementById('cp-import-btn');
  if (importBtn) importBtn.disabled = locked;
}

// Hesap başına son 4 şablonu takip ederek tekrar gönderimi önle.
// Önce hiç kullanılmamış (son 4'te olmayan) şablonları tercih et;
// tüm şablonlar son 4'teyse (az şablon durumu) en az kullanılanı seç.
function pickTemplate(accountId, templates) {
  if (!templates.length) return null;
  const recent = accountRecentTmplIds[accountId] || [];
  const fresh  = templates.filter(t => !recent.includes(t.id));
  const pool   = fresh.length > 0 ? fresh : templates;
  const tmpl   = pool[Math.floor(Math.random() * pool.length)];
  // Geçmişi güncelle — son 4'ü tut
  accountRecentTmplIds[accountId] = [...recent, tmpl.id].slice(-4);
  return tmpl;
}

// Paylaşılan kuyruktan bir sonraki numarayı al (daha önce gönderilmemişse)
// JS single-threaded olduğundan shift() güvenli — kilit gerekmez
function getNextFromQueue() {
  while (campaignQueue.length) {
    const num = campaignQueue.shift();
    if (!sentNumbersGlobal.has(num) && !isBlacklisted(num)) return num;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
//  KAMPANYA RUNNER
// ══════════════════════════════════════════════════════════════════════════
function logToPanel(msg, cls = '') {
  logToSidebar(msg, cls);
}

// Gönderilmiş numaraları numara listesinden temizle — textarea + localStorage güncellenir
function purgeSentFromNumbersList() {
  const lines = globalCampaignNumbers.split('\n');
  const kept  = lines.filter(line => {
    const num = line.replace(/\D/g, '').trim();
    // Geçersiz/kısa satırları koru (boş satır, yorum vb.) — sadece gönderilenleri çıkar
    return num.length < 10 || !sentNumbersGlobal.has(num);
  });
  const before = lines.filter(l => l.replace(/\D/g,'').trim().length >= 10).length;
  const after  = kept .filter(l => l.replace(/\D/g,'').trim().length >= 10).length;
  const removed = before - after;
  globalCampaignNumbers = kept.join('\n');
  // Textarea hemen güncelle (panel açıksa görünür)
  if (cpNumbers) cpNumbers.value = globalCampaignNumbers;
  saveGlobalNumbers();
  if (removed > 0) logToPanel(`🧹 ${removed} gönderilmiş numara listeden temizlendi.`, 'log-info');
}

// İnsan gibi rastgele gecikme (ms)
function humanDelay(min, max) { return sleep(randomInterval(min, max)); }

// ── Sidebar Canlı Aktivite Logu ────────────────────────���─────────────────────
function logToSidebar(msg, cls = '') {
  const entries = document.getElementById('slog-entries');
  if (!entries) return;

  // Placeholder'ı temizle
  const empty = entries.querySelector('.slog-empty');
  if (empty) empty.remove();

  // Yeni satır ekle
  const line = document.createElement('div');
  if (cls) line.className = cls;
  // [HH:MM:SS] öneki varsa saat:dakika:saniye olarak sakla
  const t = new Date().toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const cleanMsg = msg.replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, '');
  line.textContent = `${t} ${cleanMsg}`;
  line.title = line.textContent; // tam metni tooltip'te göster (ellipsis varsa)
  entries.appendChild(line);

  // Eski satırları kırp
  while (entries.children.length > SLOG_MAX) entries.removeChild(entries.firstChild);

  // Otomatik scroll — en alta (scroll container slog-body'dir)
  const slogBody = document.getElementById('slog-body');
  if (slogBody) setTimeout(() => { slogBody.scrollTop = slogBody.scrollHeight; }, 0);

  // Logu otomatik aç (ilk aktivitede)
  if (!slogOpen) {
    slogOpen = true;
    document.getElementById('slog-body')    ?.classList.add('open');
    document.getElementById('slog-chevron') ?.classList.add('open');
  }

  // Dot animasyonu: 2 sn yanıp söner, aktif işlem varsa kalır
  const dot = document.getElementById('slog-dot');
  if (dot) {
    dot.classList.add('active');
    clearTimeout(dot._t);
    dot._t = setTimeout(() => {
      if (!globalCampaignRunning && !warmingRunning) dot.classList.remove('active');
    }, 2000);
  }
}

// Bekleme süresini okunabilir göster
function formatWaitTime(ms) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (min === 0) return `${sec} sn`;
  if (sec === 0) return `${min} dk`;
  return `${min} dk ${sec} sn`;
}

// executeJavaScript'i ms sonra timeout'a düşür — yanıt vermeyen webview'leri çözer
// null döner → çağıran taraf bunu 'loading' / false gibi güvenli varsayılan olarak ele alır
function safeExecJS(wv, code, ms = 10000) {
  return Promise.race([
    wv.executeJavaScript(code),
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

async function openChatBySearch(wv, phone) {
  // Sayfa yenilenmeden SPA içinde sohbet aç — "Yeni sohbet" arama akışı
  // 1. Yeni sohbet butonuna tıkla (5 sn timeout)
  await safeExecJS(wv, `(async function(){
    const btn = document.querySelector('[data-testid="new-chat-btn"]')
             || document.querySelector('[data-icon="new-chat-outline"]')?.closest('button')
             || document.querySelector('button[aria-label="Yeni sohbet"]')
             || document.querySelector('button[aria-label="New chat"]');
    if (btn) { btn.click(); await new Promise(r=>setTimeout(r,700)); }
  })()`, 5000).catch(()=>{});

  await new Promise(r => setTimeout(r, 800));

  // 2. Arama kutusuna numara yaz (4 sn timeout)
  await safeExecJS(wv, `(function(){
    const inp = document.querySelector('[data-testid="search-input"]')
             || document.querySelector('input[title*="ara"]')
             || document.querySelector('input[title*="earch"]')
             || document.querySelector('input[placeholder*="ara"]')
             || document.querySelector('input[placeholder*="Search"]');
    if (!inp) return;
    inp.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, '${phone}');
  })()`, 4000).catch(()=>{});

  // 3. Sonucu bekle ve ilk öğeye tıkla (3 sn timeout per poll)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    const found = (await safeExecJS(wv, `(function(){
      const items = document.querySelectorAll('[data-testid="cell-frame-container"]');
      if (items.length > 0) { items[0].click(); return true; }
      return false;
    })()`, 3000).catch(()=>null)) ?? false;
    if (found) return true;
  }
  return false;
}

async function sendToNumber(wv, phone, message, useSearch = false, skipHistoryCheck = false) {
  if (useSearch) {
    // Güçlendirme modu: SPA içinde arama ile aç — sayfa yenilenmez
    const opened = await openChatBySearch(wv, phone);
    if (!opened) {
      // Arama başarısız → URL fallback
      wv.src = `https://web.whatsapp.com/send?phone=${phone}`;
    }
  } else {
    // Kampanya modu: doğrudan URL navigasyonu (yeni numaralar için)
    wv.src = `https://web.whatsapp.com/send?phone=${phone}`;
  }

  // Sohbet kutusunun açılmasını bekle (daha uzun timeout — ağ gecikmelerine tolerans)
  let inputFound = false;
  const deadline = Date.now() + 38000;

  while (Date.now() < deadline) {
    await humanDelay(2000, 3500);
    try {
      // safeExecJS: yanıt vermeyen webview'de sonsuz beklemeyi önler (8 sn timeout)
      const state = (await safeExecJS(wv, `(function(){
        // WhatsApp yoksa veya geçersiz numara → popup gösterilir
        const popup = document.querySelector('[data-testid="popup-contents"]');
        if (popup) {
          const txt = (popup.textContent || '').toLowerCase();
          // "whatsapp yok" ve "geçersiz numara" metinlerini yakala
          if (txt.includes('phone number') || txt.includes('telefon')
           || txt.includes('not on whatsapp') || txt.includes('whatsapp yok')
           || txt.includes('invalid') || txt.includes('geçersiz')) {
            return 'no_wa';
          }
          return 'invalid'; // başka popup (ör. bağlantı hatası) — yeniden dene
        }
        const box = document.querySelector('[data-testid="conversation-compose-box-input"]')
                 || document.querySelector('div[contenteditable="true"][data-tab="10"]')
                 || document.querySelector('div[contenteditable="true"][role="textbox"]');
        return box ? 'ready' : 'loading';
      })()`, 8000)) ?? 'loading';

      if (state === 'no_wa')   return 'no_wa';
      if (state === 'invalid') return false;
      if (state === 'ready')   { inputFound = true; break; }
    } catch {}
  }

  if (!inputFound) return false;

  // ── Mevcut sohbet geçmişi kontrolü — kampanya modunda daha önce konuşulan atlanır ──
  // Warming modunda (skipHistoryCheck=true) bu kontrol yapılmaz — güçlendirme
  // ortakları zaten birbirleriyle konuştuğu için her zaman geçmiş olur.
  if (!skipHistoryCheck) {
    await humanDelay(1500, 2500);
    try {
      const hasHistory = await safeExecJS(wv, `(function(){
        return !!(
          document.querySelector('[data-testid="msg-out"]')  ||
          document.querySelector('[data-testid="msg-in"]')   ||
          document.querySelector('.message-out')              ||
          document.querySelector('.message-in')
        );
      })()`, 6000);
      if (hasHistory) return 'has_history';
    } catch {}
  }

  // "Sohbeti okuyormuş gibi" gecikme — çok kısa sürede mesaj atmak bot işareti
  await humanDelay(1200, 3000);

  // Açık konuşmanın mesaj geçmişini kısa scroll ile "oku"
  await wv.executeJavaScript(`(async function(){
    const msgArea = document.querySelector('[data-testid="msg-container"]')
                 || document.querySelector('#main .copyable-area');
    if (msgArea && Math.random() > 0.4) {
      msgArea.scrollTop -= Math.floor(Math.random() * 120 + 60);
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 600 + 300)));
      msgArea.scrollTop = msgArea.scrollHeight;
    }
  })()`).catch(() => {});

  await humanDelay(800, 2000);

  // ── Karakter karakter yazma + typing indicator simülasyonu ──────────
  const wordCount  = message.split(/\s+/).length;
  const mul        = getTypingMul();
  // Tüm gecikmeler hız çarpanına göre ölçeklenir
  const thinkMs    = Math.round(Math.min(12000, Math.max(800,  (wordCount * 300 + Math.floor(Math.random() * 1500)))) * mul);
  const avgTypeMs  = Math.round(Math.max(5,  (Math.random() * 40 + 40)  * mul));
  const focusDelay = Math.round(randomInterval(400, 900)  * mul);
  const clearDelay = Math.round(randomInterval(100, 250)  * mul);
  const readDelay  = Math.round(randomInterval(600, 1400) * mul);
  const spaceBase  = Math.max(10, Math.round(90  * mul));
  const spaceMin   = Math.max(5,  Math.round(40  * mul));
  const pauseBase  = Math.max(50, Math.round(400 * mul));
  const pauseMin   = Math.max(20, Math.round(200 * mul));
  const charMin    = Math.max(5,  Math.round(30  * mul));

  const sent = await wv.executeJavaScript(`(async function(){
    const box = document.querySelector('[data-testid="conversation-compose-box-input"]')
             || document.querySelector('div[contenteditable="true"][data-tab="10"]')
             || document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!box) return false;

    // Kutuya tıkla (sadece focus değil — gerçek pointer event)
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }));
    box.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true, cancelable:true }));
    box.dispatchEvent(new MouseEvent('click',     { bubbles:true, cancelable:true }));
    box.focus();
    await new Promise(r => setTimeout(r, ${focusDelay}));

    // ── "Düşünüyor" fazı: kutu odakta ama henüz yazmıyor ────────────
    await new Promise(r => setTimeout(r, ${thinkMs}));

    // Varsa önceki içeriği temizle
    document.execCommand('selectAll', false, null);
    await new Promise(r => setTimeout(r, ${clearDelay}));

    // ── Karakter karakter yaz ──────────────────────────────────────────
    // ÖNEMLI: keydown/beforeinput olaylarını KULLANMA — WhatsApp'ın kendi
    // keydown handler'ı da karakteri ekler ve execCommand ile çakışır →
    // Türkçe karakterler dahil tüm harfler çift yazılırdı.
    // execCommand('insertText') zaten hem DOM'u hem React state'ini günceller.
    const msg = ${JSON.stringify(message)};
    for (let i = 0; i < msg.length; i++) {
      const char = msg[i];

      if (char === '\\n') {
        // Shift+Enter → WhatsApp'ta satır sonu (Enter tek başına gönderir)
        box.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, shiftKey:true, bubbles:true, cancelable:true }));
        box.dispatchEvent(new KeyboardEvent('keyup',   { key:'Enter', code:'Enter', keyCode:13, shiftKey:true, bubbles:true }));
      } else {
        // Normal karakter: execCommand kendi input event'ini de tetikler
        document.execCommand('insertText', false, char);
      }

      // Yazma hızı: kelime/satır aralarında kısa mola
      let delay;
      if (char === ' ' || char === '\\n') {
        delay = Math.floor(Math.random() * ${spaceBase} + ${spaceMin});    // kelime/satır arası
      } else if (Math.random() < 0.08) {
        delay = Math.floor(Math.random() * ${pauseBase} + ${pauseMin});    // %8: "duraksadı"
      } else {
        delay = Math.floor(Math.random() * ${avgTypeMs} + ${charMin});
      }
      await new Promise(r => setTimeout(r, delay));
    }

    // "Yazdıklarını okudu" gecikmesi
    await new Promise(r => setTimeout(r, ${readDelay}));

    // Gönder butonuna tıkla
    const btn = document.querySelector('[data-testid="send"]')
             || document.querySelector('button[aria-label="Gönder"]')
             || document.querySelector('button[aria-label="Send"]');
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles:true }));
      btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true }));
      btn.click();
      return true;
    }

    // Buton yoksa Enter
    box.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, bubbles:true, cancelable:true }));
    box.dispatchEvent(new KeyboardEvent('keyup',   { key:'Enter', keyCode:13, bubbles:true }));
    return true;
  })()`).catch(() => false);

  if (sent) {
    // Mesaj gönderildikten sonra "gönderildiğini gördü" gecikmesi
    await humanDelay(2500, 5000);
    return true;
  }
  return false;
}

// ── Kampanya içi iç ısınma turu ───────────────────────────────────────────
// Her N kampanya mesajında bir tetiklenir.
// İki hesap 2-5 dakika boyunca gerçekçi karşılıklı sohbet yapar —
// sonra kampanyaya kaldıkları yerden devam ederler.
async function doCampaignInternalWarm(senderAccountId, senderWv) {
  if (!campaignRunning[senderAccountId]) return;

  const sender = accounts.find(a => a.id === senderAccountId);
  if (!sender) return;

  // Telefon numarası olan ve bu hesaptan FARKLI bir partner bul
  const partners = accounts.filter(a =>
    a.id !== senderAccountId &&
    a.phone && a.phone.replace(/\D/g, '').length >= 10
  );
  if (!partners.length) return;

  // Gönderenin de telefon numarası olmalı — yoksa tek yön moda düş
  if (!sender.phone || sender.phone.replace(/\D/g, '').length < 10) {
    const partner = partners[Math.floor(Math.random() * partners.length)];
    const msg     = WARM_EXCHANGES[Math.floor(Math.random() * WARM_EXCHANGES.length)][0];
    logToPanel(`[${sender.name}] 💬 İç ısınma → ${partner.name}`, 'log-wait');
    await humanDelay(1200, 2800);
    await sendToNumber(senderWv, partner.phone.replace(/\D/g, ''), msg, true, true).catch(() => {});
    await safeExecJS(senderWv, `(function(){
      const b = document.querySelector('[data-testid="back"]')
             || document.querySelector('button[aria-label="Geri"]')
             || document.querySelector('button[aria-label="Back"]');
      if (b) b.click();
    })()`, 3000).catch(() => {});
    return;
  }

  // Partner seç
  const partner      = partners[Math.floor(Math.random() * partners.length)];
  const partnerWv    = getOrCreateWebview(partner);
  const partnerPhone = partner.phone.replace(/\D/g, '');
  const senderPhone  = sender.phone.replace(/\D/g, '');

  // Sohbet süresi: 2-5 dakika rastgele
  const totalMs    = Math.round((2 + Math.random() * 3) * 60 * 1000);
  const startTime  = Date.now();
  const durationMin = Math.round(totalMs / 60000);

  // Başlangıç durumu
  let exchIdx    = Math.floor(Math.random() * WARM_EXCHANGES.length);
  let turn       = 0;   // 0 = sender→partner, 1 = partner→sender
  let msgCount   = 0;
  const usedMsgs = new Set();

  logToPanel(`[${sender.name}↔${partner.name}] 💬 İç ısınma sohbeti başladı (~${durationMin} dk)`, 'log-wait');
  setAccountStatus(senderAccountId, `💬 ${partner.name} ile muhabbet`);

  // İlk mesajdan önce kısa doğal gecikme
  const ready = await sleepCancellable(Math.round(1200 + Math.random() * 1600), senderAccountId);
  if (!ready || !campaignRunning[senderAccountId]) return;

  // ── Sohbet döngüsü ─────────────────────────────────────────────────────
  while (Date.now() - startTime < totalMs) {
    if (!campaignRunning[senderAccountId]) break;

    const isAtoB        = (turn === 0);
    const curSender     = isAtoB ? sender  : partner;
    const curReceiver   = isAtoB ? partner : sender;
    const curWv         = isAtoB ? senderWv : partnerWv;
    const receiverPhone = isAtoB ? partnerPhone : senderPhone;

    // Mesaj seç — tekrar etmemesine özen göster
    const exchRow = WARM_EXCHANGES[exchIdx % WARM_EXCHANGES.length];
    let message   = exchRow[turn];
    if (usedMsgs.has(message)) {
      message = WARM_EXCHANGES[(exchIdx + 3) % WARM_EXCHANGES.length][turn];
    }
    usedMsgs.add(message);
    if (usedMsgs.size > 8) usedMsgs.clear();

    logToPanel(`[${curSender.name}→${curReceiver.name}] 💬 "${message}"`, 'log-wait');
    setAccountStatus(senderAccountId, `💬 ${sender.name}↔${partner.name} (${msgCount + 1}. mesaj)`);

    try {
      const result = await sendToNumber(curWv, receiverPhone, message, true, true);
      if (result === true) {
        msgCount++;
        logToPanel(`[${curSender.name}→${curReceiver.name}] ✅ ${msgCount}. mesaj gönderildi`, 'log-sent');
        // Sohbet listesine dön
        await safeExecJS(curWv, `(function(){
          const b = document.querySelector('[data-testid="back"]')
                 || document.querySelector('button[aria-label="Geri"]')
                 || document.querySelector('button[aria-label="Back"]');
          if (b) b.click();
        })()`, 4000).catch(() => {});
      } else {
        logToPanel(`[${curSender.name}→${curReceiver.name}] ⏭ Atlandı (${result || 'hata'})`, 'log-wait');
      }
    } catch {
      logToPanel(`[${curSender.name}→${curReceiver.name}] ⚠️ Gönderim hatası`, 'log-wait');
    }

    // Sırayı çevir: A→B → B→A → A→B…
    turn = turn === 0 ? 1 : 0;
    if (turn === 0) exchIdx++;

    // Kalan süre kontrolü
    const remaining = totalMs - (Date.now() - startTime);
    if (remaining <= 3000) break;

    // Mesajlar arası bekleme: 18-42 saniye (gerçekçi okuma + yazma süresi)
    const delayMs = Math.min(
      Math.round(18000 + Math.random() * 24000),
      remaining - 2000
    );
    if (delayMs <= 0) break;

    const remMin = Math.ceil(remaining / 60000);
    logToPanel(`[${sender.name}↔${partner.name}] ⏳ ~${Math.round(delayMs / 1000)} sn sonra devam (~${remMin} dk kaldı)`, 'log-wait');

    const cont = await sleepCancellable(delayMs, senderAccountId);
    if (!cont || !campaignRunning[senderAccountId]) break;
  }

  // ── Sohbet bitti ───────────────────────────────────────────────────────
  logToPanel(`[${sender.name}↔${partner.name}] ✅ İç ısınma tamamlandı — ${msgCount} mesaj alışverişi`, 'log-sent');
  setAccountStatus(senderAccountId, '▶ Kampanya devam ediyor');

  // Her iki webview de sohbet listesine dönsün
  const backScript = `(function(){
    const b = document.querySelector('[data-testid="back"]')
           || document.querySelector('button[aria-label="Geri"]')
           || document.querySelector('button[aria-label="Back"]');
    if (b) b.click();
  })()`;
  await Promise.allSettled([
    safeExecJS(senderWv,  backScript, 3000),
    safeExecJS(partnerWv, backScript, 3000),
  ]);

  await humanDelay(1200, 2500);
}

// ── Önce Selam: cevap bekleme ─────────────────────────────────────────────
// Sohbetteyken gelen son mesajın timestamp'ini kaydeder,
// sonra bekleme döngüsünde yeni bir incoming message gelip gelmediğini kontrol eder.
// Dönüş: true → cevap geldi, false → timeout veya kampanya durdu
async function waitForReply(wv, accountId, timeoutMs) {
  // Mevcut son mesaj zamanını al — sadece incoming (gelen) mesajlar
  const getLastIncomingTime = async () => {
    try {
      return await wv.executeJavaScript(`(function(){
        const msgs = document.querySelectorAll(
          'div[data-testid="msg-container"].message-in,' +
          '.message-in .copyable-text,' +
          '[data-testid="conversation-panel-messages"] .message-in'
        );
        if (!msgs.length) {
          // Fallback: last message that is NOT outgoing
          const allMsgs = document.querySelectorAll('[data-testid="msg-container"]');
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            if (!allMsgs[i].classList.contains('message-out') &&
                !allMsgs[i].querySelector('.message-out')) {
              const ts = allMsgs[i].querySelector('[data-pre-plain-text]');
              return ts ? ts.getAttribute('data-pre-plain-text') : Date.now().toString();
            }
          }
          return null;
        }
        const last = msgs[msgs.length - 1];
        const ts = last.querySelector ? last.querySelector('[data-pre-plain-text]') : null;
        return ts ? ts.getAttribute('data-pre-plain-text') : Date.now().toString();
      })()`);
    } catch { return null; }
  };

  const baselineTs = await getLastIncomingTime();
  const deadline   = Date.now() + timeoutMs;
  const POLL_TICK  = 8000; // her 8 saniyede bir kontrol

  while (Date.now() < deadline) {
    if (!campaignRunning[accountId]) return false;
    await sleepCancellable(POLL_TICK, accountId);
    if (!campaignRunning[accountId]) return false;

    const currentTs = await getLastIncomingTime();
    // Timestamp değiştiyse yeni bir incoming mesaj gelmiş demektir
    if (currentTs !== null && currentTs !== baselineTs) return true;
  }
  return false; // timeout
}

async function runCampaignLoop(accountId) {
  const account = accounts.find(x => x.id === accountId); if (!account) return;
  try { // ── try/finally: her çıkışta campaignRunning temizlenir ──────────
  const templates = globalTemplates.filter(t => globalCampaign.templateIds.includes(t.id));
  if (!templates.length) {
    logToPanel(`[${account.name}] ⚠️ Şablon seçilmemiş`, 'log-fail');
    return;
  }

  // Şablon kalitesi uyarısı
  const allHaveSpin = templates.every(t => /\{[^}]+\|[^}]+\}/.test(t.text));
  const hasUrl      = templates.some(t => /https?:\/\/|bit\.ly|wa\.me/i.test(t.text));
  if (templates.length === 1 && !allHaveSpin) {
    logToPanel(`[${account.name}] ⚠️ Tek şablon + spin syntax yok — ban riski!`, 'log-fail');
  }
  if (hasUrl) {
    logToPanel(`[${account.name}] ⚠️ URL içeren şablon — ban riski!`, 'log-fail');
  }

  const wv = getOrCreateWebview(account);
  document.querySelectorAll('webview').forEach(w => w.classList.remove('active'));
  wv.classList.add('active'); activeAccountId = accountId;
  welcomeScreen.classList.add('hidden'); renderAccounts();

  // ── Oturum yaşı kontrolü ─────────────────────────────────────
  if (securitySettings.settleCooldown) {
    const MIN_SESSION_AGE_MS = ACCOUNT_SETTLE_MS;
    const sessionAge = sessionStarted[accountId] ? Date.now() - sessionStarted[accountId] : MIN_SESSION_AGE_MS;
    if (sessionAge < MIN_SESSION_AGE_MS) {
      logToPanel(`[${account.name}] ⏳ Yerleşme bekleniyor: ${fmtMs(MIN_SESSION_AGE_MS - sessionAge)}`, 'log-wait');
      await sleepCancellable(MIN_SESSION_AGE_MS - sessionAge, accountId);
      if (!campaignRunning[accountId]) return;
    }
  }

  // ── Presence pattern'i durdur ─────────────────────────────────
  stopPresencePattern(accountId);

  // ── Proxy uygula ──────────────────────────────────────────────
  if (account.proxies && account.proxies.length) {
    if (account.proxies.length > 1 && account.proxyRotate !== false) {
      rotateProxy(accountId); renderAccountsDebounced();
    }
    const activeProxy = await applyAccountProxy(accountId);
    logToPanel(`[${account.name}] 🌐 Proxy: ${activeProxy || '—'} (${(account.proxyIdx||0)+1}/${account.proxies.length})`, 'log-info');
    await humanDelay(1500, 3000);
  } else {
    logToPanel(`[${account.name}] 🌐 Proxy yok — direkt bağlantı`, 'log-wait');
  }

  // ── Isınma ────────────────────────────────────────────────────
  logToPanel(`[${account.name}] 🔥 Isınıyor…`, 'log-wait');
  await humanDelay(3000, 6000);
  await simulateReading(wv);
  await humanDelay(2000, 4000);
  await simulateReading(wv);
  await humanDelay(1500, 3000);

  const dailyLimit = account.dailyLimit || 20;  // hesap bazında — kampanya boyunca sabit

  let sentCount   = 0;
  let failStreak  = 0;
  const MAX_FAIL_STREAK = 3;

  while (true) {
    if (!campaignRunning[accountId]) { logToPanel(`[${account.name}] ⏹ Durduruldu.`, 'log-wait'); if (campaignStats[accountId]) campaignStats[accountId].stopReason = 'stop'; break; }

    // ── Güncel kampanya ayarlarını her iterasyonda oku ──────────
    // (Duraklat → ayar değiştir → Devam akışında yeni değerler hemen geçerli olur)
    const breakAfter = globalCampaign.breakAfter    || 10;
    const breakDur   = globalCampaign.breakDuration || 15;
    const hrsOn      = globalCampaign.hoursEnabled  || false;
    const hrsFrom    = globalCampaign.hourFrom      || '09:00';
    const hrsTo      = globalCampaign.hourTo        || '21:00';
    const minWait    = globalCampaign.minInterval   || 5;
    const maxWait    = globalCampaign.maxInterval   || 10;
    // Şablonları da taze oku — duraklat sırasında seçim değişmiş olabilir
    const templates  = globalTemplates.filter(t => globalCampaign.templateIds.includes(t.id));
    if (!templates.length) { logToPanel(`[${account.name}] ⚠️ Şablon seçili değil — durduruldu.`, 'log-fail'); break; }

    // ── Çalışma saati kontrolü ──────────────────────────────────
    if (hrsOn && !isWithinHours(hrsFrom, hrsTo)) {
      logToPanel(`[${account.name}] 🕐 Çalışma saati dışı (${hrsFrom}–${hrsTo}), bekleniyor…`, 'log-wait');
      while (campaignRunning[accountId] && !isWithinHours(hrsFrom, hrsTo)) {
        // Her 1 dakikada bir saati kontrol et, ama 1 sn adımlarla iptal edilebilir
        const cont = await sleepCancellable(60 * 1000, accountId);
        if (!cont) break;
      }
      if (!campaignRunning[accountId]) break;
      logToPanel(`[${account.name}] ▶️ Çalışma saati başladı`, 'log-info');
    }

    // ── Günlük limit ────────────────────────────────────────────
    if (getDailySent(accountId) >= dailyLimit) {
      logToPanel(`[${account.name}] 🛑 Günlük limit (${dailyLimit}) doldu.`, 'log-fail');
      if (campaignStats[accountId]) campaignStats[accountId].stopReason = 'limit';
      sendSystemNotification('📊 Günlük Limit Doldu', `${account.name}: ${dailyLimit} mesaj limitine ulaştı.`);
      break;
    }

    // ── Hesap kısıtlama kontrolü ────────────────────────────────
    if (await isAccountRestricted(wv)) {
      restrictedAccounts.add(accountId);
      renderAccountsDebounced();
      if (campaignStats[accountId]) campaignStats[accountId].stopReason = 'ban';
      logToPanel(`[${account.name}] 🚨 Hesap kısıtlandı! Kampanya durduruldu.`, 'log-fail');
      showToast(`🚨 ${account.name} kısıtlandı!`, 5000);
      sendSystemNotification('🚨 Hesap Kısıtlandı!', `${account.name} WhatsApp tarafından kısıtlandı.`);
      break;
    }

    // ── Paylaşılan kuyruktan numara al ──────────────────────────
    const phone = getNextFromQueue();
    if (!phone) { logToPanel(`[${account.name}] ✅ Kuyruk bitti.`, 'log-info'); if (campaignStats[accountId] && campaignStats[accountId].stopReason === 'running') campaignStats[accountId].stopReason = 'done'; break; }

    let template = pickTemplate(accountId, templates);
    let message  = spinMessage(template.text);
    // Öncekiyle aynı ilk kelimeyle başlamasın
    const lastFirst = accountLastMsgFirstWord[accountId];
    if (lastFirst && templates.length > 1) {
      const firstW = message.trim().split(/\s+/)[0].replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ]/g, '').toLowerCase();
      if (firstW === lastFirst) {
        const alts = templates.filter(t => t.id !== template.id);
        if (alts.length) { template = pickTemplate(accountId, alts); message = spinMessage(template.text); }
      }
    }
    accountLastMsgFirstWord[accountId] = message.trim().split(/\s+/)[0].replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ]/g, '').toLowerCase();

    setAccountStatus(accountId, `📤 Yazıyor → ${phone}`);
    logToPanel(`[${account.name}] 📤 [${template.name}] → ${phone}`, 'log-wait');

    // ── Önce Selam Modu ──────────────────────────────────────────
    // Etkinse: önce sohbeti aç, selam gönder, cevap bekle, sonra hazır metin
    if (globalCampaign.greetMode) {
      const greetMsg = pickGreeting(accountId);
      logToPanel(`[${account.name}] 👋 Selam gönderiliyor → ${phone}: "${greetMsg}"`, 'log-wait');
      setAccountStatus(accountId, `👋 Selam → ${phone}`);

      // Sohbeti aç (search ile, sayfa yenilemeden)
      const greetResult = await sendToNumber(wv, phone, greetMsg, true, true);

      if (greetResult === 'no_wa') {
        // WhatsApp yok — normal no_wa işlemi aşağıya devret
        const result2 = 'no_wa';
        logToPanel(`[${account.name}] ⏭ WhatsApp yok (selam aşaması), atlandı: ${phone}`, 'log-wait');
        if (campaignStats[accountId]) campaignStats[accountId].noWa++;
        sentNumbersGlobal.add(phone); saveSentNumbers();
        addToBlacklist(phone); recordNoWaEvent(accountId);
        const noWaRateNow = getNoWaRate(accountId);
        if (noWaRateNow >= NO_WA_WARN_THRESHOLD) {
          await sleepCancellable(15000, accountId);
        }
        purgeSentFromNumbersList(); continue;
      }

      if (greetResult === 'has_history') {
        logToPanel(`[${account.name}] ⏭ Mevcut sohbet (selam aşaması), atlandı: ${phone}`, 'log-wait');
        if (campaignStats[accountId]) campaignStats[accountId].hasHistory++;
        returningCustomers++;
        localStorage.setItem('wa_returning_customers', returningCustomers.toString());
        sentNumbersGlobal.add(phone); saveSentNumbers();
        addToBlacklist(phone); purgeSentFromNumbersList(); continue;
      }

      if (greetResult !== true) {
        logToPanel(`[${account.name}] ⚠️ Selam gönderilemedi — atlanıyor: ${phone}`, 'log-wait');
        continue;
      }

      // Selam gönderildi — cevap bekle
      const timeoutMs = (globalCampaign.greetTimeoutMin || 5) * 60 * 1000;
      logToPanel(`[${account.name}] ⏳ Cevap bekleniyor (${globalCampaign.greetTimeoutMin || 5} dk)… → ${phone}`, 'log-wait');
      setAccountStatus(accountId, `⏳ Cevap bekleniyor → ${phone}`);

      const replied = await waitForReply(wv, accountId, timeoutMs);

      if (!campaignRunning[accountId]) break;

      if (!replied) {
        logToPanel(`[${account.name}] ⏭ Cevap gelmedi, atlanıyor: ${phone}`, 'log-wait');
        sentNumbersGlobal.add(phone); saveSentNumbers();
        purgeSentFromNumbersList();
        // Sohbet listesine dön
        await safeExecJS(wv, `(function(){
          const b = document.querySelector('[data-testid="back"]')
                 || document.querySelector('button[aria-label="Geri"]')
                 || document.querySelector('button[aria-label="Back"]');
          if (b) b.click();
        })()`, 3000).catch(() => {});
        continue;
      }

      // Cevap geldi — dönüş yapan müşteri sayacı
      if (campaignStats[accountId]) campaignStats[accountId].replied++;
      returningCustomers++;
      localStorage.setItem('wa_returning_customers', returningCustomers.toString());

      // Hazır metni gönder
      logToPanel(`[${account.name}] ✅ Cevap geldi! Hazır metin gönderiliyor → ${phone}`, 'log-sent');
      setAccountStatus(accountId, `📤 Hazır metin → ${phone}`);
      await humanDelay(2000, 4500); // Doğal gecikme — hemen yazmasin
    }

    let result = await sendToNumber(wv, phone, message, true); // SPA — sayfa yenilenmez

    // ── WhatsApp yok → kara listeye ekle ve atla (bekleme yok) ─
    if (result === 'no_wa') {
      logToPanel(`[${account.name}] ⏭ WhatsApp yok, atlandı: ${phone}`, 'log-wait');
      if (campaignStats[accountId]) campaignStats[accountId].noWa++;
      sentNumbersGlobal.add(phone);
      saveSentNumbers();
      addToBlacklist(phone);
      recordNoWaEvent(accountId);
      // Ban erken uyarı kontrolü
      const noWaRateNow = getNoWaRate(accountId);
      if (noWaRateNow >= NO_WA_WARN_THRESHOLD) {
        logToPanel(`[${account.name}] ⚠️ Ban riski: No-WA oranı %${Math.round(noWaRateNow * 100)} — yavaşlatılıyor`, 'log-fail');
        showToast(`⚠️ ${account.name}: Yüksek no_wa oranı — yavaşlatılıyor!`, 6000);
        sendSystemNotification('⚠️ Ban Erken Uyarı', `${account.name}: Son 3 saatte %${Math.round(noWaRateNow * 100)} no_wa oranı.`);
        await sleepCancellable(15000, accountId); // 15 sn ekstra yavaşlatma
      }
      // Numara listesinden de sil
      purgeSentFromNumbersList();
      continue;
    }

    // ── Mevcut sohbet → kara listeye ekle, anında atla ─────────
    if (result === 'has_history') {
      logToPanel(`[${account.name}] ⏭ Mevcut sohbet var, numaradan silindi: ${phone}`, 'log-wait');
      if (campaignStats[accountId]) campaignStats[accountId].hasHistory++;
      returningCustomers++;
      localStorage.setItem('wa_returning_customers', returningCustomers.toString());
      sentNumbersGlobal.add(phone);
      saveSentNumbers();
      addToBlacklist(phone);
      purgeSentFromNumbersList();
      continue;
    }

    let ok = result === true;
    if (!ok && campaignRunning[accountId]) {
      setAccountStatus(accountId, '⚠️ Gönderilemedi');
      logToPanel(`[${account.name}] ⚠️ Gönderilemedi — 5 sn sonra sıradaki numaraya geçiliyor…`, 'log-wait');
      await sleepCancellable(5000, accountId);
      continue;
    }

    if (ok) {
      sentCount++;
      if (campaignStats[accountId]) campaignStats[accountId].sent++;
      incrementDaily(accountId);
      sentNumbersGlobal.add(phone);
      saveSentNumbers();
      const totalNums = parseNumbers(globalCampaignNumbers).length;
      logToPanel(`[${account.name}] ✅ Gönderildi — bugün: ${getDailySent(accountId)}/${dailyLimit} | kuyrukta: ${campaignQueue.length} kaldı`, 'log-sent');
      cpProgressFill.style.width = `${Math.min(100, Math.round((sentNumbersGlobal.size / Math.max(1, totalNums)) * 100))}%`;
      cpProgressText.textContent = `${sentNumbersGlobal.size}/${totalNums} işlendi — ${account.name}: ${getDailySent(accountId)}/${dailyLimit}`;
      failStreak = 0;
      setAccountStatus(accountId, `✅ ${getDailySent(accountId)}/${dailyLimit} gönderildi`);
      // badge zaten setAccountStatus → updateSentBadge ile güncellendi
      await addNaturalActivity(wv);

      // ── Her N kampanya mesajında 1 iç ısınma turu ─────────────
      // Hesaplar kendi aralarında konuşarak çift yönlü aktivite oluşturur
      if (sentCount % warmInterval === 0 && campaignRunning[accountId]) {
        await doCampaignInternalWarm(accountId, wv);
      }
    } else {
      failStreak++;
      if (campaignStats[accountId]) campaignStats[accountId].failed++;
      logToPanel(`[${account.name}] ❌ Başarısız: ${phone} — arka arkaya: ${failStreak}/${MAX_FAIL_STREAK}`, 'log-fail');
      if (failStreak >= MAX_FAIL_STREAK) {
        if (campaignStats[accountId]) campaignStats[accountId].stopReason = 'fail';
        logToPanel(`[${account.name}] 🛑 3 hata üst üste — durduruldu.`, 'log-fail');
        showToast(`🛑 ${account.name}: 3 hata — kampanya durduruldu!`, 6000);
        break;
      }
    }

    if (!campaignRunning[accountId]) break;

    // ── Mola sistemi ────────────────────────────────────────────
    if (sentCount > 0 && sentCount % breakAfter === 0) {
      safeExecJS(wv, `(function(){
        const back = document.querySelector('[data-testid="back"]')
                  || document.querySelector('button[aria-label="Geri"]')
                  || document.querySelector('button[aria-label="Back"]');
        if (back) back.click();
      })()`, 5000).catch(() => {});
      setAccountCountdown(accountId, breakDur * 60 * 1000, '☕ Mola');
      logToPanel(`[${account.name}] ☕ ${sentCount}. mesaj — ${breakDur} dk mola`, 'log-info');
      const molaCont = await sleepCancellable(breakDur * 60 * 1000, accountId);
      if (!molaCont || !campaignRunning[accountId]) break;
      await humanDelay(3000, 6000);
      await simulateReading(wv);
      await humanDelay(1500, 3000);
      logToPanel(`[${account.name}] ▶️ Mola bitti, devam…`, 'log-info');
    } else {
      const waitMs = randomInterval(minWait, maxWait) * 60 * 1000;
      setAccountCountdown(accountId, waitMs, '⏳ Bekliyor');
      logToPanel(`[${account.name}] ⏳ ${fmtMs(waitMs)} bekleniyor`, 'log-wait');
      await sleepCancellable(waitMs, accountId);
    }
  }

  setAccountStatus(accountId, '✅ Tamamlandı');
  logToPanel(`[${account.name}] 🎉 Tamamlandı — ${sentCount} mesaj gönderildi.`, 'log-info');
  // Geri butonuyla sohbet listesine dön — WebSocket bağlantısı korunur
  await safeExecJS(wv, `(function(){
    const back = document.querySelector('[data-testid="back"]')
              || document.querySelector('button[aria-label="Geri"]')
              || document.querySelector('button[aria-label="Back"]');
    if (back) back.click();
  })()`, 5000).catch(() => {});
  // Presence pattern'i yeniden başlat
  setTimeout(() => startPresencePattern(wv, accountId), 30 * 1000);

  } finally {
    // Her çıkışta (normal, break, veya hata) campaignRunning'i temizle
    campaignRunning[accountId] = false;
    if (campaignStats[accountId]) {
      campaignStats[accountId].endTime = Date.now();
      if (campaignStats[accountId].stopReason === 'running') campaignStats[accountId].stopReason = 'done';
    }
    // Kampanya bitti bildirimi
    const finalSent = campaignStats[accountId]?.sent ?? 0;
    if (finalSent > 0) {
      sendSystemNotification('✅ Kampanya Tamamlandı', `${account.name}: ${finalSent} mesaj gönderildi.`);
    }
    // Durum sıfırla: kısıtlı değilse boşta göster
    if (!restrictedAccounts.has(accountId)) {
      setAccountStatus(accountId, `Boşta — ${getDailySent(accountId)}/${account.dailyLimit || 20} bugün`);
    }
    renderAccountsDebounced(); // sağlık göstergelerini güncelle
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  PROXY MODAL
// ══════════════════════════════════════════════════════════════════════════
let proxyModalAccountId = null;

function showProxyModal(accountId) {
  proxyModalAccountId = accountId;
  const account = accounts.find(a => a.id === accountId);
  if (!account) return;

  document.getElementById('proxy-modal-acct-name').textContent = account.name;
  document.getElementById('proxy-list-input').value  = (account.proxies || []).join('\n');
  document.getElementById('proxy-rotate-cb').checked = account.proxyRotate !== false;

  // Aktif proxy bilgisi
  const info = document.getElementById('proxy-current-info');
  if (account.proxies && account.proxies.length) {
    const idx = (account.proxyIdx || 0) % account.proxies.length;
    info.innerHTML = `<strong>Aktif:</strong> ${escHtml(account.proxies[idx])} &nbsp;·&nbsp; ${idx + 1} / ${account.proxies.length} proxy`;
  } else {
    info.textContent = 'Proxy yok — direkt bağlantı kullanılıyor.';
  }

  document.getElementById('proxy-modal-overlay').classList.add('show');
  setTimeout(() => document.getElementById('proxy-list-input').focus(), 60);
}

function closeProxyModal() {
  document.getElementById('proxy-modal-overlay').classList.remove('show');
  proxyModalAccountId = null;
}

async function confirmProxyModal() {
  const account = accounts.find(a => a.id === proxyModalAccountId);
  if (!account) return;

  const raw     = document.getElementById('proxy-list-input').value || '';
  const proxies = raw.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  const rotate  = document.getElementById('proxy-rotate-cb').checked;

  account.proxies     = proxies;
  account.proxyRotate = rotate;
  if ((account.proxyIdx || 0) >= proxies.length) account.proxyIdx = 0;

  saveAccounts();
  renderAccounts();

  // Hemen uygula
  const applied = await applyAccountProxy(account.id);
  if (proxies.length) {
    showToast(`✅ ${proxies.length} proxy kaydedildi — aktif: ${applied}`);
  } else {
    showToast('✅ Proxy temizlendi — direkt bağlantı');
  }
  closeProxyModal();
}

async function clearProxyModal() {
  const account = accounts.find(a => a.id === proxyModalAccountId);
  if (!account) return;
  account.proxies  = [];
  account.proxyIdx = 0;
  saveAccounts();
  renderAccounts();
  await applyAccountProxy(account.id);
  showToast('🗑️ Proxy temizlendi');
  closeProxyModal();
}

// ══════════════════════════════════════════════════════════════════════════
//  HESAP GÜÇLENDİRME MODU
// ══════════════════════════════════════════════════════════════════════════
function openWarmingPanel() {
  renderWarmAccountList();
  warmModalOverlay.classList.add('show');
}
function closeWarmingPanel() {
  warmModalOverlay.classList.remove('show');
}

function renderWarmAccountList() {
  const container = document.getElementById('warm-account-list');
  if (!container) return;
  const phoneAccounts = accounts.filter(a =>
    a.phone && a.phone.replace(/\D/g, '').length >= 10 &&
    !loggedOutAccounts.has(a.id)
  );
  if (!phoneAccounts.length) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:10px 0;text-align:center;line-height:1.8;">
      ⚠️ Telefon numarası ekli hesap bulunamadı.<br>
      Hesap ekle veya düzenle (✏️) bölümünden numara girin.
    </div>`;
    return;
  }
  container.innerHTML = '';
  phoneAccounts.forEach(a => {
    const label = document.createElement('label');
    label.className = 'tmpl-check-item selected';
    label.style.marginBottom = '6px';
    label.innerHTML = `
      <input type="checkbox" value="${a.id}" style="width:15px;height:15px;accent-color:var(--accent);flex-shrink:0;margin-top:3px;cursor:pointer;" checked>
      <div style="flex:1;min-width:0;">
        <div class="tmpl-check-name">${escHtml(a.name)}</div>
        <div class="tmpl-check-preview" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span>📞 ${escHtml(a.phone)}</span>
          <span id="warm-status-${a.id}" style="color:var(--accent);font-weight:600;font-size:10.5px;"></span>
        </div>
      </div>`;
    label.querySelector('input').addEventListener('change', e => label.classList.toggle('selected', e.target.checked));
    container.appendChild(label);
  });
}

function logWarming(msg, cls = '') {
  const log = document.getElementById('warm-log');
  if (!log) return;
  const line = document.createElement('div'); if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`;
  log.appendChild(line); log.scrollTop = log.scrollHeight;
  logToSidebar(msg, cls);
}

function updateWarmingControls() {
  const startBtn = document.getElementById('warm-start-btn');
  const pauseBtn = document.getElementById('warm-pause-btn');
  const stopBtn  = document.getElementById('warm-stop-btn');
  const isRun    = warmingRunning;
  const isPaused = warmingPaused;

  if (startBtn) startBtn.disabled = isRun;
  if (stopBtn)  stopBtn.disabled  = !isRun;
  if (pauseBtn) {
    pauseBtn.disabled    = !isRun;
    pauseBtn.textContent = isPaused ? '▶ Devam' : '⏸ Duraklat';
    pauseBtn.className   = isPaused
      ? 'cp-btn cp-btn-primary'
      : 'cp-btn cp-btn-secondary';
  }
  // Ayarlar yalnızca çalışmıyorken değiştirilebilir
  document.querySelectorAll('#warm-account-list input').forEach(cb => cb.disabled = isRun);
  ['warm-min-int','warm-max-int','warm-daily-limit','warm-duration','warm-conv-depth'].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = isRun;
  });
}

// ── Tek bir çiftin bağımsız güçlendirme döngüsü ─────────────────────────────
// Her çift kendi async döngüsünde çalışır — diğer çiftleri beklemez.
// Sohbet derinliği: her "cooldown"dan önce 2–4 mesaj ileri–geri alışverişi yapılır.
async function runWarmingPairLoop(pair, opts) {
  const { minInt, maxInt, dailyLmt, counter, convDepthMax } = opts;

  // Çift başlangıçlarını birbirinden ayır
  const staggerOk = await sleepWarm(randomInterval(500, 4000));
  if (!staggerOk || !warmingRunning) return;

  while (warmingRunning) {
    // ── Sohbet derinliği: bu turda kaç mesaj gönderilecek ────────────────
    const burstSize = 2 + Math.floor(Math.random() * Math.max(1, convDepthMax - 1));
    let lastSenderId = null;

    for (let bi = 0; bi < burstSize && warmingRunning; bi++) {
      const today  = todayKey();
      if (!warmingDailySends[today]) warmingDailySends[today] = {};
      const dailyMap = warmingDailySends[today];

      const sender   = pair.turn === 0 ? pair.a : pair.b;
      const receiver = pair.turn === 0 ? pair.b : pair.a;
      lastSenderId   = sender.id;

      // ── Günlük limit ───────────────────────────────────────────────────
      if ((dailyMap[sender.id] || 0) >= dailyLmt) {
        logWarming(`🛑 ${sender.name} günlük limite ulaştı.`, 'log-fail');
        return; // bu çift bitmiş
      }

      // ── Kısıtlama kontrolü (sadece burst başında) ──────────────────────
      if (bi === 0) {
        const wvCheck = getOrCreateWebview(sender);
        if (await isAccountRestricted(wvCheck)) {
          logWarming(`🚨 ${sender.name} kısıtlandı! Çift durduruldu.`, 'log-fail');
          showToast(`🚨 ${sender.name} kısıtlandı!`, 5000);
          dailyMap[sender.id] = dailyLmt;
          localStorage.setItem('wa_bm_warm_daily', JSON.stringify(warmingDailySends));
          return;
        }
      }

      // ── Mesaj seç — mevcut konuşma ipliğinden ─────────────────────────
      const thread   = WARM_THREADS[pair.exchIdx % WARM_THREADS.length];
      const msgIdx   = pair.threadPos < thread.length ? pair.threadPos : 0;
      let   message  = thread[msgIdx];
      if (pair.usedMsgs.has(message)) {
        const alt = WARM_THREADS[(pair.exchIdx + 1) % WARM_THREADS.length];
        message = alt[msgIdx % alt.length];
      }
      pair.usedMsgs.add(message);
      if (pair.usedMsgs.size > 10) pair.usedMsgs.clear();

      const phone = receiver.phone.replace(/\D/g, '');

      // ── Anlık durum ────────────────────────────────────────────────────
      setAccountStatus(sender.id,   `💬 Yazıyor → ${receiver.name}`);
      setAccountStatus(receiver.id, `📨 ← ${sender.name}`);
      const wStatusS = document.getElementById(`warm-status-${sender.id}`);
      const wStatusR = document.getElementById(`warm-status-${receiver.id}`);
      if (wStatusS) wStatusS.textContent = `✍️ → ${receiver.name}`;
      if (wStatusR) wStatusR.textContent = `📨 ← ${sender.name}`;

      // ── İnsan gibi yazma gecikmesi (mesaj uzunluğuna orantılı) ──────────
      const typingMs = message.length * (55 + Math.random() * 75); // ~55–130ms/karakter
      await sleepWarm(Math.min(typingMs + 800, 5000));
      if (!warmingRunning) break;

      // ── Gönder ────────────────────────────────────────────────────────
      const wv = getOrCreateWebview(sender);
      let ok = await sendToNumber(wv, phone, message, true, true);
      if (ok !== true && warmingRunning) {
        if (wStatusS) wStatusS.textContent = `🔄 Tekrar…`;
        await humanDelay(700, 1400);
        if (warmingRunning) ok = await sendToNumber(wv, phone, message, true, true);
      }

      if (ok === true) {
        counter.totalSent++;
        dailyMap[sender.id] = (dailyMap[sender.id] || 0) + 1;
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
        Object.keys(warmingDailySends).forEach(d => { if (d < cutoff) delete warmingDailySends[d]; });
        localStorage.setItem('wa_bm_warm_daily', JSON.stringify(warmingDailySends));
        logWarming(`💬 [${bi+1}/${burstSize}] ${sender.name}→${receiver.name}: "${message}" ✅`, 'log-sent');
        if (wStatusS) wStatusS.textContent = `✅ ${dailyMap[sender.id]}/${dailyLmt}`;
        setAccountStatus(sender.id, `✅ ${dailyMap[sender.id]}/${dailyLmt}`);

        // Geri — sonraki mesaj temiz başlasın
        await wv.executeJavaScript(`(function(){
          const b = document.querySelector('[data-testid="back"]')
                 || document.querySelector('button[aria-label="Geri"]')
                 || document.querySelector('button[aria-label="Back"]');
          if (b) b.click();
        })()`).catch(() => {});

        // Sıra ve konuşma ilerlet
        pair.turn       = pair.turn === 0 ? 1 : 0;
        pair.threadPos  = (pair.threadPos || 0) + 1;
        if (pair.threadPos >= thread.length) { pair.exchIdx++; pair.threadPos = 0; }

      } else {
        logWarming(`❌ Gönderilemedi: ${sender.name}→${receiver.name}`, 'log-fail');
        if (wStatusS) wStatusS.textContent = `❌ Hata`;
        setAccountStatus(sender.id, `❌ Başarısız`);
        break; // burst'ü kes, cooldown'a geç
      }

      // ── Mesajlar arası kısa "okuma + yazma başlatma" gecikmesi ──────────
      if (bi < burstSize - 1 && warmingRunning) {
        const readMs = 4000 + Math.random() * 12000; // 4–16 sn
        const endShort = Date.now() + readMs;
        const nextThread = WARM_THREADS[pair.exchIdx % WARM_THREADS.length];
        const nextMsg    = nextThread[(pair.threadPos || 0) % nextThread.length] || '';
        const wStatusNext = document.getElementById(`warm-status-${receiver.id}`);
        const ival = setInterval(() => {
          if (!warmingRunning || Date.now() >= endShort) { clearInterval(ival); return; }
          const rem = Math.ceil((endShort - Date.now()) / 1000);
          if (wStatusNext) wStatusNext.textContent = `✍️ ${rem}s`;
        }, 1000);
        logWarming(`💭 ${receiver.name} yanıt yazıyor… (${(readMs/1000).toFixed(0)}s)`, 'log-wait');
        setTimeout(() => clearInterval(ival), readMs + 2000);
        await sleepWarm(readMs);
      }
    } // end burst loop

    if (!warmingRunning) break;

    // ── Konuşmalar arası tam cooldown ─────────────────────────────────────
    const wait   = randomInterval(minInt, maxInt);
    const waitMs = wait * 60 * 1000;
    const senderName = pair.turn === 0 ? pair.a.name : pair.b.name;
    logWarming(`⏳ [${pair.a.name}↔${pair.b.name}] Cooldown: ${wait.toFixed(1)} dk`, 'log-wait');

    // Cooldown sayacı — warm status spanında
    const wStatusA = document.getElementById(`warm-status-${pair.a.id}`);
    const wStatusB = document.getElementById(`warm-status-${pair.b.id}`);
    const endTime  = Date.now() + waitMs;
    const cdIval   = setInterval(() => {
      if (!warmingRunning || Date.now() >= endTime) { clearInterval(cdIval); return; }
      const rem = Math.max(0, endTime - Date.now());
      const txt = `⏳ ${fmtMs(rem)}`;
      if (wStatusA) wStatusA.textContent = txt;
      if (wStatusB) wStatusB.textContent = txt;
    }, 1000);
    setAccountCountdown(pair.a.id, waitMs, '⏳ Bekliyor');
    setAccountCountdown(pair.b.id, waitMs, '⏳ Bekliyor');
    setTimeout(() => clearInterval(cdIval), waitMs + 2000);

    const cont = await sleepWarm(waitMs);
    clearInterval(cdIval);
    if (!cont) break;
  }
}

async function runWarmingLoop() {
  const selectedIds      = Array.from(document.querySelectorAll('#warm-account-list input[type="checkbox"]:checked')).map(cb => cb.value);
  const selectedAccounts = accounts.filter(a => selectedIds.includes(a.id) && a.phone && a.phone.replace(/\D/g, '').length >= 10);

  if (selectedAccounts.length < 2) {
    showToast('⚠️ En az 2 telefon numaralı hesap seçin');
    warmingRunning = false; updateWarmingControls(); return;
  }

  // ── Yerleşme süresi kontrolü ──────────────────────────────────────────────
  if (securitySettings.settleCooldown) {
    const notReady = selectedAccounts.filter(a => getSettleRemaining(a.id) > 0);
    if (notReady.length > 0) {
      const info = notReady.map(a => `• ${a.name}: <strong>${fmtMs(getSettleRemaining(a.id))}</strong>`).join('<br>');
      showSecurityBlock({
        icon: '⏳',
        title: 'Hesaplar Henüz Yerleşmedi',
        msg: 'Aşağıdaki hesaplar yeni bağlandı. Güçlendirme başlamadan önce kısa yerleşme sürelerinin dolmasını bekleyin.',
        detail: info,
      });
      warmingRunning = false; updateWarmingControls(); return;
    }
  }

  const minInt      = parseInt(document.getElementById('warm-min-int')?.value)     || 3;
  const maxInt      = parseInt(document.getElementById('warm-max-int')?.value)     || 8;
  const dailyLmt    = parseInt(document.getElementById('warm-daily-limit')?.value) || 20;
  const durationMin = parseInt(document.getElementById('warm-duration')?.value)    || 0;
  const convDepthMax= parseInt(document.getElementById('warm-conv-depth')?.value)  || 3;

  const log = document.getElementById('warm-log');
  if (log) log.innerHTML = '';

  // ── Süre zamanlayıcısı (0 = sınırsız) ────────────────────────────────────
  let warmingDurationTimer = null;
  if (durationMin > 0) {
    logWarming(`⏰ Süre sınırı: ${durationMin} dk — tamamlanınca otomatik duracak.`, 'log-info');
    warmingDurationTimer = setTimeout(() => {
      if (warmingRunning) {
        logWarming(`⏰ ${durationMin} dk doldu. Güçlendirme durduruluyor…`, 'log-info');
        warmingRunning = false;
        updateWarmingControls();
        // Hesap durumlarını temizle
        accounts.forEach(a => setAccountStatus(a.id, `Boşta — ${getDailySent(a.id)}/${a.dailyLimit || 20} bugün`));
      }
    }, durationMin * 60 * 1000);
  }

  // ── Çiftleri oluştur ─────────────────────────────────────────────────────
  const shuffled = [...selectedAccounts].sort(() => Math.random() - 0.5);
  const pairs = [];
  for (let i = 0; i + 1 < shuffled.length; i += 2) {
    pairs.push({ a: shuffled[i], b: shuffled[i + 1], turn: 0, exchIdx: 0, threadPos: 0, usedMsgs: new Set() });
  }
  if (shuffled.length % 2 === 1) {
    const extra = shuffled[shuffled.length - 1];
    pairs.push({ a: extra, b: shuffled[0], turn: 1, exchIdx: Math.floor(WARM_THREADS.length / 2), threadPos: 0, usedMsgs: new Set() });
  }

  const today = todayKey();
  if (!warmingDailySends[today]) warmingDailySends[today] = {};

  logWarming(`💪 Güçlendirme başladı — ${selectedAccounts.length} hesap, ${pairs.length} çift (paralel)`, 'log-info');
  logWarming(`🔗 Çiftler: ${pairs.map(p => `${p.a.name}↔${p.b.name}`).join('  |  ')}`, 'log-info');

  // ── Her çift kendi bağımsız döngüsünde — hepsi aynı anda çalışır ─────────
  const counter = { totalSent: 0 };
  await Promise.allSettled(pairs.map(pair => runWarmingPairLoop(pair, { minInt, maxInt, dailyLmt, counter, convDepthMax })));

  if (warmingDurationTimer) clearTimeout(warmingDurationTimer);
  logWarming(`⏹ Güçlendirme tamamlandı. Toplam ${counter.totalSent} mesaj gönderildi.`, 'log-info');
  warmingRunning = false;
  updateWarmingControls();
  // Tüm hesapların warm status spanlarını temizle
  accounts.forEach(a => {
    const sp = document.getElementById(`warm-status-${a.id}`);
    if (sp) sp.textContent = '';
  });
  document.getElementById('slog-dot')?.classList.remove('active');
}

// ══════════════════════════════════════════════════════════════════════════
//  SELAM PANELI
// ══════════════════════════════════════════════════════════════════════════
const GREET_STORAGE_POOL     = 'wa_greet_custom_pool';
const GREET_STORAGE_FOLLOWUP = 'wa_greet_followup';
const GREET_STORAGE_TIMEOUT  = 'wa_greet_timeout';
const GREET_STORAGE_INTERVAL = 'wa_greet_interval';

function openGreetPanel() {
  // Hesap listesini doldur
  const container = document.getElementById('greet-account-select');
  if (container) {
    container.innerHTML = accounts.length
      ? accounts.map(a => `
        <label class="tmpl-check-item" style="justify-content:flex-start;gap:8px;">
          <input type="checkbox" value="${a.id}" ${a.phone ? '' : 'disabled title="Telefon numarası yok"'}>
          <span>${a.name}</span>
          ${a.phone ? '' : '<span style="font-size:10px;color:var(--text-dim)">(numara yok)</span>'}
        </label>`).join('')
      : '<div style="font-size:12px;color:var(--text-muted);">Henüz hesap eklenmedi.</div>';
  }
  // Kayıtlı ayarları yükle
  const savedPoolRaw  = localStorage.getItem(GREET_STORAGE_POOL);
  const savedFollowup = localStorage.getItem(GREET_STORAGE_FOLLOWUP) || '';
  const savedTimeout  = localStorage.getItem(GREET_STORAGE_TIMEOUT)  || '5';
  const savedInterval = localStorage.getItem(GREET_STORAGE_INTERVAL) || '3-8';

  // Pool JSON dizisi olarak saklanıyor → parse et
  let poolLines = GREETING_POOL;
  if (savedPoolRaw) {
    try { const parsed = JSON.parse(savedPoolRaw); if (Array.isArray(parsed)) poolLines = parsed; }
    catch { poolLines = savedPoolRaw.split('\n').map(s => s.trim()).filter(Boolean); }
  }

  const poolEl = document.getElementById('greet-pool-textarea');
  if (poolEl) poolEl.value = poolLines.join('\n');
  const followEl = document.getElementById('greet-followup-textarea');
  if (followEl) followEl.value = savedFollowup;
  const toEl = document.getElementById('greet-timeout-min');
  if (toEl) toEl.value = savedTimeout;
  const [minI, maxI] = savedInterval.split('-');
  const minEl = document.getElementById('greet-min-int');
  const maxEl = document.getElementById('greet-max-int');
  if (minEl) minEl.value = minI || '3';
  if (maxEl) maxEl.value = maxI || '8';

  document.getElementById('greet-modal-overlay')?.classList.add('show');
}

function saveGreetSettings() {
  const poolLines = (document.getElementById('greet-pool-textarea')?.value || '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  localStorage.setItem(GREET_STORAGE_POOL,     JSON.stringify(poolLines));
  localStorage.setItem(GREET_STORAGE_FOLLOWUP, document.getElementById('greet-followup-textarea')?.value || '');
  localStorage.setItem(GREET_STORAGE_TIMEOUT,  document.getElementById('greet-timeout-min')?.value || '5');
  const minI = document.getElementById('greet-min-int')?.value || '3';
  const maxI = document.getElementById('greet-max-int')?.value || '8';
  localStorage.setItem(GREET_STORAGE_INTERVAL, `${minI}-${maxI}`);
}

function logGreet(msg, cls = '') {
  const log = document.getElementById('greet-log');
  if (!log) return;
  if (log.textContent === 'Selam modu başlatılmadı.' || log.textContent === '') log.innerHTML = '';
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.textContent = `[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  logToPanel(msg, cls); // Kampanya loguna da yaz
}

function startGreetMode() {
  saveGreetSettings();

  const selectedIds = Array.from(document.querySelectorAll('#greet-account-select input:checked')).map(cb => cb.value);
  if (selectedIds.length === 0) { showToast('⚠️ En az 1 hesap seçin'); return; }

  const followup = document.getElementById('greet-followup-textarea')?.value?.trim();
  if (!followup) { showToast('⚠️ Cevap sonrası mesaj boş olamaz'); return; }

  const numbersRaw = document.getElementById('greet-numbers-textarea')?.value || '';
  const numbers = numbersRaw.split(/[\n,;]+/).map(n => n.trim().replace(/\D/g, '')).filter(n => n.length >= 8);
  if (numbers.length === 0) { showToast('⚠️ Numara listesi boş'); return; }

  const poolLines = (document.getElementById('greet-pool-textarea')?.value || '').split('\n').map(s=>s.trim()).filter(Boolean);
  const timeoutMin = parseInt(document.getElementById('greet-timeout-min')?.value) || 5;
  const minInt = parseInt(document.getElementById('greet-min-int')?.value) || 3;
  const maxInt = parseInt(document.getElementById('greet-max-int')?.value) || 8;

  // 1. Geçici follow-up şablonu ekle
  globalTemplates = globalTemplates.filter(t => t.id !== GREET_TMP_ID);
  globalTemplates.push({ id: GREET_TMP_ID, name: '👋 Selam Takip', category: 'Selam', text: followup });
  greetPreviousTemplateIds      = [...(globalCampaign.templateIds || [])];
  globalCampaign.templateIds    = [GREET_TMP_ID];

  // 2. Selamlama havuzu override
  greetCustomPoolOverride = poolLines.length > 0 ? poolLines : null;

  // 3. Kampanya parametreleri
  globalCampaign.greetMode       = true;
  globalCampaign.greetTimeoutMin = timeoutMin;
  globalCampaign.minInterval     = minInt;
  globalCampaign.maxInterval     = maxInt;

  // 4. Numara kuyruğunu oluştur
  const parsedNums = parseNumbers(numbers.join('\n'))
    .filter(n => !sentNumbersGlobal.has(n) && !isBlacklisted(n));
  if (!parsedNums.length) { showToast('⚠️ Tüm numaralar zaten kara listede'); return; }
  campaignQueue = [...parsedNums];
  for (let i = campaignQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [campaignQueue[i], campaignQueue[j]] = [campaignQueue[j], campaignQueue[i]];
  }

  // 5. İstatistikler
  campaignStats     = {};
  campaignStartTime = Date.now();
  selectedIds.forEach(id => {
    const acc = accounts.find(a => a.id === id);
    campaignStats[id] = { name: acc?.name || id, sent:0, noWa:0, hasHistory:0, failed:0, replied:0, startTime:Date.now(), endTime:null, stopReason:'running' };
    if (greetCustomPoolOverride) delete aiGreetingCache[id];
  });

  // 6. Başlat
  globalCampaignRunning = true;
  globalCampaignPaused  = false;
  selectedIds.forEach(id => { campaignRunning[id] = true; });
  updateCampaignControls();
  updateStatsStrip();
  selectedIds.forEach(id => runCampaignLoop(id));

  const startBtn = document.getElementById('greet-start-btn');
  const stopBtn  = document.getElementById('greet-stop-btn');
  if (startBtn) startBtn.disabled = true;
  if (stopBtn)  stopBtn.disabled  = false;
  document.getElementById('greet-log').innerHTML = '';
  logGreet(`👋 Selam modu başlatıldı — ${selectedIds.length} hesap, ${parsedNums.length} numara`, 'log-info');
}

function stopGreetMode() {
  globalCampaignPaused = false;
  Object.keys(campaignRunning).forEach(id => { campaignRunning[id] = false; });
  globalCampaignRunning = false;
  greetCustomPoolOverride = null;
  globalCampaign.greetMode = false;
  if (greetPreviousTemplateIds !== null) {
    globalCampaign.templateIds = greetPreviousTemplateIds;
    greetPreviousTemplateIds   = null;
  }
  globalTemplates = globalTemplates.filter(t => t.id !== GREET_TMP_ID);
  updateCampaignControls();
  updateStatsStrip();
  logGreet('⏹ Selam modu durduruldu.', 'log-wait');
  const startBtn = document.getElementById('greet-start-btn');
  const stopBtn  = document.getElementById('greet-stop-btn');
  if (startBtn) startBtn.disabled = false;
  if (stopBtn)  stopBtn.disabled  = true;
}

// Event listeners
document.getElementById('greet-btn')?.addEventListener('click', openGreetPanel);
document.getElementById('greet-modal-close')?.addEventListener('click', () => {
  document.getElementById('greet-modal-overlay')?.classList.remove('show');
});
document.getElementById('greet-start-btn')?.addEventListener('click', startGreetMode);
document.getElementById('greet-stop-btn')?.addEventListener('click', stopGreetMode);
document.getElementById('greet-save-pool-btn')?.addEventListener('click', () => {
  saveGreetSettings();
  showToast('✅ Selam ayarları kaydedildi');
});
document.getElementById('greet-load-lures-btn')?.addEventListener('click', () => {
  const poolEl = document.getElementById('greet-pool-textarea');
  if (!poolEl) return;
  poolEl.value = LURE_POOL.join('\n');
  showToast('😈 Yemleme havuzu yüklendi');
});
document.getElementById('greet-ai-lures-btn')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('greet-ai-status');
  const btn      = document.getElementById('greet-ai-lures-btn');
  const provider = localStorage.getItem(AI_PROVIDER_KEY) || 'anthropic';
  const keyId    = provider === 'anthropic' ? AI_KEY_ANTHROPIC : AI_KEY_OPENAI;
  if (!localStorage.getItem(keyId)) {
    showToast('⚠️ AI API anahtarı bulunamadı — Ayarlar\'dan ekle');
    return;
  }
  if (statusEl) statusEl.textContent = '⏳ AI yemleme mesajları üretiliyor…';
  if (btn) btn.disabled = true;
  const msgs = await generateAILures(15);
  if (btn) btn.disabled = false;
  if (msgs && msgs.length) {
    const poolEl = document.getElementById('greet-pool-textarea');
    if (poolEl) poolEl.value = msgs.join('\n');
    if (statusEl) statusEl.textContent = `✅ ${msgs.length} yemleme mesajı üretildi`;
    showToast(`🤖 ${msgs.length} AI yemleme mesajı hazır`);
  } else {
    if (statusEl) statusEl.textContent = '❌ Üretim başarısız — API yanıt vermedi';
    showToast('❌ AI yemleme üretilemedi');
  }
});
makeOverlayCloseable(document.getElementById('greet-modal-overlay'), () => {
  document.getElementById('greet-modal-overlay')?.classList.remove('show');
});

// ══════════════════════════════════════════════════════════════════════════
//  HESAP MODAL
// ══════════════════════════════════════════════════════════════════════════
function showAddModal() {
  // ── Zorunlu hesap ekleme cooldown'u ───────────────────────────────────────
  if (securitySettings.addCooldown) {
    const remaining = getAddCooldownRemaining();
    if (remaining > 0) {
      showSecurityBlock({
        icon: '⏱️',
        title: 'Hesap Ekleme Cooldown\'u Aktif',
        msg: `Ard arda hesap eklemek WhatsApp\'ın bot tespitini tetikleyebilir. Bir sonraki hesabı eklemeden önce kısa bir süre beklemen gerekiyor.`,
        detail: `⏳ Kalan süre: <strong>${fmtMs(remaining)}</strong><br>💡 Bu süre dolduğunda tekrar dene ya da güvenlik ayarlarından bu korumayı geçici olarak devre dışı bırakabilirsin.`,
      });
      return;
    }
  }
  editingAccountId = null; modalTitle.textContent = 'Yeni Hesap Ekle';
  accountNameInput.value = '';
  if (accountPhoneInput) accountPhoneInput.value = '';
  const dlInput = document.getElementById('account-daily-limit-input');
  if (dlInput) dlInput.value = '20';
  const tagsInput = document.getElementById('account-tags-input');
  if (tagsInput) tagsInput.value = '';
  modalConfirm.textContent = 'Ekle';
  modalOverlay.classList.add('show'); setTimeout(() => accountNameInput.focus(), 50);
}
function showRenameModal(id) {
  const a = accounts.find(x => x.id === id); if (!a) return;
  editingAccountId = id; modalTitle.textContent = 'Hesabı Yeniden Adlandır';
  accountNameInput.value = a.name;
  if (accountPhoneInput) accountPhoneInput.value = a.phone || '';
  const dlInput = document.getElementById('account-daily-limit-input');
  if (dlInput) dlInput.value = a.dailyLimit || 20;
  const tagsInput = document.getElementById('account-tags-input');
  if (tagsInput) tagsInput.value = (a.tags || []).join(', ');
  modalConfirm.textContent = 'Kaydet';
  modalOverlay.classList.add('show'); setTimeout(() => { accountNameInput.focus(); accountNameInput.select(); }, 50);
}
function closeModal() { modalOverlay.classList.remove('show'); editingAccountId = null; }
function confirmModal() {
  const name       = accountNameInput.value.trim(); if (!name) { accountNameInput.focus(); return; }
  const phone      = accountPhoneInput ? accountPhoneInput.value.trim() : '';
  const dlInput    = document.getElementById('account-daily-limit-input');
  const dailyLimit = dlInput ? parseInt(dlInput.value) || 20 : 20;
  // Etiketleri parse et
  const tagsInput  = document.getElementById('account-tags-input');
  const parsedTags = tagsInput
    ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  if (editingAccountId) {
    renameAccount(editingAccountId, name, phone, dailyLimit);
    const acc = accounts.find(a => a.id === editingAccountId);
    if (acc) { acc.tags = parsedTags; saveAccounts(); renderAccounts(); }
  } else {
    addAccount(name, phone, dailyLimit);
    // Yeni eklenen hesabın tag'larını kaydet
    const newAcc = accounts[accounts.length - 1];
    if (newAcc) { newAcc.tags = parsedTags; saveAccounts(); renderAccounts(); }
  }
  closeModal();
}

// ══════════════════════════════════════════════════════════════════════════
//  SAĞ TIK MENÜSÜ
// ══════════════════════════════════════════════════════════════════════════
function showContextMenu(x, y, id) {
  contextMenuAccId = id;
  contextMenu.style.left = Math.min(x, window.innerWidth  - 190) + 'px';
  contextMenu.style.top  = Math.min(y, window.innerHeight - 130) + 'px';
  contextMenu.classList.add('show');
}
function hideContextMenu() { contextMenu.classList.remove('show'); contextMenuAccId = null; }

// ══════════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════
addAccountBtn.addEventListener('click', showAddModal);
themeBtn.addEventListener('click', () => { darkTheme = !darkTheme; applyTheme(); showToast(darkTheme ? '🌙 Karanlık tema' : '☀️ Açık tema'); });
soundBtn.addEventListener('click', () => { soundEnabled = !soundEnabled; applySound(); showToast(soundEnabled ? '🔔 Ses açık' : '🔕 Ses kapalı'); });

const tsbSlider = document.getElementById('typing-speed-slider');
if (tsbSlider) {
  tsbSlider.addEventListener('input', () => {
    typingSpeed = parseInt(tsbSlider.value);
    applyTypingSpeed();
    showToast(`⌨️ Yazma hızı: ${TYPING_SPEED_LABELS[typingSpeed - 1]}`);
  });
}

// ── Metin seçerken overlay kapanma bug düzeltmesi ────────────────────────
// mousedown başladığı element overlay'in kendisiyse (box değil) kapat.
// Böylece modal içinde metin seçimi sırasında kapanma olmaz.
function makeOverlayCloseable(overlayEl, closeFn) {
  if (!overlayEl) return;
  let mdOnOverlay = false;
  overlayEl.addEventListener('mousedown', e => { mdOnOverlay = e.target === overlayEl; });
  overlayEl.addEventListener('click',     e => { if (e.target === overlayEl && mdOnOverlay) closeFn(); });
}

modalCancel.addEventListener('click', closeModal);
modalConfirm.addEventListener('click', confirmModal);
makeOverlayCloseable(modalOverlay, closeModal);
document.getElementById('modal-close-x')?.addEventListener('click', closeModal);
accountNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmModal(); if (e.key === 'Escape') closeModal(); });
// Diğer modal X butonları
document.getElementById('tmpl-modal-close-x')?.addEventListener('click', closeTmplModal);
document.getElementById('proxy-modal-close-x')?.addEventListener('click', closeProxyModal);
document.getElementById('campaign-report-close-x')?.addEventListener('click', closeCampaignReport);
document.getElementById('confirm-delete-close-x')?.addEventListener('click', closeConfirmDelete);
document.getElementById('security-modal-close-x')?.addEventListener('click', closeSecurityModal);
document.getElementById('ai-gen-modal-close-x')?.addEventListener('click', closeAiGenModal);

cpAddTmplBtn.addEventListener('click', () => showTmplModal());

// ══════════════════════════════════════════════════════════════════════════
//  AI HAZIR METİN ÜRETİCİSİ
// ══════════════════════════════════════════════════════════════════════════
// AI_KEY_ANTHROPIC / AI_KEY_OPENAI / AI_PROVIDER_KEY — dosya başında tanımlı

let aiProvider = 'anthropic'; // aktif seçili sağlayıcı

function openAiGenModal() {
  const overlay = document.getElementById('ai-gen-modal-overlay');
  if (!overlay) return;
  // Kayıtlı tercih/keyler
  aiProvider = localStorage.getItem(AI_PROVIDER_KEY) || 'anthropic';
  const antKey = localStorage.getItem(AI_KEY_ANTHROPIC) || '';
  const oaiKey = localStorage.getItem(AI_KEY_OPENAI)    || '';
  const antInput = document.getElementById('ai-gen-apikey-anthropic');
  const oaiInput = document.getElementById('ai-gen-apikey-openai');
  if (antInput) antInput.value = antKey;
  if (oaiInput) oaiInput.value = oaiKey;
  applyAiProvider(aiProvider);
  resetAiGenResults();
  overlay.classList.add('show');
  setTimeout(() => document.getElementById('ai-gen-base')?.focus(), 80);
}

function closeAiGenModal() {
  document.getElementById('ai-gen-modal-overlay')?.classList.remove('show');
}

function applyAiProvider(provider) {
  aiProvider = provider;
  localStorage.setItem(AI_PROVIDER_KEY, provider);
  // Toggle butonları güncelle
  document.querySelectorAll('.ai-provider-btn').forEach(btn => {
    btn.className = 'ai-provider-btn';
    if (btn.dataset.provider === provider) {
      btn.classList.add(provider === 'anthropic' ? 'active-anthropic' : 'active-openai');
    }
  });
  // Key alanları + info kutularını göster/gizle
  const antWrap = document.getElementById('ai-key-anthropic-wrap');
  const oaiWrap = document.getElementById('ai-key-openai-wrap');
  if (antWrap) antWrap.style.display = provider === 'anthropic' ? '' : 'none';
  if (oaiWrap) oaiWrap.style.display = provider === 'openai'    ? '' : 'none';
  document.getElementById('ai-info-anthropic')?.classList.toggle('show', provider === 'anthropic');
  document.getElementById('ai-info-openai')   ?.classList.toggle('show', provider === 'openai');
  // Üret butonunu renklendir
  const runBtn = document.getElementById('ai-gen-run-btn');
  if (runBtn) {
    runBtn.style.background = provider === 'openai' ? '#10a37f' : '#a855f7';
  }
}

function updateKeyStatus(provider, value) {
  if (provider === 'anthropic') {
    const st = document.getElementById('ai-gen-key-status');
    if (!st) return;
    if (!value) { st.textContent = ''; return; }
    if (value.startsWith('sk-ant-')) { st.style.color = 'var(--accent)'; st.textContent = '✓ Geçerli format'; }
    else { st.style.color = 'var(--danger)'; st.textContent = '⚠ Anthropic keyleri sk-ant- ile başlar'; }
  } else {
    const st = document.getElementById('ai-gen-key-status-openai');
    if (!st) return;
    if (!value) { st.textContent = ''; return; }
    if (value.startsWith('sk-')) { st.style.color = '#10a37f'; st.textContent = '✓ Geçerli format'; }
    else { st.style.color = 'var(--danger)'; st.textContent = '⚠ OpenAI keyleri sk- ile başlar'; }
  }
}

function resetAiGenResults() {
  const wrap    = document.getElementById('ai-gen-results-wrap');
  const results = document.getElementById('ai-gen-results');
  const loading = document.getElementById('ai-gen-loading');
  const addBtn  = document.getElementById('ai-gen-add-btn');
  if (wrap)    wrap.style.display    = 'none';
  if (results) results.innerHTML     = '';
  if (loading) loading.style.display = 'none';
  if (addBtn)  addBtn.disabled       = true;
}

async function runAiGeneration() {
  const keyInputId = aiProvider === 'anthropic' ? 'ai-gen-apikey-anthropic' : 'ai-gen-apikey-openai';
  const key     = (document.getElementById(keyInputId)?.value || '').trim();
  const base    = (document.getElementById('ai-gen-base')?.value || '').trim();
  const count   = Math.min(20, Math.max(2, parseInt(document.getElementById('ai-gen-count')?.value) || 5));
  const loading = document.getElementById('ai-gen-loading');
  const status  = document.getElementById('ai-gen-status');
  const runBtn  = document.getElementById('ai-gen-run-btn');

  const providerLabel = aiProvider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  if (!key)  { showToast(`⚠️ Önce ${providerLabel} API key girin`); return; }
  if (!base) { showToast('⚠️ Ana mesajı girin'); return; }

  resetAiGenResults();
  if (loading) loading.style.display = 'flex';
  if (status)  status.textContent    = `${providerLabel}'a bağlanıyor…`;
  if (runBtn)  runBtn.disabled       = true;

  try {
    const prompt = `Aşağıdaki WhatsApp pazarlama mesajını ${count} farklı şekilde yeniden yaz.

Kurallar:
- Her versiyon aynı anlamı taşımalı ama farklı kelimeler ve cümle yapısı kullansın
- Mesajın dilini koru (Türkçe ise Türkçe kalsın, İngilizce ise İngilizce)
- Doğal ve samimi bir dil kullan — robot gibi görünmesin
- Mümkün olduğunda {seçenek1|seçenek2} spin syntax ekle (farklı ifade seçenekleri)
- Uzunluk orijinale yakın olsun
- Sadece JSON dizisi döndür, başka hiçbir şey ekleme

Format: ["versiyon 1", "versiyon 2", ...]

Ana mesaj:
${base}`;

    if (status) status.textContent = `${count} varyasyon üretiliyor…`;

    const ipcChannel = aiProvider === 'anthropic' ? 'anthropic-generate' : 'openai-generate';
    const result = await ipcRenderer.invoke(ipcChannel, { apiKey: key, prompt, maxTokens: 4096 });

    if (!result.ok) {
      const msg = result.body?.error?.message || `HTTP ${result.status}`;
      if (result.status === 401) throw new Error('Geçersiz API key — lütfen kontrol edin');
      if (result.status === 429) throw new Error('API limiti aşıldı — biraz bekleyin');
      throw new Error(msg);
    }

    const raw = result.body?.content?.[0]?.text || '';
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Beklenmedik yanıt formatı — tekrar deneyin');
    const variations = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(variations) || !variations.length) throw new Error('Boş yanıt geldi');

    if (loading) loading.style.display = 'none';
    renderAiResults(variations);

  } catch (e) {
    if (loading) loading.style.display = 'none';
    showToast(`❌ ${e.message}`, 5000);
    logToPanel(`❌ AI üretim hatası: ${e.message}`, 'log-fail');
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

function renderAiResults(variations) {
  const wrap    = document.getElementById('ai-gen-results-wrap');
  const results = document.getElementById('ai-gen-results');
  if (!wrap || !results) return;
  results.innerHTML = '';
  variations.forEach((text, i) => {
    const item = document.createElement('div');
    item.className = 'ai-result-item selected';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true;
    cb.addEventListener('change', () => { item.classList.toggle('selected', cb.checked); updateAiAddBtn(); });
    const span = document.createElement('div');
    span.className = 'ai-result-text'; span.textContent = text;
    item.appendChild(cb); item.appendChild(span);
    item.addEventListener('click', e => { if (e.target !== cb) { cb.checked = !cb.checked; item.classList.toggle('selected', cb.checked); updateAiAddBtn(); } });
    results.appendChild(item);
  });
  wrap.style.display = 'block';
  updateAiAddBtn();
}

function updateAiAddBtn() {
  const addBtn  = document.getElementById('ai-gen-add-btn');
  const checked = document.querySelectorAll('#ai-gen-results .ai-result-item input:checked').length;
  if (addBtn) {
    addBtn.disabled    = checked === 0;
    addBtn.textContent = checked > 0 ? `✅ ${checked} Metni Ekle` : '✅ Seçilenleri Ekle';
  }
}

function confirmAiGenAdd() {
  const prefix = (document.getElementById('ai-gen-prefix')?.value || 'AI-Varyasyon').trim();
  const items  = document.querySelectorAll('#ai-gen-results .ai-result-item');
  let added = 0;
  items.forEach((item) => {
    const cb   = item.querySelector('input[type=checkbox]');
    const text = item.querySelector('.ai-result-text')?.textContent || '';
    if (!cb?.checked || !text.trim()) return;
    globalTemplates.push({ id: generateId(), name: `${prefix} ${added + 1}`, text: text.trim() });
    added++;
  });
  if (!added) return;
  saveGlobal(); renderTemplatesPanel(); closeAiGenModal();
  showToast(`✅ ${added} hazır metin eklendi`);
  logToPanel(`🤖 AI: ${added} yeni metin şablona eklendi`, 'log-info');
}

// ── AI Modal Event Listeners ──────────────────────────────────────────────
document.getElementById('cp-ai-gen-btn')?.addEventListener('click', openAiGenModal);
document.getElementById('ai-gen-cancel-btn')?.addEventListener('click', closeAiGenModal);
document.getElementById('ai-gen-modal-overlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('ai-gen-modal-overlay')) closeAiGenModal();
});

// Provider toggle butonları
document.querySelectorAll('.ai-provider-btn').forEach(btn => {
  btn.addEventListener('click', () => applyAiProvider(btn.dataset.provider));
});

// Key input doğrulama
document.getElementById('ai-gen-apikey-anthropic')?.addEventListener('input', e => updateKeyStatus('anthropic', e.target.value.trim()));
document.getElementById('ai-gen-apikey-openai')   ?.addEventListener('input', e => updateKeyStatus('openai',    e.target.value.trim()));

// Kaydet butonları
document.querySelectorAll('.ai-gen-save-key-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const provider = btn.dataset.provider;
    const inputId  = provider === 'anthropic' ? 'ai-gen-apikey-anthropic' : 'ai-gen-apikey-openai';
    const storKey  = provider === 'anthropic' ? AI_KEY_ANTHROPIC : AI_KEY_OPENAI;
    const key = (document.getElementById(inputId)?.value || '').trim();
    if (!key) { showToast('⚠️ Key boş'); return; }
    localStorage.setItem(storKey, key);
    showToast(`💾 ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key kaydedildi`);
  });
});

// Dış link butonları (header + info kutusu)
const openUrl = (url) => ipcRenderer.invoke('open-popup', { url }).catch(() => {});
document.getElementById('ai-link-anthropic')     ?.addEventListener('click', e => { e.preventDefault(); openUrl('https://console.anthropic.com/settings/keys'); });
document.getElementById('ai-link-openai')        ?.addEventListener('click', e => { e.preventDefault(); openUrl('https://platform.openai.com/api-keys'); });
document.getElementById('ai-info-link-anthropic')?.addEventListener('click', e => { e.preventDefault(); openUrl('https://console.anthropic.com/settings/keys'); });
document.getElementById('ai-info-link-openai')   ?.addEventListener('click', e => { e.preventDefault(); openUrl('https://platform.openai.com/api-keys'); });

document.getElementById('ai-gen-run-btn')?.addEventListener('click', runAiGeneration);
document.getElementById('ai-gen-add-btn')?.addEventListener('click', confirmAiGenAdd);
document.getElementById('ai-gen-select-all')?.addEventListener('click', () => {
  document.querySelectorAll('#ai-gen-results .ai-result-item').forEach(item => {
    const cb = item.querySelector('input'); if (cb) { cb.checked = true; item.classList.add('selected'); }
  });
  updateAiAddBtn();
});
document.getElementById('ai-gen-select-none')?.addEventListener('click', () => {
  document.querySelectorAll('#ai-gen-results .ai-result-item').forEach(item => {
    const cb = item.querySelector('input'); if (cb) { cb.checked = false; item.classList.remove('selected'); }
  });
  updateAiAddBtn();
});
tmplModalCancel.addEventListener('click', closeTmplModal);
tmplModalConfirm.addEventListener('click', confirmTmplModal);
makeOverlayCloseable(tmplModalOverlay, closeTmplModal);
tmplTextInput.addEventListener('input', () => checkSpamContent(tmplTextInput.value));

// Kategori filtre dropdown
document.getElementById('tmpl-cat-filter')?.addEventListener('change', e => {
  tmplCategoryFilter = e.target.value;
  renderTemplatesPanel();
});

document.querySelectorAll('.cp-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cp-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.cp-tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    const tab = document.getElementById(`cp-tab-${btn.dataset.tab}`);
    if (tab) tab.classList.remove('hidden');
    if (btn.dataset.tab === 'campaign') loadCampaignSettings();
    if (btn.dataset.tab === 'templates') renderTemplatesPanel();
  });
});

cpCloseBtn.addEventListener('click', closeCampaignPanel);
if (cpHoursEnabled) cpHoursEnabled.addEventListener('change', () => {
  if (cpHoursRow) cpHoursRow.style.display = cpHoursEnabled.checked ? 'flex' : 'none';
});
// Önce Selam toggle — bekleme süresini göster/gizle
document.getElementById('cp-greet-mode')?.addEventListener('change', function() {
  const row = document.getElementById('cp-greet-timeout-row');
  if (row) row.style.display = this.checked ? 'flex' : 'none';
});

cpStartBtn.addEventListener('click', async () => {
  // ── Seçili hesapları topla ───────────────────────────────────────────────
  const selectedIds = Array.from(
    document.querySelectorAll('#cp-account-select input[type="checkbox"]:checked')
  ).map(cb => cb.value);
  if (!selectedIds.length) { showToast('⚠️ En az bir hesap seçin'); return; }

  // ── Yerleşme süresi kontrolü ─────────────────────────────────────────────
  if (securitySettings.settleCooldown) {
    for (const id of selectedIds) {
      const settle = getSettleRemaining(id);
      if (settle > 0) {
        const acc = accounts.find(a => a.id === id);
        showSecurityBlock({
          icon: '⏳',
          title: 'Hesap Henüz Yerleşmedi',
          msg: `"${acc?.name || id}" hesabı yeni bağlandı. WhatsApp\'ta sessize benzer görünmemek için sistemin kısa bir yerleşme süresine ihtiyacı var.`,
          detail: `⏳ Kalan süre: <strong>${fmtMs(settle)}</strong><br>💡 Bu süre boyunca hesap doğal bir kullanıcı gibi arka planda aktif kalır. Süre dolduğunda kampanya otomatik başlayabilir.`,
        });
        return;
      }
    }
  }

  saveCampaignSettings();

  // ── Önce Selam açıksa AI selam havuzunu arka planda doldur ─────────────
  if (globalCampaign.greetMode) {
    selectedIds.forEach(id => {
      delete aiGreetingCache[id]; // eski cache'i temizle
      refillAIGreetings(id, 20).catch(() => {}); // arka planda, bekleme
    });
  }

  // ── Kuyruk oluştur — daha önce gönderilmemiş numaralar ──────────────────
  const allNumbers = parseNumbers(globalCampaignNumbers);
  campaignQueue = allNumbers.filter(n => !sentNumbersGlobal.has(n) && !isBlacklisted(n));
  // Sırayı karıştır — sıralı örüntü spam tespitini tetikler
  for (let i = campaignQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [campaignQueue[i], campaignQueue[j]] = [campaignQueue[j], campaignQueue[i]];
  }

  if (!campaignQueue.length) { showToast('⚠️ Gönderilecek numara yok (tümü zaten gönderildi)'); return; }

  const templates = globalTemplates.filter(t => globalCampaign.templateIds.includes(t.id));
  if (!templates.length) { showToast('⚠️ En az bir hazır metin seçin'); return; }

  globalCampaignRunning = true;
  globalCampaignPaused  = false;
  logToPanel(`Kampanya başladı — ${campaignQueue.length} numara | ${selectedIds.length} hesap | ${templates.length} şablon`, 'log-info');

  // Rapor istatistiklerini sıfırla
  campaignStats     = {};
  campaignStartTime = Date.now();
  selectedIds.forEach(id => {
    const acc = accounts.find(a => a.id === id);
    campaignStats[id] = { name: acc?.name || id, sent:0, noWa:0, hasHistory:0, failed:0, replied:0, startTime:Date.now(), endTime:null, stopReason:'running' };
  });
  document.getElementById('cp-report-btn')?.setAttribute('disabled', '');

  selectedIds.forEach(id => { campaignRunning[id] = true; });
  updateCampaignControls();
  renderCampaignAccountSelect();

  // ── Paralel döngüler — her hesap kendi loop'unda çalışır ────────────────
  // allSettled: bir hesap hata verse bile diğerleri çalışmaya devam eder
  await Promise.allSettled(selectedIds.map(id => runCampaignLoop(id)));

  globalCampaignRunning = false;
  globalCampaignPaused  = false;
  selectedIds.forEach(id => { campaignRunning[id] = false; });
  purgeSentFromNumbersList();
  updateCampaignControls();
  renderCampaignAccountSelect();
  logToPanel('✅ Tüm hesaplar tamamlandı.', 'log-info');
  document.getElementById('slog-dot')?.classList.remove('active');
  document.getElementById('cp-report-btn')?.removeAttribute('disabled');
});

// ── Duraklat / Devam ────────────────────────────────────────────────────
document.getElementById('cp-pause-btn')?.addEventListener('click', () => {
  if (!globalCampaignRunning) return;
  globalCampaignPaused = !globalCampaignPaused;
  updateCampaignControls();
  if (globalCampaignPaused) {
    purgeSentFromNumbersList();
    logToPanel('⏸ Kampanya duraklatıldı — kuyruk korunuyor. Ayarları değiştirebilirsiniz.', 'log-wait');
    showToast('⏸ Duraklatıldı');
  } else {
    // Devam: güncel ayarları kaydet ve kaldığı yerden sürdür
    saveCampaignSettings();
    logToPanel('▶ Kampanya devam ediyor…', 'log-info');
    showToast('▶ Devam ediyor');
  }
});

// ── Durdur — kuyruk tamamen temizlenir ─────────────────────────────────
cpStopBtn.addEventListener('click', () => {
  globalCampaignPaused = false;   // önce pause'u kaldır ki döngüler wake up olsun
  Object.keys(campaignRunning).forEach(id => { campaignRunning[id] = false; });
  globalCampaignRunning = false;
  campaignQueue = [];
  purgeSentFromNumbersList();
  updateCampaignControls();
  renderCampaignAccountSelect();
  showToast('⏹ Durduruluyor…');
});


// ── Gönderim geçmişini temizle ───────────────────────────────────────────
const cpClearSentBtn = document.getElementById('cp-clear-sent-btn');
if (cpClearSentBtn) {
  cpClearSentBtn.addEventListener('click', () => {
    if (globalCampaignRunning) { showToast('⚠️ Kampanya çalışırken geçmiş temizlenemez'); return; }
    sentNumbersGlobal.clear();
    saveSentNumbers();
    showToast('🗑 Gönderim geçmişi temizlendi — tüm numaralar yeniden gönderilebilir');
  });
}

// ── CSV / Excel numara import ────────────────────────────────────────────
document.getElementById('cp-import-btn')?.addEventListener('click', async () => {
  if (globalCampaignRunning) { showToast('⚠️ Kampanya çalışırken import yapılamaz'); return; }

  let result;
  try { result = await ipcRenderer.invoke('import-numbers'); }
  catch (e) { showToast('❌ Import hatası: ' + e.message); return; }

  if (!result || result.reason === 'canceled') return;

  if (result.reason === 'xlsx_missing') {
    showToast('⚠️ Excel desteği için terminalde: npm install xlsx', 5000);
    return;
  }
  if (!result.ok) {
    showToast('❌ Dosya okunamadı: ' + (result.message || result.reason));
    return;
  }

  const { numbers } = result;
  if (!numbers.length) { showToast('⚠️ Dosyada geçerli numara bulunamadı'); return; }

  // Mevcut listeyle birleştir — tekrar olmaması için Set kullan
  const existing = new Set(
    (cpNumbers.value || '').split('\n').map(l => l.trim()).filter(Boolean)
  );
  numbers.forEach(n => existing.add(n));

  cpNumbers.value        = [...existing].join('\n');
  globalCampaignNumbers  = cpNumbers.value;
  saveGlobalNumbers();
  showToast(`✅ ${numbers.length} numara eklendi — toplam: ${existing.size}`);
});

// ── Kampanya raporu ──────────────────────────────────────────────────────
document.getElementById('cp-report-btn')?.addEventListener('click', showCampaignReport);
document.getElementById('campaign-report-close')?.addEventListener('click', closeCampaignReport);
makeOverlayCloseable(document.getElementById('campaign-report-overlay'), closeCampaignReport);

// ── Kampanya butonu (header) ─────────────────────────────────────────────
const campaignHeaderBtn = document.getElementById('campaign-btn');
if (campaignHeaderBtn) {
  campaignHeaderBtn.addEventListener('click', () => openCampaignPanel(null));
}

ctxCampaign.addEventListener('click', e => { e.stopPropagation(); hideContextMenu(); openCampaignPanel(contextMenuAccId); });
ctxRename  .addEventListener('click', e => { e.stopPropagation(); const id = contextMenuAccId; hideContextMenu(); if (id) showRenameModal(id); });
ctxDelete  .addEventListener('click', e => { e.stopPropagation(); const id = contextMenuAccId; hideContextMenu(); if (id) confirmDeleteModal(id); });

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeModal(); closeTmplModal(); hideContextMenu();
  closeWarmingPanel(); closeProxyModal(); closeConfirmDelete();
  closeSecurityModal(); closeAiGenModal(); closeCampaignReport();
  closeSettingsModal(); closeStatsPanel();
  // Yeni paneller
  document.getElementById('greet-modal-overlay')?.classList.remove('show');
  document.getElementById('howto-modal-overlay')?.classList.remove('show');
  document.getElementById('info-modal-overlay')?.classList.remove('show');
  document.getElementById('sec-block-overlay')?.classList.remove('show');
});

// ── Silme onay modalı ─────────────────────────────────────────────────────
document.getElementById('confirm-delete-cancel').addEventListener('click', closeConfirmDelete);
document.getElementById('confirm-delete-ok').addEventListener('click', () => {
  const id = pendingDeleteId;
  closeConfirmDelete();
  if (id) deleteAccount(id);
});
makeOverlayCloseable(document.getElementById('confirm-delete-overlay'), closeConfirmDelete);

// ── Proxy modal ───────────────────────────────────────────────────────────
document.getElementById('proxy-modal-cancel') .addEventListener('click', closeProxyModal);
document.getElementById('proxy-modal-confirm').addEventListener('click', confirmProxyModal);
document.getElementById('proxy-modal-clear')  .addEventListener('click', clearProxyModal);
makeOverlayCloseable(document.getElementById('proxy-modal-overlay'), closeProxyModal);

// ── Sidebar log toggle ────────────────────────────────────────────────────
const slogToggleBtn = document.getElementById('slog-toggle-btn');
if (slogToggleBtn) {
  slogToggleBtn.addEventListener('click', () => {
    slogOpen = !slogOpen;
    document.getElementById('slog-body')    ?.classList.toggle('open',    slogOpen);
    document.getElementById('slog-chevron') ?.classList.toggle('open',    slogOpen);
  });
}

// ── Güvenlik ayarları ─────────────────────────────────────────────────────
const securityBtn = document.getElementById('security-btn');
if (securityBtn) securityBtn.addEventListener('click', openSecurityModal);

document.getElementById('security-modal-close')?.addEventListener('click', closeSecurityModal);
makeOverlayCloseable(document.getElementById('security-modal-overlay'), closeSecurityModal);

const secSettleToggle = document.getElementById('sec-settle-toggle');
if (secSettleToggle) secSettleToggle.addEventListener('change', () => {
  securitySettings.settleCooldown = secSettleToggle.checked;
  saveSecuritySettings();
  showToast(secSettleToggle.checked ? `🛡️ İlk açılış cooldown'u açık` : `⚠️ İlk açılış cooldown'u kapalı`);
});

const secAddcdToggle = document.getElementById('sec-addcd-toggle');
if (secAddcdToggle) secAddcdToggle.addEventListener('change', () => {
  securitySettings.addCooldown = secAddcdToggle.checked;
  saveSecuritySettings();
  showToast(secAddcdToggle.checked ? `🛡️ Hesap ekleme cooldown'u açık` : `⚠️ Hesap ekleme cooldown'u kapalı`);
});

// ── Güçlendirme modu ──────────────────────────────────────────────────────
warmBtn.addEventListener('click', openWarmingPanel);
document.getElementById('warm-modal-close').addEventListener('click', closeWarmingPanel);
makeOverlayCloseable(warmModalOverlay, closeWarmingPanel);
document.getElementById('warm-start-btn').addEventListener('click', () => {
  if (warmingRunning) return;
  warmingPaused    = false;
  warmingRunning   = true;
  updateWarmingControls();
  updateStatsStrip();
  runWarmingLoop();
});
document.getElementById('warm-stop-btn').addEventListener('click', () => {
  warmingPaused  = false;
  warmingRunning = false;
  updateWarmingControls();
  setTimeout(updateStatsStrip, 300);
  logWarming('⏹ Güvenli durdurma isteği — mevcut mesaj tamamlanınca duracak…', 'log-wait');
});

// ── Güçlendirme Duraklat / Devam ───────────────────────────────────────────
document.getElementById('warm-pause-btn')?.addEventListener('click', () => {
  if (!warmingRunning) return;
  warmingPaused = !warmingPaused;
  updateWarmingControls();
  if (warmingPaused) {
    logWarming('⏸ Güçlendirme duraklatıldı — devam etmek için tekrar tıkla.', 'log-wait');
    showToast('⏸ Güçlendirme duraklatıldı');
  } else {
    logWarming('▶ Güçlendirme devam ediyor…', 'log-info');
    showToast('▶ Devam ediyor');
  }
});

// ── Zamanlı Güçlendirme Başlatma ───────────────────────────────────────────
document.getElementById('warm-schedule-btn')?.addEventListener('click', () => {
  const timeInput = document.getElementById('warm-scheduled-time');
  const infoEl    = document.getElementById('warm-scheduled-info');
  if (!timeInput || !infoEl) return;
  if (scheduledWarmingTimer !== null) {
    clearTimeout(scheduledWarmingTimer);
    scheduledWarmingTimer = null;
    timeInput.value = '';
    infoEl.textContent = '';
    const btn = document.getElementById('warm-schedule-btn');
    if (btn) { btn.textContent = '⏰ Ayarla'; btn.classList.remove('active'); }
    showToast('⏰ Zamanlı güçlendirme iptal edildi');
    return;
  }
  const val = timeInput.value;
  if (!val) { showToast('⚠️ Lütfen bir saat seçin'); return; }
  const [h, m] = val.split(':').map(Number);
  const target = new Date(); target.setHours(h, m, 0, 0);
  if (target <= new Date()) target.setDate(target.getDate() + 1);
  const msUntil = target - Date.now();
  scheduledWarmingTimer = setTimeout(() => {
    scheduledWarmingTimer = null;
    infoEl.textContent = '';
    const btn = document.getElementById('warm-schedule-btn');
    if (btn) { btn.textContent = '⏰ Ayarla'; btn.classList.remove('active'); }
    document.getElementById('warm-start-btn')?.click();
    sendSystemNotification('💪 Zamanlı Güçlendirme Başladı', `Saat ${val} güçlendirmesi başladı.`);
  }, msUntil);
  const fmtTarget = target.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  infoEl.textContent = `⏰ Güçlendirme ${fmtTarget}'de başlayacak`;
  const btn = document.getElementById('warm-schedule-btn');
  if (btn) { btn.textContent = '✕ İptal'; btn.classList.add('active'); }
  showToast(`⏰ Güçlendirme ${fmtTarget}'de başlayacak`);
});

// ── Güvenlik engel popup butonları ──────────────────────────────────────────
document.getElementById('sec-block-ok')?.addEventListener('click', closeSecurityBlock);
document.getElementById('sec-block-close-x')?.addEventListener('click', closeSecurityBlock);
document.getElementById('sec-block-settings')?.addEventListener('click', () => {
  closeSecurityBlock();
  document.getElementById('security-modal-overlay')?.classList.add('show');
});
makeOverlayCloseable(document.getElementById('sec-block-overlay'), closeSecurityBlock);

// ══════════════════════════════════════════════════════════════════════════
//  SİDEBAR GENİŞLİK AYARI — sürükle ile yeniden boyutlandır
// ══════════════════════════════════════════════════════════════════════════
(function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const handle  = document.getElementById('sidebar-resize-handle');
  if (!sidebar || !handle) return;

  const saved = localStorage.getItem('wa_sidebar_w');
  if (saved) {
    const w = parseInt(saved);
    if (w >= 180 && w <= 480) sidebar.style.width = w + 'px';
  }

  let dragging = false, startX = 0, startW = 0;

  // setPointerCapture → handle tüm pointer olaylarını alır, webview üzerinden geçse bile kopmuyor
  handle.addEventListener('pointerdown', e => {
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    startX   = e.clientX;
    startW   = sidebar.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const newW = Math.min(480, Math.max(180, startW + (e.clientX - startX)));
    sidebar.style.width = newW + 'px';
  });

  handle.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    localStorage.setItem('wa_sidebar_w', parseInt(sidebar.style.width));
  });
})();

// ── Aktivite logu yukarı resize ────────────────────────────────────────────
(function initSlogResize() {
  const handle  = document.getElementById('slog-resize-handle');
  const slogEl  = document.getElementById('sidebar-log');
  const slogBody = document.getElementById('slog-body');
  if (!handle || !slogEl || !slogBody) return;

  // Kayıtlı yüksekliği yükle
  const savedH = parseInt(localStorage.getItem('wa_slog_h') || '132');
  slogEl.style.setProperty('--slog-h', savedH + 'px');

  let dragging = false, startY = 0, startH = 0;

  // setPointerCapture → hızlı mouse hareketi webview üzerinden geçse bile kopmuyor
  handle.addEventListener('pointerdown', e => {
    if (!slogBody.classList.contains('open')) return; // sadece açıkken
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    startY   = e.clientY;
    startH   = slogBody.getBoundingClientRect().height || parseInt(localStorage.getItem('wa_slog_h') || '132');
    handle.classList.add('dragging');
    document.body.style.cursor     = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    const delta = startY - e.clientY; // yukarı sürükleme = pozitif delta
    const newH  = Math.min(400, Math.max(60, startH + delta));
    slogEl.style.setProperty('--slog-h', newH + 'px');
  });

  handle.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    const curH = parseFloat(getComputedStyle(slogEl).getPropertyValue('--slog-h')) || 132;
    localStorage.setItem('wa_slog_h', Math.round(curH));
  });
})();

// ── Hesap arama / filtre ────────────────────────────────────────────────────
const acctSearch = document.getElementById('acct-search');
if (acctSearch) {
  acctSearch.addEventListener('input', () => renderAccounts());
}

// ── Yazma hızı paneli toggle (nav-bar) ─────────────────────────────────────
const navTypingBtn  = document.getElementById('nav-typing-btn');
const typingPanel   = document.getElementById('typing-panel');
if (navTypingBtn && typingPanel) {
  navTypingBtn.addEventListener('click', () => {
    const isOpen = typingPanel.classList.toggle('open');
    navTypingBtn.classList.toggle('active', isOpen);
  });
}

// ── Ayarlar modal ──────────────────────────────────────────────────────────
document.getElementById('nav-settings-btn')?.addEventListener('click', openSettingsModal);
document.getElementById('settings-modal-close-x')?.addEventListener('click', closeSettingsModal);
document.getElementById('settings-modal-close')?.addEventListener('click', closeSettingsModal);
makeOverlayCloseable(document.getElementById('settings-modal-overlay'), closeSettingsModal);
document.getElementById('settings-modal-close-x')?.addEventListener('click', closeSettingsModal);

// Tema toggle
document.getElementById('st-theme')?.addEventListener('change', e => {
  darkTheme = e.target.checked; applyTheme();
  showToast(darkTheme ? '🌙 Karanlık tema' : '☀️ Açık tema');
});
// Ses toggle
document.getElementById('st-sound')?.addEventListener('change', e => {
  soundEnabled = e.target.checked; applySound();
  showToast(soundEnabled ? '🔔 Ses açık' : '🔕 Ses kapalı');
});
// Yazma hızı slider
document.getElementById('st-typing-slider')?.addEventListener('input', e => {
  typingSpeed = parseInt(e.target.value);
  applyTypingSpeed();
  const valEl = document.getElementById('st-typing-val');
  if (valEl) valEl.textContent = TYPING_SPEED_LABELS[typingSpeed - 1];
  showToast(`⌨️ Yazma hızı: ${TYPING_SPEED_LABELS[typingSpeed - 1]}`);
});
// Güvenlik toggles
document.getElementById('st-settle')?.addEventListener('change', e => {
  securitySettings.settleCooldown = e.target.checked;
  saveSecuritySettings();
  showToast(e.target.checked ? '🛡️ İlk açılış cooldown açık' : '⚠️ İlk açılış cooldown kapalı');
});
document.getElementById('st-addcd')?.addEventListener('change', e => {
  securitySettings.addCooldown = e.target.checked;
  saveSecuritySettings();
  showToast(e.target.checked ? '🛡️ Hesap ekleme cooldown açık' : '⚠️ Hesap ekleme cooldown kapalı');
});
// İç ısınma aralığı
document.getElementById('st-warm-interval')?.addEventListener('change', e => {
  const v = Math.max(1, Math.min(10, parseInt(e.target.value) || 2));
  warmInterval = v; e.target.value = v;
  localStorage.setItem('wa_warm_interval', v.toString());
  showToast(`🔥 İç ısınma: her ${v} mesajda bir`);
});

// ── İstatistik paneli ──────────────────────────────────────────────────────
document.getElementById('nav-stats-btn')?.addEventListener('click', openStatsPanel);
document.getElementById('stats-modal-close-x')?.addEventListener('click', closeStatsPanel);
document.getElementById('stats-modal-close')?.addEventListener('click', closeStatsPanel);
makeOverlayCloseable(document.getElementById('stats-modal-overlay'), closeStatsPanel);

// ── Nasıl Kullanılır? modal ───────────────────────────────────────────────
(function initHowtoModal() {
  const overlay = document.getElementById('howto-modal-overlay');
  const openBtn = document.getElementById('nav-howto-btn');
  const closeX  = document.getElementById('howto-modal-close-x');
  const closeBtn= document.getElementById('howto-modal-close');
  if (!overlay) return;
  const open  = () => overlay.classList.add('show');
  const close = () => overlay.classList.remove('show');
  openBtn?.addEventListener('click', open);
  closeX?.addEventListener('click', close);
  closeBtn?.addEventListener('click', close);
  makeOverlayCloseable(overlay, close);
})();

// ── İnfo / Özellik Rehberi modal ─────────────────────────────────────────
(function initInfoModal() {
  const overlay = document.getElementById('info-modal-overlay');
  const openBtn = document.getElementById('nav-info-btn');
  const closeX  = document.getElementById('info-modal-close-x');
  const closeBtn= document.getElementById('info-modal-close');
  if (!overlay) return;
  const open  = () => overlay.classList.add('show');
  const close = () => overlay.classList.remove('show');
  openBtn?.addEventListener('click', open);
  closeX?.addEventListener('click', close);
  closeBtn?.addEventListener('click', close);
  makeOverlayCloseable(overlay, close);
})();

// ── Kara liste temizle ────────────────────────────────────────────────────
document.getElementById('bl-clear-all-btn')?.addEventListener('click', () => {
  if (!confirm('Kara listedeki tüm numaralar silinsin mi?')) return;
  blacklistedNumbers.clear();
  saveBlacklist();
  renderBlacklistPanel();
  showToast('🗑️ Kara liste temizlendi');
});

// ── Kampanya tab'ı seçilince kara listeyi render et ────────────────────────
document.querySelectorAll('.cp-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'blacklist') renderBlacklistPanel();
  });
});

// ── Zamanlı kampanya başlatma ─────────────────────────────────────────────
document.getElementById('cp-schedule-btn')?.addEventListener('click', () => {
  const timeInput = document.getElementById('cp-scheduled-time');
  const infoEl    = document.getElementById('cp-scheduled-info');
  if (!timeInput || !infoEl) return;
  // İptal: zamanlayıcı varsa iptal et
  if (scheduledCampaignTimer !== null) {
    clearTimeout(scheduledCampaignTimer);
    scheduledCampaignTimer = null;
    timeInput.value = '';
    infoEl.textContent = '';
    const btn = document.getElementById('cp-schedule-btn');
    if (btn) { btn.textContent = '⏰ Ayarla'; btn.classList.remove('active'); }
    showToast('⏰ Zamanlı başlatma iptal edildi');
    return;
  }
  const val = timeInput.value;
  if (!val) { showToast('⚠️ Lütfen bir saat seçin'); return; }
  const [h, m] = val.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1); // yarına planla
  const msUntil = target - now;
  scheduledCampaignTimer = setTimeout(() => {
    scheduledCampaignTimer = null;
    infoEl.textContent = '';
    const btn = document.getElementById('cp-schedule-btn');
    if (btn) { btn.textContent = '⏰ Ayarla'; btn.classList.remove('active'); }
    // Kampanyayı başlat
    document.getElementById('cp-start-btn')?.click();
    sendSystemNotification('▶️ Zamanlı Kampanya Başlatıldı', `Saat ${val} kampanyası başladı.`);
  }, msUntil);
  const fmtTarget = target.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  infoEl.textContent = `⏰ Kampanya ${fmtTarget}'de başlayacak`;
  const btn = document.getElementById('cp-schedule-btn');
  if (btn) { btn.textContent = '✕ İptal'; btn.classList.add('active'); }
  showToast(`⏰ Kampanya ${fmtTarget}'de başlayacak`);
});

// ── OLED tema toggle ──────────────────────────────────────────────────────
document.getElementById('st-oled')?.addEventListener('change', e => {
  oledTheme = e.target.checked;
  applyOledTheme();
  showToast(oledTheme ? '🖤 OLED tema açık' : '🖤 OLED tema kapalı');
});

// ── Masaüstü bildirim toggle ──────────────────────────────────────────────
document.getElementById('st-desktop-notif')?.addEventListener('change', e => {
  desktopNotifEnabled = e.target.checked;
  localStorage.setItem('wa_desktop_notif', desktopNotifEnabled ? '1' : '0');
  showToast(desktopNotifEnabled ? '🔔 Masaüstü bildirimler açık' : '🔕 Masaüstü bildirimler kapalı');
  if (desktopNotifEnabled) {
    // İzin iste
    try { Notification.requestPermission(); } catch {}
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  BAŞLATMA
// ══════════════════════════════════════════════════════════════════════════
loadState();
applyTheme();
applyOledTheme();
applySound();
applyTypingSpeed();
applySecuritySettings();
renderAccounts();

// Versiyon etiketini package.json'dan çek
ipcRenderer.invoke('get-app-version').then(v => {
  const el = document.getElementById('app-version');
  if (el) el.textContent = 'v' + v;
}).catch(() => {});

// ── Otomatik güncelleme bildirimleri ──
ipcRenderer.on('update-available', () => {
  showToast('🔄 Yeni güncelleme indiriliyor…', 4000);
});
ipcRenderer.on('update-downloaded', () => {
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;padding:14px 24px;
    border-radius:12px;font-size:14px;font-weight:600;z-index:99999;display:flex;
    align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);`;
  toast.innerHTML = `<span>✅ Güncelleme hazır!</span>
    <button onclick="ipcRenderer.invoke('install-update')" style="background:rgba(255,255,255,0.2);
    border:none;color:#fff;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;">
    Şimdi Yükle</button>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,0.7);
    cursor:pointer;font-size:18px;padding:0 4px;">×</button>`;
  document.body.appendChild(toast);
});

Promise.all(accounts.filter(a => a.proxies && a.proxies.length).map(a => applyAccountProxy(a.id))).catch(() => {});

if (accounts.length > 0) {
  // Aktif (çıkış yapmamış) hesaplar — sadece bunlar için webview aç
  const activeAccounts = accounts.filter(a => !loggedOutAccounts.has(a.id));
  const firstActive    = activeAccounts[0] || accounts[0]; // hepsi çıkış yaptıysa ilkini göster

  switchToAccount(firstActive.id);

  // Çıkış yapmamış diğer hesapları staggered yükle
  let loadIdx = 0;
  accounts.slice(1).forEach(a => {
    if (loggedOutAccounts.has(a.id)) return; // çıkış yapılmış → atla
    const delay = (++loadIdx) * 4000;
    setTimeout(() => {
      if (!document.getElementById('wv_' + a.id)) getOrCreateWebview(a);
    }, delay);
  });
} else {
  welcomeScreen.classList.remove('hidden');
}
