-- PDF Workbench: private per-user document library in Supabase Storage.
-- Run once in the SQL editor (or as a migration). Safe to re-run.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 52428800, array['application/pdf'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Each user may only see and change objects inside a folder named after their user id.
drop policy if exists "pdfwb documents select own" on storage.objects;
create policy "pdfwb documents select own" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pdfwb documents insert own" on storage.objects;
create policy "pdfwb documents insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pdfwb documents update own" on storage.objects;
create policy "pdfwb documents update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "pdfwb documents delete own" on storage.objects;
create policy "pdfwb documents delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);
