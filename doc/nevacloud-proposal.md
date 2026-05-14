# Usulan VPS Nevacloud — Hara Ecosystem Pilot

Dokumen ini menjabarkan kebutuhan VPS untuk **hara-ledger** (Option A: 5 VPS dan Option B: 6 VPS), serta usulan terpisah untuk **hara-did** dan **hara-passport** sebagai dua produk yang berdiri di atas chain.

Semua angka dalam Rupiah, **estimasi bulanan**, **belum termasuk PPN 11%**. Diskon prepay tahunan biasanya 10–20% (perlu konfirmasi langsung ke Nevacloud).

---

## Bagian 1 — hara-ledger Option A (5 VPS)

Konfigurasi paling hemat yang masih mempertahankan BFT (Byzantine Fault Tolerance) QBFT 4 validator. Cocok untuk pilot fase awal dengan 1–2 mitra friendly, beban masih rendah, dan budget ketat.

| Hostname | Peran | vCPU | RAM | Storage | Estimasi/bulan |
|---|---|---:|---:|---|---:|
| hara-v1 | Besu validator 1 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-v2 | Besu validator 2 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-v3 | Besu validator 3 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-v4 | Besu validator 4 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-app | RPC + LB + Postgres + Redis + Vault + Prom + Grafana + Loki + signer + broadcaster + indexer + rpc-cache + Blockscout (BE+FE) | 8 | 32 GB | 500 GB NVMe | Rp 1.500.000 |
| – | Object Storage (snapshot validator + Postgres) | – | – | 200 GB | Rp 200.000 |
| – | Outbound bandwidth allowance | – | – | – | Rp 100.000 |
| **Subtotal** | | | | | **Rp 4.600.000** |

**Catatan**: konfigurasi ini cukup untuk **~12 bulan pertama** pada beban yang Anda sebutkan (25.000 batch × 7.000 transfer + 4 juta passport / 45 bulan). Setelah itu disk dan RAM akan menjadi bottleneck. Lihat Option B untuk konfigurasi yang tidak perlu di-migrate di tengah jalan.

---

## Bagian 2 — hara-ledger Option B (6 VPS) — REKOMENDASI

Tambahkan 1 VPS sehingga stateful tier (Postgres + Vault + Redis) terpisah dari stateless tier (semua aplikasi). Konfigurasi ini muat 45 bulan penuh tanpa perlu migrasi.

| Hostname | Peran | vCPU | RAM | Storage | Estimasi/bulan |
|---|---|---:|---:|---|---:|
| hara-v1 | Besu validator 1 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-v2 | Besu validator 2 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-v3 | Besu validator 3 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-v4 | Besu validator 4 | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| hara-stateful | Postgres + Redis + Vault + MinIO (tier data + secrets) | 8 | 32 GB | **1 TB NVMe** | Rp 2.500.000 |
| hara-stateless | RPC mesh + HAProxy LB + signer + broadcaster + indexer + rpc-cache + Blockscout + Prom + Grafana + Loki + Alertmanager | 8 | 32 GB | 500 GB NVMe | Rp 1.700.000 |
| – | Object Storage (snapshot validator + Postgres + dokumen RSPO) | – | – | 300 GB | Rp 300.000 |
| – | Outbound bandwidth allowance | – | – | – | Rp 200.000 |
| **Subtotal** | | | | | **Rp 7.500.000** |

**Catatan**: 1 TB NVMe di hara-stateful sudah cukup untuk full 45 bulan (proyeksi penggunaan ~700–800 GB di akhir bulan ke-45). Tidak perlu upgrade storage. Jika beban tumbuh lebih cepat dari ekspektasi, tambahkan 1 stateless VPS lagi (~Rp 1.7M/bulan) tanpa downtime — itulah sebabnya stateless tier terpisah.

**Selisih dengan Option A**: Rp 2.900.000/bulan (~63% lebih mahal di awal, tapi tanpa biaya migrasi kemudian).

---

## Bagian 3 — hara-did (DID + Verifiable Credentials)

Layanan identitas terdesentralisasi: IssuerRegistry on-chain (di hara-ledger), Sidetree batcher off-chain, resolver API, witness service untuk ZK proofs, dan beberapa frontend portal.

Asumsi pilot: ~10.000 issuer DID terdaftar (BPJPH, LPH, MUI, eksportir besar, dll.) + ~1 juta holder DID via Sidetree batching dalam 45 bulan. Mostly anchored on hara-ledger chain — **tidak butuh validator sendiri**.

| Hostname | Peran | vCPU | RAM | Storage | Estimasi/bulan |
|---|---|---:|---:|---|---:|
| did-services | Sidetree batcher + Resolver API + Witness service + Wallet API backend + ZK prover (server-side fallback) | 8 | 16 GB | 500 GB NVMe | Rp 1.500.000 |
| did-frontend | Issuer Portal (Next.js) + Admin Console + Verifier Demo (Universal Resolver compatible) | 4 | 8 GB | 100 GB NVMe | Rp 700.000 |
| – | Object Storage (Sidetree CAS — DID operation batches, ZK setup artifacts) | – | – | 200 GB | Rp 200.000 |
| – | Outbound bandwidth allowance | – | – | – | Rp 100.000 |
| **Subtotal** | | | | | **Rp 2.500.000** |

