const { setGlobalOptions, params } = require('firebase-functions');
const { onRequest }                = require('firebase-functions/https');
const { defineSecret }             = require('firebase-functions/params');
const { initializeApp }            = require('firebase-admin/app');
const { getFirestore }             = require('firebase-admin/firestore');
const crypto                       = require('crypto');

const LS_WEBHOOK_SECRET = defineSecret('LS_WEBHOOK_SECRET');

initializeApp();
setGlobalOptions({ maxInstances: 10, region: 'us-central1' });

const db = getFirestore();

// Plan → süre (gün)
const PLAN_DAYS = { starter: 7, pro: 30, business: 30 };

// Lisans key üret
function generateKey(plan) {
  const prefix = { starter: 'STRT', pro: 'PRO0', business: 'BIZ0' }[plan] || 'SNDG';
  const rand = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SNDG-${prefix}-${rand()}-${rand()}`;
}

// ── Yardımcı: email ile lisans doc'unu bul
async function findLicenseByEmail(email) {
  const snap = await db.collection('licenses').where('email', '==', email).orderBy('createdAt', 'desc').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// LemonSqueezy Webhook
exports.lsWebhook = onRequest({ secrets: [LS_WEBHOOK_SECRET], invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  // İmza doğrula
  const secret = LS_WEBHOOK_SECRET.value();
  const sig    = req.headers['x-signature'];
  const hmac   = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
  if (sig !== hmac) { res.status(401).send('Invalid signature'); return; }

  const event = req.headers['x-event-name'];
  const data  = req.body?.data?.attributes;
  if (!data) { res.status(200).send('ok'); return; }

  try {
    // ── 1) Yeni sipariş (ilk satın alma) ──────────────────────────────
    if (event === 'order_created') {
      const email       = data.user_email;
      const variantName = (data.first_order_item?.variant_name || '').toLowerCase();

      let plan = 'starter';
      if (variantName.includes('pro'))      plan = 'pro';
      if (variantName.includes('business')) plan = 'business';

      const days      = PLAN_DAYS[plan] || 7;
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      const createdAt = new Date().toISOString();
      const license   = generateKey(plan);

      // Varsa eski lisansı sil
      const existing = await findLicenseByEmail(email);
      if (existing) await db.collection('licenses').doc(existing.id).delete();

      // Kullanıcı dokümanını güncelle
      const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!usersSnap.empty) await usersSnap.docs[0].ref.update({ plan, license, expiresAt });

      // Yeni lisansı yaz
      await db.collection('licenses').doc(license).set({
        email, plan, createdAt, expiresAt,
        orderId: data.identifier || '',
        status: 'active',
      });
      console.log(`✅ order_created: ${email} → ${plan} → ${license}`);
    }

    // ── 2) Abonelik yenilemesi (ödeme başarılı) ───────────────────────
    else if (event === 'subscription_payment_success') {
      const email       = data.user_email;
      const variantName = (data.variant_name || '').toLowerCase();

      let plan = 'starter';
      if (variantName.includes('pro'))      plan = 'pro';
      if (variantName.includes('business')) plan = 'business';

      const days      = PLAN_DAYS[plan] || 30;
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

      // Mevcut lisansı bul ve tarihini uzat
      const existing = await findLicenseByEmail(email);
      if (existing) {
        await db.collection('licenses').doc(existing.id).update({ expiresAt, plan, status: 'active' });
        const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!usersSnap.empty) await usersSnap.docs[0].ref.update({ plan, expiresAt });
        console.log(`✅ renewal: ${email} → ${plan} → +${days}gün`);
      }
    }

    // ── 3) Plan yükseltme / düşürme ───────────────────────────────────
    else if (event === 'subscription_updated') {
      const email       = data.user_email;
      const variantName = (data.variant_name || '').toLowerCase();
      const subStatus   = data.status || '';

      if (subStatus === 'cancelled' || subStatus === 'expired') {
        // İptal → lisansı devre dışı bırak
        const existing = await findLicenseByEmail(email);
        if (existing) {
          await db.collection('licenses').doc(existing.id).update({ status: 'cancelled' });
          const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
          if (!usersSnap.empty) await usersSnap.docs[0].ref.update({ plan: 'trial' });
          console.log(`⛔ subscription_updated cancelled: ${email}`);
        }
      } else {
        // Plan değişikliği
        let plan = 'starter';
        if (variantName.includes('pro'))      plan = 'pro';
        if (variantName.includes('business')) plan = 'business';

        const existing = await findLicenseByEmail(email);
        if (existing) {
          await db.collection('licenses').doc(existing.id).update({ plan, status: 'active' });
          const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
          if (!usersSnap.empty) await usersSnap.docs[0].ref.update({ plan });
          console.log(`🔄 subscription_updated: ${email} → ${plan}`);
        }
      }
    }

    // ── 4) Abonelik iptal ─────────────────────────────────────────────
    else if (event === 'subscription_cancelled') {
      const email = data.user_email;
      const existing = await findLicenseByEmail(email);
      if (existing) {
        await db.collection('licenses').doc(existing.id).update({ status: 'cancelled' });
        const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!usersSnap.empty) await usersSnap.docs[0].ref.update({ plan: 'trial' });
        console.log(`⛔ subscription_cancelled: ${email}`);
      }
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('Webhook hatası:', e);
    res.status(500).send('error');
  }
});
