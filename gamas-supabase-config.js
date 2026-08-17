/**
 * KONFIGURASI SUPABASE — GAMAS 2026
 * ============================================================
 * File ini SENGAJA dipisah dari sync-*.js. Saat pindah akun/project
 * Supabase, kamu HANYA perlu ganti 2 nilai di bawah ini. Tidak ada
 * satu pun kode sync yang menyimpan URL/API key secara hardcode,
 * jadi tidak ada yang "terikat" ke akun tertentu.
 *
 * Cara isi:
 *   1. Buka project Supabase -> Settings -> API
 *   2. Salin "Project URL" ke SUPABASE_URL
 *   3. Salin key "anon public" ke SUPABASE_ANON_KEY
 *      (JANGAN PERNAH pakai/taruh "service_role" key di sini —
 *       itu secret key, kalau bocor semua data bisa diakses/diubah
 *       tanpa batas keamanan RLS)
 *
 * Kalau repo GitHub kamu PUBLIC, sebaiknya masukkan file ini ke
 * .gitignore lalu upload manual ke hosting (atau isi lewat env/
 * build step). anon key memang aman dipakai di client asal RLS
 * di Supabase sudah benar (lihat gamas-supabase-schema.sql), tapi
 * lebih rapi kalau project_ref tidak nongol di histori commit publik.
 */
window.GAMAS_SUPABASE_CONFIG = {
    url: 'https://YOUR-PROJECT-REF.supabase.co',
    anonKey: 'YOUR-ANON-PUBLIC-KEY'
};
