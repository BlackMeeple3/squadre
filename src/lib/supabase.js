import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/* 
  SQL da eseguire in Supabase → SQL Editor:

  create table if not exists participants (
    id uuid default gen_random_uuid() primary key,
    name text not null,
    photo_url text,
    team text default 'pool' check (team in ('pool', 'a', 'b')),
    position int default 0,
    created_at timestamptz default now()
  );

  create policy "public read" on participants for select using (true);
  create policy "public insert" on participants for insert with check (true);
  create policy "public update" on participants for update using (true);
  create policy "public delete" on participants for delete using (true);

  alter table participants enable row level security;

  -- Storage bucket per le foto:
  insert into storage.buckets (id, name, public) values ('photos', 'photos', true);
  create policy "public photos" on storage.objects for all using (bucket_id = 'photos');
*/
