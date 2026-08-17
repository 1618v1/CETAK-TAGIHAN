// ================================================================
// SERVICE WORKER — GAMAS 2026
// Tujuan: (1) memenuhi syarat PWA supaya browser memunculkan ikon
// "Instal Aplikasi", dan (2) membuat app bisa tetap dibuka meski
// sedang OFFLINE (mode hybrid: online kalau ada internet, tetap
// bisa jalan kalau tidak ada).
//
// PENTING: setiap kali kamu mengubah file-file di daftar
// PRECACHE_URLS di bawah (terutama index.html), NAIKKAN nomor versi
// di CACHE_NAME supaya browser tahu ada versi baru dan mau
// menggantinya. Kalau versi tidak dinaikkan, browser akan terus
// memakai cache lama.
// ================================================================
const CACHE_VERSION = 'v1';
const CACHE_NAME = 'gamas2026-cache-' + CACHE_VERSION;

// File "app shell" yang wajib bisa dibuka walau tanpa internet.
// Path pakai "./" relatif supaya cocok dengan lokasi GitHub Pages
// (https://1618v1.github.io/CETAK-TAGIHAN/).
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './gamas-supabase-config.js',
  './sync-supabase.js',
  './sync-cash-income-supabase.js',
  './sync-pengeluaran-supabase.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Pakai allSettled: kalau salah satu file gagal di-cache (mis.
      // file CDN eksternal kena CORS), instalasi tidak batal total.
      return Promise.allSettled(
        PRECACHE_URLS.map(function (url) {
          return cache.add(url);
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name.startsWith('gamas2026-cache-') && name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Terima perintah "SKIP_WAITING" dari halaman (index.html sudah
// mengirim ini otomatis begitu ada versi baru terdeteksi).
self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return; // jangan campuri POST/PUT dll (mis. ke Supabase)

  const url = new URL(req.url);

  // Halaman utama (navigasi): coba internet dulu supaya user selalu
  // dapat versi terbaru saat online; kalau gagal/offline, ambil dari
  // cache supaya app tetap terbuka.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          caches.open(CACHE_NAME).then(function (cache) { cache.put('./index.html', res.clone()); });
          return res;
        })
        .catch(function () {
          return caches.match('./index.html').then(function (cached) {
            return cached || caches.match('./');
          });
        })
    );
    return;
  }

  // Request ke Supabase (data online) JANGAN di-cache — biarkan lewat
  // langsung ke jaringan, kalau offline biar gagal secara normal dan
  // ditangani oleh logika sinkronisasi di dalam app.
  if (url.hostname.includes('supabase.co')) {
    return;
  }

  // Aset lain (JS/CSS/font/ikon/CDN): cache-first, lalu perbarui cache
  // di belakang layar kalau online (stale-while-revalidate).
  event.respondWith(
    caches.match(req).then(function (cached) {
      const networkFetch = fetch(req).then(function (res) {
        if (res && res.ok) {
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, res.clone()); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});
