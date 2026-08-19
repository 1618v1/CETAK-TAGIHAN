/**
 * SYNC-SUPABASE.JS — Cloud sync untuk data SALES / Bank Data Penjualan
 * ============================================================================
 * Kredensial Supabase TIDAK ada di sini sama sekali — semua diambil dari
 * window.GAMAS_SUPABASE_CONFIG (lihat gamas-supabase-config.js), jadi file
 * ini 100% aman dipindah ke akun/project Supabase manapun.
 *
 * Cara kerja singkat:
 *  - Setiap baris sales diberi `_uuid` (stabil, unik lintas perangkat) supaya
 *    2 device yang sama-sama offline lalu online lagi TIDAK bentrok id-nya.
 *  - db.sales.syncRows(...) (fungsi ASLI, murni lokal) DIBUNGKUS di sini:
 *    setelah IndexedDB lokal berhasil ditulis, seluruh baris sales didorong
 *    (push) ke tabel `gamas_sales` di Supabase.
 *  - Saat file ini dimuat / dipanggil ulang, ia menarik (pull) data dari
 *    Supabase dan menulisnya ke IndexedDB lokal.
 *  - Menghormati saklar Online/Offline (localStorage 'gm2026_sync_mode').
 *
 * ------------------------------------------------------------------------
 * PERBAIKAN (v2) — mencegah data baru "hilang ketimpa" data lama:
 * ------------------------------------------------------------------------
 * Sebelumnya push ke Supabase tidak sepenuhnya "aman" terhadap refresh
 * mendadak: kalau proses push per-baris terputus di tengah jalan, baris
 * yang belum sempat terkirim bisa ketinggalan, lalu logika "hapus di server
 * baris yang sudah tidak ada di lokal" atau pull berikutnya bisa membuat
 * data lokal-vs-server tidak sinkron.
 *
 * Sekarang setiap baris lokal punya penanda `_dirty`:
 *   - `_dirty = true`  -> baris ini belum dikonfirmasi tersimpan di server
 *   - `_dirty = false` -> sudah dikonfirmasi tersimpan di server
 * Sebelum pull otomatis jalan saat halaman dibuka, sistem coba push ulang
 * dulu semua baris yang masih dirty. Pull tidak akan menimpa baris yang
 * masih dirty (perubahan lokal yang belum sinkron selalu menang).
 */