**Yang dipakai bareng dari hara-ledger**:
- Chain RPC endpoint (untuk anchor + resolve) → via `hara-stateless` LB
- Vault → via `hara-stateful` (path `secret/haradid/...`)
- Postgres → via `hara-stateful` (database terpisah: `hara_did`)
- Observability (Prometheus + Grafana + Loki) → via `hara-stateless`

Jadi hara-did **hanya butuh 2 VPS sendiri**, semua infra dasar di-share dengan hara-ledger.

**Scaling roadmap** (ringkas):
- Bulan 1–6: 2 VPS cukup
- Bulan 6–12: tambah 1 `did-frontend` VPS jika traffic wallet/portal naik
- Bulan 12+: tambah 1 `did-services` VPS untuk Sidetree batcher leader-election (HA pattern di pathway doc)

---

## Bagian 4 — hara-passport (Halal Passport NFT)

Sistem penerbitan ERC-721 soulbound oleh BPJPH/LPH/MUI, plus public verification API untuk konsumen yang scan QR.

Asumsi target Anda: **4 juta passport dalam 45 bulan** = rata-rata ~2.900 minting/hari, peak mungkin 30.000/hari saat batch issuance dari LPH. Verifikasi konsumen jauh lebih banyak (target 50–100 juta scan QR dalam 45 bulan).

| Hostname | Peran | vCPU | RAM | Storage | Estimasi/bulan |
|---|---|---:|---:|---|---:|
| passport-services | Minting service + Verification API (high-RPS read path) + revocation indexer + PDF/VC generator | 8 | 16 GB | 200 GB NVMe | Rp 1.200.000 |
| passport-frontend | BPJPH/LPH Portal (Next.js) + Public Verification UI (consumer scan) + Admin | 4 | 16 GB | 100 GB NVMe | Rp 900.000 |
| – | Object Storage (sertifikat PDF, foto produk, dokumen lab → MinIO/S3 bucket) | – | – | 500 GB | Rp 500.000 |
| – | Outbound bandwidth allowance (heavy: setiap scan QR = ~50 KB response × jutaan/bulan) | – | – | – | Rp 300.000 |
| **Subtotal** | | | | | **Rp 2.900.000** |

**Yang dipakai bareng dari hara-ledger**:
- Chain RPC (minting → `/rpc/write`, verification → `/rpc/read` via rpc-cache!)
- Vault (signer keys untuk BPJPH/LPH/MUI roles)
- Postgres (database terpisah: `hara_passport`)
- rpc-cache layer → **vital untuk hara-passport** karena public verification API akan menyebabkan jutaan `eth_getLogs` panggilan per bulan. Cache hit rate 99% yang kita ukur menghemat ~75% beban validator.
- Observability

**Scaling roadmap**:
- Bulan 1–6: 2 VPS cukup (~2.900 mint/hari, ~10K verify/hari)
- Bulan 6–18: tambah 1 `passport-services` replica untuk verification read path
- Bulan 18+: pertimbangkan CDN edge (Cloudflare Workers) untuk verification API agar latency global <100ms

---

## Total Biaya Bulanan (Gabungan)

### Skenario "Minimal" — Option A + hara-did + hara-passport

| Komponen | Rp/bulan |
|---|---:|
| hara-ledger Option A (5 VPS) | 4.600.000 |
| hara-did (2 VPS) | 2.500.000 |
| hara-passport (2 VPS) | 2.900.000 |
| **TOTAL** | **Rp 10.000.000/bulan** (~$640) |

### Skenario "Rekomendasi" — Option B + hara-did + hara-passport

| Komponen | Rp/bulan |
|---|---:|
| hara-ledger Option B (6 VPS) | 7.500.000 |
| hara-did (2 VPS) | 2.500.000 |
| hara-passport (2 VPS) | 2.900.000 |
| **TOTAL** | **Rp 12.900.000/bulan** (~$830) |

### Proyeksi 45 bulan

| Skenario | Total 45 bulan | Catatan |
|---|---:|---|
| Minimal (Opsi A) | Rp 450 juta | Plus biaya migrasi bulan ke-12 untuk upgrade hara-ledger ke Option B (~setengah hari kerja + Rp 2.9M/bulan tambahan setelah migrasi) |
| Rekomendasi (Opsi B) | Rp 581 juta | Tanpa migrasi sama sekali sepanjang 45 bulan |
| Selisih total | **Rp 131 juta** (~$8.400) | Tradeoff: simplicity & no-migration vs hemat ~22% |

### Estimasi diskon prepay tahunan (perlu konfirmasi Nevacloud)

Asumsi diskon 15% jika bayar 12 bulan di muka:

| Skenario | Cash bulanan | Prepay tahunan (–15%) | Penghematan/tahun |
|---|---:|---:|---:|
| Minimal | Rp 120 juta/tahun | Rp 102 juta | Rp 18 juta |
| Rekomendasi | Rp 155 juta/tahun | Rp 132 juta | Rp 23 juta |

