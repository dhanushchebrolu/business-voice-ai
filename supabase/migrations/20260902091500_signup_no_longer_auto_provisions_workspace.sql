-- Phase B §1 / Test A: "Creating an account must NOT automatically create a
-- customer." The original handle_new_user() trigger auto-created an
-- organization, an owner membership, and a 14-day trial subscription for
-- EVERY signup — a self-serve trial flow. That directly contradicts the
-- admin-provisioned-only lifecycle this phase requires (INVITED ->
-- REGISTERED -> SETUP_PAYMENT_PENDING -> ... only ever starts when an admin
-- creates the client).
--
-- This is a deliberate, significant behavior change, not a bug fix: it
-- removes the self-serve "sign up and get a free trial workspace
-- immediately" path entirely. If a self-serve trial product is actually
-- wanted alongside admin-provisioned customers, that is a product decision
-- for a future phase, not something to silently keep half-working.
--
-- After this migration, signup only creates the person's profile row. A
-- workspace exists for someone only when an admin has explicitly created
-- and invited them (createClientAccount / acceptInvitation).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, country)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email, NEW.raw_user_meta_data->>'phone', COALESCE(NEW.raw_user_meta_data->>'country','IN'))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;
