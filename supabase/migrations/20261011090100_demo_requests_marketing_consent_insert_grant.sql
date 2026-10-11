-- 20260911090000_demo_requests_admin_crm.sql narrowed anon/authenticated
-- INSERT on demo_requests to (name, email, phone, business_name, message).
-- 20261003090000_demo_requests_marketing_consent.sql then added
-- marketing_consent without extending that column grant, while
-- src/routes/contact.tsx always sends it — so every public "Book a demo"
-- submission fails with "permission denied for table demo_requests".
-- Grant INSERT on exactly that one column; nothing else changes.
GRANT INSERT (marketing_consent) ON public.demo_requests TO anon, authenticated;
