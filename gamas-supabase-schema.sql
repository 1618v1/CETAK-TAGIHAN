-- ============================================================================
-- SKEMA SUPABASE BARU — GAMAS 2026
-- ============================================================================
-- Jalankan seluruh isi file ini di: Supabase Dashboard -> SQL Editor -> New query
-- pada PROJECT SUPABASE BARU kamu, sebelum mengisi gamas-supabase-config.js.
--
-- Tabel dibuat sesuai kebutuhan 3 file sync baru:
--   gamas_sales         <- sync-supabase.js               (tab Bank Data Penjualan)
--   gamas_cash_income   <- sync-cash-income-supabase.js    (tab Cek Cash)
--   gamas_pengeluaran   <- sync-pengeluaran-supabase.js    (tab Pengeluaran)
-- ============================================================================

-- 1) SALES: satu baris = satu baris faktur, disimpan bebas (fleksibel) di JSONB
--    karena kolom-kolom sales di app ini dinamis (Tanggal, No.Faktur, Produk,
--    Jumlah, dst) dan bisa berubah sewaktu-waktu tanpa perlu ALTER TABLE.
create table if not exists gamas_sales (
    uuid       uuid primary key,
    row_data   jsonb not null,
    updated_at timestamptz not null default now()
);
create index if not exists idx_gamas_sales_updated_at on gamas_sales (updated_at);

-- 2) CASH INCOME: satu baris per bulan (unik lewat kolom bulan), isinya array
--    transaksi harian dalam JSONB, sesuai pola saveCashData() di app.
create table if not exists gamas_cash_income (
    bulan      text primary key,
    data       jsonb not null default '[]'::jsonb,
    tanggal    timestamptz,
    updated_at timestamptz not null default now()
);

-- 3) PENGELUARAN: sama persis polanya dengan cash income.
create table if not exists gamas_pengeluaran (
    bulan      text primary key,
    data       jsonb not null default '[]'::jsonb,
    tanggal    timestamptz,
    updated_at timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
-- Karena app ini pakai anon key langsung dari browser (tanpa login user
-- Supabase Auth), keamanan datanya BUKAN dari kerahasiaan anon key, tapi dari
-- policy RLS di bawah. Versi paling sederhana (dipakai di sini): siapapun yang
-- pegang anon key project ini boleh baca+tulis. Ini setara dengan perilaku
-- lama, TAPI artinya URL & anon key harus tetap kamu jaga (jangan disebar
-- bebas ke publik di luar tim), meski secara teknis anon key memang didesain
-- boleh ada di client-side.
--
-- Kalau nanti mau lebih ketat (misal beda akses per user), tambahkan
-- Supabase Auth dan ganti policy `using (true)` di bawah dengan pengecekan
-- auth.uid() sesuai kebutuhan.

alter table gamas_sales enable row level security;
alter table gamas_cash_income enable row level security;
alter table gamas_pengeluaran enable row level security;

create policy "anon full access sales" on gamas_sales
    for all using (true) with check (true);

create policy "anon full access cash_income" on gamas_cash_income
    for all using (true) with check (true);

create policy "anon full access pengeluaran" on gamas_pengeluaran
    for all using (true) with check (true);
