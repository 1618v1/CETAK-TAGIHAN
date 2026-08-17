/**
 * SYNC-PENGELUARAN-SUPABASE.JS — Cloud sync untuk data Pengeluaran / Kas Kecil
 * ============================================================================
 * Pola persis sama seperti sync-cash-income-supabase.js karena struktur
 * lokalnya identik: 1 baris per bulan di IndexedDB store 'pengeluaran'
 * (lihat savePengeluaranData() di HTML: where('bulan').equals() lalu
 * update-atau-add). Kredensial dari window.GAMAS_SUPABASE_CONFIG saja,
 * tidak ada yang terikat akun.
 *
 * ------------------------------------------------------------------------
 * PERBAIKAN (v2) — mencegah data baru "hilang ketimpa" data lama:
 * ------------------------------------------------------------------------
 * Versi sebelumnya push ke Supabase TANPA ditunggu (fire-and-forget). Kalau
 * user refresh halaman sebelum push selesai, request itu bisa terputus, lalu
 * pull otomatis yang jalan begitu halaman dibuka ulang akan menarik data LAMA
 * dari server dan MENIMPA data lokal yang sebenarnya lebih baru.
 *
 * Sekarang setiap record diberi penanda `_dirty` begitu disimpan lokal:
 *   - `_dirty = true`  -> belum dikonfirmasi tersimpan di server
 *   - `_dirty = false` -> sudah dikonfirmasi tersimpan di server
 * Push sekarang DITUNGGU (await) sebelum operasi simpan dianggap selesai,
 * dan pull TIDAK PERNAH menimpa record yang masih `_dirty = true`. Sebelum
 * pull otomatis jalan saat halaman dibuka, sistem coba push ulang dulu semua
 * record yang masih dirty (jaga-jaga kalau push sebelumnya gagal/terputus).
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

    const table = db[STORE];
    const _origAdd = table.add.bind(table);
    const _origUpdate = table.update.bind(table);

    function markClean(id) {
        return _origUpdate(id, { _dirty: false }).catch(function () {});
    }

    async function pushRecord(record) {
        const sb = client();
        if (!sb || isOfflineMode()) return false;
        try {
            const { error } = await sb.from(TABLE).upsert({
                bulan: record.bulan,
                data: record.data || [],
                tanggal: record.tanggal || new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, { onConflict: 'bulan' });
            if (error) { console.warn('[GAMAS] Gagal push pengeluaran:', error.message); return false; }
            if (record.id != null) await markClean(record.id);
            return true;
        } catch (e) { console.warn('[GAMAS] Gagal push pengeluaran:', e); return false; }
    }

    // Coba push ulang semua record yang masih ditandai dirty (mis. push
    // sebelumnya terputus karena refresh) sebelum pull jalan, supaya data
    // lokal terbaru "menang" dulu ke server sebelum kita menarik apapun.
    async function flushPendingPushes() {
        if (isOfflineMode() || !client()) return;
        try {
            const all = await table.toArray();
            const pending = all.filter(function (r) { return r._dirty; });
            for (const rec of pending) {
                await pushRecord(rec);
            }
        } catch (e) { console.warn('[GAMAS] Gagal flush pending pushes pengeluaran:', e); }
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
                const local = await table.where('bulan').equals(remote.bulan).first();

                // JANGAN timpa record yang masih ada perubahan lokal belum
                // ke-push -- data lokal yang belum sinkron selalu menang.
                if (local && local._dirty) continue;

                const remoteTime = new Date(remote.updated_at || remote.tanggal || 0).getTime();
                const localTime = local ? new Date(local.tanggal || 0).getTime() : -1;
                if (!local) {
                    await _origAdd({ bulan: remote.bulan, data: remote.data || [], tanggal: remote.tanggal || remote.updated_at, _dirty: false });
                    changed = true;
                } else if (remoteTime > localTime) {
                    await _origUpdate(local.id, { data: remote.data || [], tanggal: remote.tanggal || remote.updated_at, _dirty: false });
                    changed = true;
                }
            }
            return changed;
        } catch (e) { console.warn('[GAMAS] Gagal pull pengeluaran:', e); return false; }
    }

    // --- Bungkus add/update ASLI supaya setiap simpan lokal juga terdorong ke cloud ---
    table.add = async function (obj) {
        const toSave = Object.assign({}, obj, { _dirty: true });
        const id = await _origAdd(toSave);
        await pushRecord(Object.assign({}, toSave, { id: id }));
        return id;
    };
    table.update = async function (id, changes) {
        const result = await _origUpdate(id, Object.assign({}, changes, { _dirty: true }));
        try {
            const all = await table.toArray();
            const full = all.find(function (r) { return r.id === id; });
            if (full) await pushRecord(full);
        } catch (e) { /* penyimpanan lokal tetap sukses walau ini gagal */ }
        return result;
    };

    async function runFullSync(silent) {
        if (isOfflineMode()) return { skipped: true };
        await flushPendingPushes();
        const changed = await pullFromCloud();
        return { changed: changed };
    }

    window.gamasPengeluaranSync = { runFullSync: runFullSync, pullFromCloud: pullFromCloud, pushRecord: pushRecord, flushPendingPushes: flushPendingPushes };

    if (!isOfflineMode()) {
        setTimeout(function () {
            flushPendingPushes().then(function () { return pullFromCloud(); });
        }, 1500);
    }
})();