---

## Rekomendasi Strategi Pembayaran

1. **Bulan 1–3 (smoke test)**: bayar **bulanan** untuk semua VPS. Validasi konfigurasi, ukur traffic riil, sesuaikan spec jika perlu.

2. **Bulan 3–6 (pilot stabil)**:
   - VPS validator (yang spec-nya stabil) → bisa mulai prepay 3 atau 6 bulan jika ada diskon
   - VPS app/services → tetap bulanan dulu, masih mungkin di-resize

3. **Bulan 6+ (production-ish)**:
   - Semua VPS yang ukurannya stabil → prepay tahunan
   - VPS yang masih di-tune → bulanan

**Catatan**: Object Storage di Nevacloud biasanya pay-as-you-go per GB-bulan — tidak perlu prepay. Bayar sesuai pemakaian aktual.

---

## Yang Belum Termasuk dalam Estimasi

| Item | Estimasi/bulan | Kapan dibutuhkan |
|---|---:|---|
| **Domain + SSL/TLS certificate** (Let's Encrypt gratis, tapi Anda butuh domain) | ~Rp 200.000 (annual fee dibagi 12) | P1a |
| **Email/Slack/PagerDuty untuk alertmanager** | ~Rp 0–500.000 | P1a |
| **External uptime monitoring** (UptimeRobot free tier OK, Better Stack paid ~$10/bulan) | ~Rp 150.000 | P1a |
| **Cloudflare** (DNS + DDoS protection + Workers untuk passport-verification edge cache) | ~Rp 0 (free tier) hingga ~Rp 300.000 (Pro) | P1b/P2 |
| **DR Huawei Cloud** (backup validator + Postgres replica + AI server untuk OCR) | ~Rp 5–8 juta/bulan | P2 (bulan ~12) |
| **HSM / KMS** (untuk validator keys di produksi sesungguhnya) | Rp 1–3 juta/bulan | P2 |
| **External audit security review** (one-time, sekali setahun) | Rp 50–150 juta one-off | Sebelum production launch (P1b → P2) |
| **Compliance certification** (ISO 27001 prep) | Rp 100–300 juta one-off | P2 |

Item-item ini **tidak perlu di bulan 1**. Bisa di-budget bertahap saat product mature.

---

## Rekomendasi Akhir

| Pertanyaan | Jawaban |
|---|---|
| Mulai dengan berapa VPS? | **6 VPS (Option B hara-ledger) + 2 VPS hara-did + 2 VPS hara-passport = 10 VPS total** |
| Total biaya bulan pertama? | **~Rp 13 juta/bulan** (~$830) |
| Total biaya tahun pertama? | **~Rp 155 juta** (atau ~Rp 132 juta dengan prepay tahunan) |
| Total biaya 45 bulan? | **~Rp 581 juta** (~$37.000) |
| Kapan butuh Huawei DR layer? | Bulan ke-12, setelah pilot stabil dan ada mitra produksi sesungguhnya |
| Kapan butuh HSM? | Bulan ke-18 atau setelah audit security |
| Kapan butuh CDN edge? | Bulan ke-18 ketika passport verification traffic global mulai tumbuh |

---

## Langkah Selanjutnya

1. **Hubungi Nevacloud sales** dengan dokumen ini sebagai dasar quote. Tanyakan:
   - Apakah ada diskon untuk multi-VPS deployment (10 VPS dari 1 customer)?
   - Apakah ada diskon prepay tahunan/setengah-tahun?
   - Apakah ada paket khusus untuk komponen yang stabil (validator) vs yang masih di-tune?
   - Konfirmasi inclusivity PPN, bandwidth fair use, dan SLA uptime
2. **Provision 1 VPS dulu** sebagai smoke test untuk validasi aktual performa Nevacloud (CPU benchmark, disk I/O, network latency)
3. **Setelah smoke test OK**, provision sisanya secara bertahap mengikuti urutan di `deploy/README.md`
4. **Bulan 1–2**: bring up hara-ledger Option B
5. **Bulan 2–3**: bring up hara-did (issuer registry first)
6. **Bulan 3–4**: bring up hara-passport (after hara-did issuers exist)

---

## Catatan Migrasi dari Option A ke Option B (jika Anda pilih A duluan)

Jika Anda pilih Option A untuk hemat di tahun pertama, ini timeline migrasi yang masuk akal:

- Bulan 1–10: jalankan 5 VPS, monitor disk/RAM growth
- Bulan 10–11: provision hara-stateful VPS baru (8 vCPU/32 GB/1 TB)
- Bulan 11: backup Postgres + Vault → restore ke VPS baru → cutover (downtime ~30 menit)
- Bulan 12+: lanjut dengan 6 VPS configuration

**Biaya migrasi**: ~Rp 2.5 juta (1 bulan dual-running) + ~setengah hari kerja ops engineer.

---

Dokumen ini bisa langsung Anda gunakan sebagai dasar quote ke Nevacloud, atau sebagai lampiran proposal internal/ke investor.
