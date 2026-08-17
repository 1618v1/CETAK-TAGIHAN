/**
 * SYNC-SUPABASE.JS (BARU) — Cloud sync untuk data SALES / Bank Data Penjualan
 * ============================================================================
 * File ini DITULIS ULANG DARI NOL (bukan pemulihan file lama). Kredensial
 * Supabase TIDAK ada di sini sama sekali — semua diambil dari
 * window.GAMAS_SUPABASE_CONFIG (lihat gamas-supabase-config.js), jadi file
 * ini 100% aman dipindah ke akun/project Supabase manapun.
 *
 * Cara kerja singkat:
 *  - Setiap baris sales diberi `_uuid` (stabil, unik lintas perangkat) supaya
 *    2 device yang sama-sama offline lalu online lagi TIDAK bentrok id-nya
 *    (beda dengan id auto-increment IndexedDB yang cuma unik per-browser).
 *  - db.sales.syncRows(...) (fungsi ASLI, sudah ada di HTML utama, murni
 *    lokal) DIBUNGKUS di sini: setelah IndexedDB lokal berhasil ditulis,
 *    seluruh baris sales didorong (push) ke tabel `gamas_sales` di Supabase.
 *  - Saat file ini dimuat / dipanggil ulang, ia menarik (pull) data dari
 *    Supabase dan menulisnya ke IndexedDB lokal, lalu (kalau ada yang baru)
 *    memicu badge "Data baru masuk" yang sudah ada di UI.
 *  - Menghormati saklar Online/Offline (localStorage 'gm2026_sync_mode'):
 *    kalau mode 'offline', semua panggilan ke Supabase dilewati.
 *
 * PENTING — Ini implementasi baru, BUKAN pemulihan exact dari file lama
 * (file lama tidak tersedia). Sudah disesuaikan dengan struktur data & nama
 * fungsi yang benar-benar ada di HTML (LocalTable, db.sales, salesData,
 * tampilkanNotifDataBaru, dst), tapi tetap disarankan DIUJI dulu sebelum
 * dipakai produksi penuh — terutama uji dari 2 perangkat berbeda.
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
        // fallback sederhana kalau browser lama
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
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
                if (error) console.warn('[GAMAS] Gagal push sales batch:', error.message);
            } catch (e) { console.warn('[GAMAS] Gagal push sales batch:', e); }
        }
        // Hapus di server baris yang sudah tidak ada lagi secara lokal
        try {
            const localUuids = rows.map(function (r) { return r._uuid; });
            const { data: remoteRows, error: selErr } = await sb.from(TABLE).select('uuid');
            if (!selErr && remoteRows) {
                const toDelete = remoteRows
                    .map(function (r) { return r.uuid; })
                    .filter(function (u) { return localUuids.indexOf(u) === -1; });
                if (toDelete.length) {
                    await sb.from(TABLE).delete().in('uuid', toDelete);
                }
            }
        } catch (e) { console.warn('[GAMAS] Gagal bersihkan sales terhapus:', e); }
    }

    async function pullSales() {
        const sb = client();
        if (!sb || isOfflineMode()) return false;
        try {
            const { data: remoteRows, error } = await sb.from(TABLE).select('uuid,row_data,updated_at');
            if (error) throw error;
            if (!remoteRows) return false;

            const localRows = await db.sales.toArray();
            const localByUuid = {};
            localRows.forEach(function (r) { if (r._uuid) localByUuid[r._uuid] = r; });

            let changed = false;
            for (const remote of remoteRows) {
                const local = localByUuid[remote.uuid];
                const remoteRow = Object.assign({}, remote.row_data, { _uuid: remote.uuid });
                if (!local) {
                    await db.sales.add(remoteRow);
                    changed = true;
                } else if (JSON.stringify(Object.assign({}, local, { id: undefined })) !==
                    JSON.stringify(Object.assign({}, remoteRow, { id: undefined }))) {
                    await db.sales.update(local.id, remoteRow);
                    changed = true;
                }
            }

            // Hapus lokal baris yang sudah dihapus di server oleh perangkat lain
            const remoteUuids = remoteRows.map(function (r) { return r.uuid; });
            for (const local of localRows) {
                if (local._uuid && remoteUuids.indexOf(local._uuid) === -1) {
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
        // Pastikan setiap baris punya _uuid stabil SEBELUM ditulis ke IndexedDB,
        // supaya id yang sama dipakai baik di lokal maupun di Supabase.
        currentRows.forEach(function (row) {
            if (!row._uuid) row._uuid = uuid();
        });
        const result = await _origSyncRows(currentRows, docIdMap, snapshotMap);
        // Dorong ke cloud tanpa memblokir UI lebih lama dari perlu; tetap
        // di-await di sini supaya pemanggil (saveSalesData) tahu prosesnya
        // selesai kalau mereka mau menunggu, tapi kegagalan cloud TIDAK
        // menggagalkan penyimpanan lokal yang sudah berhasil di atas.
        try {
            const freshRows = await db.sales.toArray();
            await pushAllSales(freshRows);
        } catch (e) { console.warn('[GAMAS] Push sales ke cloud gagal (data lokal tetap aman):', e); }
        return result;
    };

    async function runFullSync(silent) {
        if (isOfflineMode()) return { skipped: true };
        const changed = await pullSales();
        if (changed && !silent && typeof tampilkanNotifDataBaru === 'function') {
            tampilkanNotifDataBaru('both');
        }
        return { changed: changed };
    }

    window.gamasSalesSync = { runFullSync: runFullSync, pullSales: pullSales, pushAllSales: pushAllSales };

    // Cek pembaruan di latar belakang begitu halaman dibuka (tidak memblokir
    // render awal yang tetap memakai data lokal seperti biasa).
    if (!isOfflineMode()) {
        setTimeout(function () {
            pullSales().then(function (changed) {
                if (changed && typeof tampilkanNotifDataBaru === 'function') {
                    tampilkanNotifDataBaru('both');
                }
            });
        }, 1500);
    }
})();
