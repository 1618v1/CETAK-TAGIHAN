/**
 * SYNC-PENGELUARAN-SUPABASE.JS (BARU) — Cloud sync untuk data Pengeluaran
 * ============================================================================
 * Ditulis ulang dari nol, pola persis sama seperti sync-cash-income-supabase.js
 * karena struktur lokalnya identik: 1 baris per bulan di IndexedDB store
 * 'pengeluaran' (lihat savePengeluaranData() di HTML: where('bulan').equals()
 * lalu update-atau-add). Kredensial dari window.GAMAS_SUPABASE_CONFIG saja,
 * tidak ada yang terikat akun.
 *
 * Tidak ada tombol "Sinkronkan Data" khusus pengeluaran di HTML saat ini,
 * jadi selain window.gamasPengeluaranSync.runFullSync() yang bisa dipanggil
 * manual, file ini juga menarik data terbaru otomatis di latar belakang saat
 * halaman dibuka.
 */
(function () {
    'use strict';

    const STORE = 'pengeluaran';
    const TABLE = 'gamas_pengeluaran';

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

    async function pushRecord(record) {
        const sb = client();
        if (!sb || isOfflineMode()) return;
        try {
            const { error } = await sb.from(TABLE).upsert({
                bulan: record.bulan,
                data: record.data || [],
                tanggal: record.tanggal || new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'bulan' });
            if (error) console.warn('[GAMAS] Gagal push pengeluaran:', error.message);
        } catch (e) { console.warn('[GAMAS] Gagal push pengeluaran:', e); }
    }

    async function pullFromCloud() {
        const sb = client();
        if (!sb || isOfflineMode()) return false;
        try {
            const { data: rows, error } = await sb.from(TABLE).select('bulan,data,tanggal,updated_at');
            if (error) throw error;
            if (!rows || !rows.length) return false;

            let changed = false;
            for (const remote of rows) {
                const local = await db[STORE].where('bulan').equals(remote.bulan).first();
                const remoteTime = new Date(remote.updated_at || remote.tanggal || 0).getTime();
                const localTime = local ? new Date(local.tanggal || 0).getTime() : -1;
                if (!local) {
                    await db[STORE].add({ bulan: remote.bulan, data: remote.data || [], tanggal: remote.tanggal || remote.updated_at });
                    changed = true;
                } else if (remoteTime > localTime) {
                    await db[STORE].update(local.id, { data: remote.data || [], tanggal: remote.tanggal || remote.updated_at });
                    changed = true;
                }
            }
            return changed;
        } catch (e) { console.warn('[GAMAS] Gagal pull pengeluaran:', e); return false; }
    }

    // --- Bungkus add/update ASLI supaya setiap simpan lokal juga terdorong ke cloud ---
    const table = db[STORE];
    const _origAdd = table.add.bind(table);
    const _origUpdate = table.update.bind(table);

    table.add = async function (obj) {
        const id = await _origAdd(obj);
        pushRecord(Object.assign({}, obj, { id: id }));
        return id;
    };
    table.update = async function (id, changes) {
        const result = await _origUpdate(id, changes);
        try {
            const all = await table.toArray();
            const full = all.find(function (r) { return r.id === id; });
            if (full) pushRecord(full);
        } catch (e) { /* penyimpanan lokal tetap sukses walau ini gagal */ }
        return result;
    };

    async function runFullSync(silent) {
        if (isOfflineMode()) return { skipped: true };
        const changed = await pullFromCloud();
        return { changed: changed };
    }

    window.gamasPengeluaranSync = { runFullSync: runFullSync, pullFromCloud: pullFromCloud, pushRecord: pushRecord };

    if (!isOfflineMode()) {
        setTimeout(function () { pullFromCloud(); }, 1500);
    }
})();
