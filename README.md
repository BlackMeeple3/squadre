# ⚽ Squadre

App mobile per creare squadre con drag & drop. Trascina i partecipanti nelle squadre.

## Stack
- **React** + Vite
- **@dnd-kit** per drag & drop fluido (touch + mouse)
- **Supabase** per database + storage foto
- **Vercel** per il deploy

---

## Setup in 5 minuti

### 1. Supabase

1. Crea un progetto su [supabase.com](https://supabase.com)
2. Vai su **SQL Editor** ed esegui:

```sql
create table if not exists participants (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  photo_url text,
  team text default 'pool' check (team in ('pool', 'a', 'b')),
  position int default 0,
  created_at timestamptz default now()
);

alter table participants enable row level security;

create policy "public read" on participants for select using (true);
create policy "public insert" on participants for insert with check (true);
create policy "public update" on participants for update using (true);
create policy "public delete" on participants for delete using (true);
```

3. Vai su **Storage** → crea bucket `photos` (Public)
4. In **Storage → Policies** aggiungi policy: `ALL` operations for `public` on bucket `photos`

5. Copia le chiavi da **Settings → API**

### 2. Variabili d'ambiente

```bash
cp .env.example .env
# Modifica .env con le tue chiavi Supabase
```

### 3. Sviluppo locale

```bash
npm install
npm run dev
```

### 4. Deploy su Vercel

```bash
# Push su GitHub
git init && git add . && git commit -m "init"
git remote add origin https://github.com/TUO-UTENTE/squadre.git
git push -u origin main
```

Poi su [vercel.com](https://vercel.com):
1. **New Project** → importa il repo GitHub
2. In **Environment Variables** aggiungi:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Deploy ✅

---

## Come si usa

- **+** → aggiunge un partecipante (nome + foto)
- **Trascina** un partecipante nella Squadra A o B
- **Trascina** da una squadra alla zona "In attesa" per rimuoverlo
- **✎** → modalità eliminazione (mostra il × su ogni card)
- Tutto è sincronizzato in tempo reale tra dispositivi

---

## Struttura progetto

```
src/
  App.jsx       # Componente principale + drag & drop
  index.css     # Stili
  lib/
    supabase.js # Client Supabase
  main.jsx      # Entry point
```
