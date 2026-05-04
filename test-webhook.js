// LemonSqueezy Webhook Test Script
// Çalıştır: node test-webhook.js

const crypto = require('crypto');
const https  = require('https');

const SECRET = 'sndg_wh_2026_xK9mPqR7vL3nZjT5';
const HOST   = 'lswebhook-i3q4co3oiq-uc.a.run.app';

const body = {
  data: {
    attributes: {
      user_email: 'test-webhook@sendigo.app',
      identifier: 'TEST-ORDER-001',
      first_order_item: {
        variant_name: 'Pro Plan'
      }
    }
  }
};

const bodyStr = JSON.stringify(body);
const sig     = crypto.createHmac('sha256', SECRET).update(bodyStr).digest('hex');

console.log('📤 Webhook isteği gönderiliyor...');

const req = https.request(
  {
    hostname: HOST,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-event-name': 'order_created',
      'x-signature':  sig,
    }
  },
  (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      console.log('Response:', data);
      if (res.statusCode === 200) {
        console.log('\n✅ Webhook başarıyla çalıştı!');
        console.log('Firebase Console → Firestore → licenses koleksiyonunda');
        console.log('test-webhook@sendigo.app için PRO lisansı oluşturulmuş olmalı.');
      } else {
        console.log('\n❌ Hata:', res.statusCode);
      }
    });
  }
);

req.on('error', e => console.error('İstek hatası:', e.message));
req.write(bodyStr);
req.end();