(function () {
    'use strict';

    const TABLE = 'gamas_sales';

    function isOfflineMode() {
        try { return localStorage.getItem('gm2026_sync_mode') === 'offline'; } catch (e) { return false; }
    }

    function getConfig() {
        const cfg = window.GAMAS_SUPABASE_CONFIG;
        if (!cfg || !cfg.url || !cfg.anonKey || cfg.url.indexOf('YOUR-PROJECT-REF') !== -1) return null;
        return cfg;
    }

    let _client = null;
    function client() {
        if (_client) return _client;
        const cfg = getConfig();
        if (!cfg || !window.supabase || typeof window.supabase.createClient !== 'function') return null;
        _client = window.supabase.createClient(cfg.url, cfg.anonKey);
        return _client;
    }

    function uuid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // ------------------------------------------------------------------
    // PERBAIKAN PENTING: Supabase/PostgREST membatasi HASIL SELECT ke
    // maksimal 1000 baris per request kalau tidak eksplisit di-.range().
    // Tabel gamas_sales sudah > 20.000 baris, jadi select() tanpa paging
    // dulu hanya menarik ~1000 baris PERTAMA -- lalu kode di bawah yang
    // "hapus baris lokal yang tidak ada di server" akan menganggap SEMUA
    // baris lain (yang sebenarnya ada, cuma belum ketarik) sebagai baris
    // yang sudah dihapus, dan MENGHAPUSNYA dari IndexedDB lokal (bahkan
    // berisiko balik menghapusnya juga dari server lewat proses push
    // berikutnya). Fungsi ini menarik SELURUH baris dengan looping per
    // halaman (page) sampai benar-benar habis.
    // ------------------------------------------------------------------
    const PAGE_SIZE = 1000;
    async function fetchAllRows(sb, columns) {
        let all = [];
        let from = 0;
        while (true) {
            const to = from + PAGE_SIZE - 1;
            const { data, error } = await sb.from(TABLE).select(columns).range(from, to);
            if (error) throw error;
            if (!data || !data.length) break;
            all = all.concat(data);
            if (data.length < PAGE_SIZE) break; // halaman terakhir
            from += PAGE_SIZE;
        }
        return all;
    }

    // Baris yang berhasil kekirim ke server dicatat di sini (per _uuid) agar
    // bisa ditandai "clean" di IndexedDB lokal setelah push sukses.
    async function markRowsClean(uuids) {
        if (!uuids.length) return;
        try {
            const rows = await db.sales.toArray();
            for (const row of rows) {
                if (row._uuid && uuids.indexOf(row._uuid) !== -1 && row._dirty) {
                    await db.sales.update(row.id, { _dirty: false });
                }
            }
        } catch (e) { /* tidak fatal, coba lagi di sync berikutnya */ }
    }

    async function pushAllSales(rows) {
        const sb = client();
        if (!sb || isOfflineMode()) return;
        if (!rows.length) return;
        const payload = rows.map(function (row) {
            return {
                uuid: row._uuid,
                row_data: row,
                updated_at: new Date().toISOString()
            };
        });
        const CHUNK = 300;
        for (let i = 0; i < payload.length; i += CHUNK) {
            const batch = payload.slice(i, i + CHUNK);
            try {
                const { error } = await sb.from(TABLE).upsert(batch, { onConflict: 'uuid' });
                if (error) { console.warn('[GAMAS] Gagal push sales batch:', error.message); continue; }
                await markRowsClean(batch.map(function (b) { return b.uuid; }));
            } catch (e) { console.warn('[GAMAS] Gagal push sales batch:', e); }
        }
        // Hapus di server baris yang sudah tidak ada lagi secara lokal
        // (WAJIB pakai fetchAllRows -- select() biasa kepotong 1000 baris,
        // yang kalau dipakai di sini bisa salah anggap ribuan baris valid
        // sebagai "sudah tidak ada lokal" lalu ikut terhapus dari server).
        try {
            const localUuids = rows.map(function (r) { return r._uuid; });
            const remoteRows = await fetchAllRows(sb, 'uuid');
            const toDelete = remoteRows
                .map(function (r) { return r.uuid; })
                .filter(function (u) { return localUuids.indexOf(u) === -1; });
            if (toDelete.length) {
                await sb.from(TABLE).delete().in('uuid', toDelete);
            }
        } catch (e) { console.warn('[GAMAS] Gagal bersihkan sales terhapus:', e); }
    }

    // Coba push ulang semua baris yang masih ditandai dirty (mis. push
    // sebelumnya terputus karena refresh) -- dipanggil sebelum pull jalan.
    async function flushPendingPushes() {
        if (isOfflineMode() || !client()) return;
        try {
            const rows = await db.sales.toArray();
            const pending = rows.filter(function (r) { return r._dirty; });
            if (pending.length) await pushAllSales(pending);
        } catch (e) { console.warn('[GAMAS] Gagal flush pending pushes sales:', e); }
    }

    async function pullSales() {
        const sb = client();
        if (!sb || isOfflineMode()) return false;
        try {
            const remoteRows = await fetchAllRows(sb, 'uuid,row_data,updated_at');
            if (!remoteRows) return false;

            const localRows = await db.sales.toArray();
            const localByUuid = {};
            localRows.forEach(function (r) { if (r._uuid) localByUuid[r._uuid] = r; });

            let changed = false;
            for (const remote of remoteRows) {
                const local = localByUuid[remote.uuid];

                // JANGAN timpa baris yang masih ada perubahan lokal belum
                // ke-push -- data lokal yang belum sinkron selalu menang.
                if (local && local._dirty) continue;

                const remoteRow = Object.assign({}, remote.row_data, { _uuid: remote.uuid, _dirty: false });
                if (!local) {
                    await db.sales.add(remoteRow);
                    changed = true;
                } else if (JSON.stringify(Object.assign({}, local, { id: undefined, _dirty: undefined })) !==
                    JSON.stringify(Object.assign({}, remoteRow, { id: undefined, _dirty: undefined }))) {
                    await db.sales.update(local.id, remoteRow);
                    changed = true;
                }
            }

            // Hapus lokal baris yang sudah dihapus di server oleh perangkat lain
            // (kecuali baris lokal itu sendiri masih dirty / belum sinkron).
            const remoteUuids = remoteRows.map(function (r) { return r.uuid; });
            for (const local of localRows) {
                if (local._uuid && !local._dirty && remoteUuids.indexOf(local._uuid) === -1) {
                    await db.sales.delete(local.id);
                    changed = true;
                }
            }
            return changed;
        } catch (e) { console.warn('[GAMAS] Gagal pull sales:', e); return false; }
    }

    // --- Bungkus syncRows ASLI (murni lokal) supaya juga push ke cloud ---
    const _origSyncRows = db.sales.syncRows.bind(db.sales);
    db.sales.syncRows = async function (currentRows, docIdMap, snapshotMap) {
        // Pastikan setiap baris punya _uuid stabil, dan tandai dirty=true
        // SEBELUM ditulis ke IndexedDB, supaya kalau halaman di-refresh
        // sebelum push selesai, baris ini tetap dikenali "belum sinkron"
        // dan tidak akan ketimpa data lama saat pull berikutnya.
        currentRows.forEach(function (row) {
            if (!row._uuid) row._uuid = uuid();
            row._dirty = true;
        });
        const result = await _origSyncRows(currentRows, docIdMap, snapshotMap);
        // Push DITUNGGU di sini supaya kalau user langsung refresh setelah
        // simpan, data sudah (atau sedang beneran dicoba) tersimpan di
        // server -- kegagalan cloud TIDAK menggagalkan penyimpanan lokal
        // yang sudah berhasil di atas, baris akan dicoba lagi sync berikutnya.
        try {
            const freshRows = await db.sales.toArray();
            await pushAllSales(freshRows);
        } catch (e) { console.warn('[GAMAS] Push sales ke cloud gagal (data lokal tetap aman):', e); }
        return result;
    };

    async function runFullSync(silent) {
        if (isOfflineMode()) return { skipped: true };
        await flushPendingPushes();
        const changed = await pullSales();
        if (changed && !silent && typeof tampilkanNotifDataBaru === 'function') {
            tampilkanNotifDataBaru('both');
        }
        return { changed: changed };
    }

    window.gamasSalesSync = { runFullSync: runFullSync, pullSales: pullSales, pushAllSales: pushAllSales, flushPendingPushes: flushPendingPushes };

    // Cek pembaruan di latar belakang begitu halaman dibuka (tidak memblokir
    // render awal yang tetap memakai data lokal seperti biasa). Push dulu
    // baris yang masih dirty sebelum menarik data server.
    if (!isOfflineMode()) {
        setTimeout(function () {
            flushPendingPushes().then(function () {
                return pullSales();
            }).then(function (changed) {
                if (changed && typeof tampilkanNotifDataBaru === 'function') {
                    tampilkanNotifDataBaru('both');
                }
            });
        }, 1500);
    }
})();