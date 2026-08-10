-- ===========================================================================
--  Grocery order picking — Supabase / Postgres schema
--
--  Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
--  Then in the app: Settings → Storage → Supabase, paste the project URL and
--  the *anon public* key. Never paste the service-role key into a browser.
--
--  Every signed-in member of staff sees the same catalog, shelf layout,
--  customers, learned shorthand and order history. Only admins can change the
--  catalog, the walking order and the alias table.
-- ===========================================================================

-- ---------------------------------------------------------------- profiles --
-- Supabase manages auth.users; this table adds the store role and display name.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text not null default '',
  role        text not null default 'staff' check (role in ('staff', 'admin')),
  created_at  timestamptz not null default now()
);

-- A new sign-up becomes staff automatically. Promote to admin with:
--   update public.profiles set role = 'admin' where email = 'you@store.com';
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'role', 'staff')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ------------------------------------------------------------------- store --
-- Sheet A: the master item list.
create table if not exists public.items (
  id             text primary key,
  name           text not null,
  brand          text not null default '',
  size           text not null default '',
  department     text not null default '',
  aisle          text not null default '',
  shelf_sequence numeric,
  unit           text not null default '',
  price          numeric,
  barcode        text not null default '',
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);
create index if not exists items_aisle_idx on public.items (aisle, shelf_sequence);
create index if not exists items_name_idx  on public.items (lower(name));

-- Sheet B: the aisle walking order. `id` is the aisle code used on items.
create table if not exists public.aisles (
  id       text primary key,
  sequence integer not null,
  name     text not null default ''
);

create table if not exists public.customers (
  id         text primary key,
  name       text not null,
  phone      text not null default '',
  email      text not null default '',
  address    text not null default '',
  notes      text not null default '',
  created_at timestamptz not null default now()
);

-- The learning table. customer_id null = a store-wide rule.
create table if not exists public.aliases (
  id                text primary key,
  phrase            text not null,
  normalized_phrase text not null,
  item_id           text not null references public.items (id) on delete cascade,
  customer_id       text references public.customers (id) on delete cascade,
  hits              integer not null default 0,
  created_at        timestamptz not null default now(),
  created_by        text not null default ''
);
-- One meaning per phrase per scope. Two partial indexes because NULL is never
-- equal to NULL, so a plain unique constraint would not cover global aliases.
create unique index if not exists aliases_customer_scope_idx
  on public.aliases (customer_id, normalized_phrase)
  where customer_id is not null;
create unique index if not exists aliases_global_scope_idx
  on public.aliases (normalized_phrase)
  where customer_id is null;

create table if not exists public.orders (
  id            text primary key,
  customer_id   text references public.customers (id) on delete set null,
  customer_name text not null default '',
  delivery_at   timestamptz,
  notes         text not null default '',
  status        text not null default 'draft'
                check (status in ('draft', 'ready', 'picking', 'complete')),
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists orders_customer_idx on public.orders (customer_id);
create index if not exists orders_delivery_idx on public.orders (delivery_at desc);

create table if not exists public.order_lines (
  id                 text primary key,
  order_id           text not null references public.orders (id) on delete cascade,
  position           integer not null default 0,
  raw_text           text not null default '',
  phrase             text not null default '',
  item_id            text references public.items (id) on delete set null,
  qty                numeric not null default 1,
  unit               text not null default '',
  note               text not null default '',
  needs_review       boolean not null default false,
  match_source       text not null default 'none',
  match_score        numeric not null default 0,
  picked             boolean not null default false,
  out_of_stock       boolean not null default false,
  substitute_item_id text references public.items (id) on delete set null
);
create index if not exists order_lines_order_idx on public.order_lines (order_id, position);

-- Single-row table holding the app settings blob.
create table if not exists public.app_settings (
  id    integer primary key default 1 check (id = 1),
  value jsonb not null default '{}'::jsonb
);

-- ------------------------------------------------------------------- rules --
alter table public.profiles    enable row level security;
alter table public.items       enable row level security;
alter table public.aisles      enable row level security;
alter table public.customers   enable row level security;
alter table public.aliases     enable row level security;
alter table public.orders      enable row level security;
alter table public.order_lines enable row level security;
alter table public.app_settings enable row level security;

-- Staff read their own profile; admins read all.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Everything below: any signed-in member of staff can read.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'items', 'aisles', 'customers', 'aliases', 'orders', 'order_lines', 'app_settings'
  ] loop
    execute format('drop policy if exists %I_read on public.%I', table_name, table_name);
    execute format(
      'create policy %I_read on public.%I for select to authenticated using (true)',
      table_name, table_name
    );
  end loop;
end;
$$;

-- Staff run the day-to-day work: customers, orders and their lines.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['customers', 'orders', 'order_lines'] loop
    execute format('drop policy if exists %I_staff_write on public.%I', table_name, table_name);
    execute format(
      'create policy %I_staff_write on public.%I for all to authenticated
         using (true) with check (true)',
      table_name, table_name
    );
  end loop;
end;
$$;

-- Teaching the software is part of the picking job, so staff may add and edit
-- aliases. Deleting one is destructive, so it is admin-only.
drop policy if exists aliases_staff_insert on public.aliases;
create policy aliases_staff_insert on public.aliases
  for insert to authenticated with check (true);

drop policy if exists aliases_staff_update on public.aliases;
create policy aliases_staff_update on public.aliases
  for update to authenticated using (true) with check (true);

drop policy if exists aliases_admin_delete on public.aliases;
create policy aliases_admin_delete on public.aliases
  for delete to authenticated using (public.is_admin());

-- The catalog, the walking order and the settings are admin-only.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['items', 'aisles', 'app_settings'] loop
    execute format('drop policy if exists %I_admin_write on public.%I', table_name, table_name);
    execute format(
      'create policy %I_admin_write on public.%I for all to authenticated
         using (public.is_admin()) with check (public.is_admin())',
      table_name, table_name
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------- logo ----
-- Where an uploaded store logo lives. Public to read: it is the picture in
-- the top bar, and every device has to be able to fetch it, including before
-- anyone has signed in. Only an admin may put one there or replace it.
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do update set public = true;

drop policy if exists branding_public_read on storage.objects;
create policy branding_public_read on storage.objects
  for select using (bucket_id = 'branding');

drop policy if exists branding_admin_write on storage.objects;
create policy branding_admin_write on storage.objects
  for insert to authenticated with check (bucket_id = 'branding' and public.is_admin());

drop policy if exists branding_admin_update on storage.objects;
create policy branding_admin_update on storage.objects
  for update to authenticated using (bucket_id = 'branding' and public.is_admin());

drop policy if exists branding_admin_delete on storage.objects;
create policy branding_admin_delete on storage.objects
  for delete to authenticated using (bucket_id = 'branding' and public.is_admin());

-- ---------------------------------------------------------------- backups --
-- Supabase takes daily backups on paid plans; on the free plan use the app's
-- Settings → Backup button, or run this from a scheduled job:
--   select * from public.items;  -- etc., piped to storage by pg_cron/pg_net.
