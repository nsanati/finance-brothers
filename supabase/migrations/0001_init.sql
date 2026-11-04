-- Split Tab: schema, security rules and server functions.
-- Run once in the Supabase SQL editor (or `supabase db push`).

create extension if not exists pgcrypto;

-- ───────────────────────── profiles ─────────────────────────
-- One row per account. Emails stay in auth.users and are never exposed.
create table public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  username      text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name  text not null check (char_length(display_name) between 1 and 40),
  created_at    timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles readable by signed-in users" on public.profiles
  for select to authenticated using (true);
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Create the profile from the sign-up form's metadata.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    lower(new.raw_user_meta_data->>'username'),
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), new.raw_user_meta_data->>'username')
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.username_available(p_username text) returns boolean
language sql security definer set search_path = public stable as $$
  select not exists (select 1 from profiles where username = lower(p_username));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- Find people by username prefix or by exact email address.
create or replace function public.search_profiles(q text)
returns table (id uuid, username text, display_name text)
language sql security definer set search_path = public stable as $$
  select p.id, p.username, p.display_name
  from profiles p join auth.users u on u.id = p.id
  where p.id <> auth.uid()
    and char_length(trim(q)) >= 2
    and (p.username like lower(trim(q)) || '%' or lower(u.email) = lower(trim(q)))
  order by p.username
  limit 10;
$$;
grant execute on function public.search_profiles(text) to authenticated;

-- ───────────────────────── friends ─────────────────────────
create table public.friendships (
  id          uuid primary key default gen_random_uuid(),
  requester   uuid not null references public.profiles on delete cascade,
  addressee   uuid not null references public.profiles on delete cascade,
  status      text not null default 'pending' check (status in ('pending','accepted')),
  created_at  timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index friendships_pair on public.friendships
  (least(requester, addressee), greatest(requester, addressee));
alter table public.friendships enable row level security;
create policy "see own friendships" on public.friendships
  for select to authenticated using (auth.uid() in (requester, addressee));
create policy "send invite" on public.friendships
  for insert to authenticated with check (requester = auth.uid() and status = 'pending');
create policy "accept invite" on public.friendships
  for update to authenticated using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'accepted');
create policy "decline or unfriend" on public.friendships
  for delete to authenticated using (auth.uid() in (requester, addressee));

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from friendships
    where status = 'accepted'
      and least(requester, addressee) = least(a, b)
      and greatest(requester, addressee) = greatest(a, b));
$$;

-- ───────────────────────── groups ─────────────────────────
create table public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 40),
  simplify    boolean not null default true,
  created_by  uuid not null references public.profiles,
  created_at  timestamptz not null default now()
);
create table public.group_members (
  group_id   uuid not null references public.groups on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

create or replace function public.is_member(gid uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from group_members where group_id = gid and user_id = auth.uid());
$$;

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
create policy "members see group" on public.groups
  for select to authenticated using (public.is_member(id));
create policy "members edit group" on public.groups
  for update to authenticated using (public.is_member(id)) with check (public.is_member(id));
create policy "members see members" on public.group_members
  for select to authenticated using (public.is_member(group_id));
create policy "leave group" on public.group_members
  for delete to authenticated using (user_id = auth.uid());

create or replace function public.create_group(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into groups (name, created_by) values (trim(p_name), auth.uid()) returning id into gid;
  insert into group_members (group_id, user_id) values (gid, auth.uid());
  return gid;
end $$;
grant execute on function public.create_group(text) to authenticated;

-- Members can add their accepted friends to a group.
create or replace function public.add_group_member(p_group uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_group) then raise exception 'You are not in this group'; end if;
  if not public.are_friends(auth.uid(), p_user) then raise exception 'You can only add friends'; end if;
  insert into group_members (group_id, user_id) values (p_group, p_user) on conflict do nothing;
end $$;
grant execute on function public.add_group_member(uuid, uuid) to authenticated;

-- ───────────────────────── expenses ─────────────────────────
create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups on delete cascade,
  description   text not null check (char_length(description) between 1 and 80),
  amount_cents  integer not null check (amount_cents > 0),
  paid_by       uuid not null references public.profiles,
  spent_on      date not null default current_date,
  split_mode    text not null default 'equal' check (split_mode in ('equal','exact')),
  created_by    uuid not null references public.profiles,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table public.expense_splits (
  expense_id   uuid not null references public.expenses on delete cascade,
  user_id      uuid not null references public.profiles,
  share_cents  integer not null check (share_cents >= 0),
  primary key (expense_id, user_id)
);
create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups on delete cascade,
  from_user     uuid not null references public.profiles,
  to_user       uuid not null references public.profiles,
  amount_cents  integer not null check (amount_cents > 0),
  paid_on       date not null default current_date,
  created_by    uuid not null references public.profiles,
  created_at    timestamptz not null default now(),
  check (from_user <> to_user)
);
create index on public.expenses (group_id, spent_on desc);
create index on public.payments (group_id, paid_on desc);

alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.payments enable row level security;
create policy "members see expenses" on public.expenses
  for select to authenticated using (public.is_member(group_id));
create policy "members delete expenses" on public.expenses
  for delete to authenticated using (public.is_member(group_id));
create policy "members see splits" on public.expense_splits
  for select to authenticated using (exists (select 1 from expenses e where e.id = expense_id and public.is_member(e.group_id)));
create policy "members see payments" on public.payments
  for select to authenticated using (public.is_member(group_id));
create policy "members record payments" on public.payments
  for insert to authenticated with check (
    created_by = auth.uid() and public.is_member(group_id)
    and exists (select 1 from group_members where group_id = payments.group_id and user_id = from_user)
    and exists (select 1 from group_members where group_id = payments.group_id and user_id = to_user));
create policy "members undo payments" on public.payments
  for delete to authenticated using (public.is_member(group_id));

-- Create or edit an expense and its split in one step, with checks.
-- p_splits: [{"user_id": "...", "share_cents": 1234}, ...]
create or replace function public.save_expense(
  p_id uuid, p_group uuid, p_description text, p_amount integer,
  p_paid_by uuid, p_spent_on date, p_mode text, p_splits jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare eid uuid; total integer; bad integer;
begin
  if not public.is_member(p_group) then raise exception 'You are not in this group'; end if;
  if not exists (select 1 from group_members where group_id = p_group and user_id = p_paid_by) then
    raise exception 'The payer must be in the group'; end if;
  select coalesce(sum((s->>'share_cents')::int), 0) into total from jsonb_array_elements(p_splits) s;
  if total <> p_amount then raise exception 'Shares must add up to the total'; end if;
  select count(*) into bad from jsonb_array_elements(p_splits) s
    where not exists (select 1 from group_members where group_id = p_group and user_id = (s->>'user_id')::uuid);
  if bad > 0 then raise exception 'Everyone in the split must be in the group'; end if;

  if p_id is null then
    insert into expenses (group_id, description, amount_cents, paid_by, spent_on, split_mode, created_by)
    values (p_group, trim(p_description), p_amount, p_paid_by, p_spent_on, p_mode, auth.uid()) returning id into eid;
  else
    update expenses set description = trim(p_description), amount_cents = p_amount, paid_by = p_paid_by,
      spent_on = p_spent_on, split_mode = p_mode, updated_at = now()
    where id = p_id and group_id = p_group returning id into eid;
    if eid is null then raise exception 'Expense not found'; end if;
    delete from expense_splits where expense_id = eid;
  end if;
  insert into expense_splits (expense_id, user_id, share_cents)
    select eid, (s->>'user_id')::uuid, (s->>'share_cents')::int from jsonb_array_elements(p_splits) s
    where (s->>'share_cents')::int > 0;
  return eid;
end $$;
grant execute on function public.save_expense(uuid, uuid, text, integer, uuid, date, text, jsonb) to authenticated;

-- ───────────────────────── push notifications ─────────────────────────
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ───────────────────────── live updates ─────────────────────────
alter publication supabase_realtime add table
  public.groups, public.group_members, public.expenses, public.expense_splits,
  public.payments, public.friendships;
