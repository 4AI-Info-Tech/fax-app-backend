CREATE TABLE IF NOT EXISTS public.ai_form_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    form_id UUID NOT NULL REFERENCES public.form_catalog(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    description TEXT,
    instructions JSONB NOT NULL DEFAULT '{}'::jsonb,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    is_enabled BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (form_id)
);

CREATE TABLE IF NOT EXISTS public.ai_form_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    profile_id UUID NOT NULL REFERENCES public.ai_form_profiles(id) ON DELETE RESTRICT,
    form_id UUID NOT NULL REFERENCES public.form_catalog(id) ON DELETE RESTRICT,
    field_names JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'abandoned')),
    ai_calls INTEGER NOT NULL DEFAULT 0 CHECK (ai_calls >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ai_form_usage (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    last_completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_form_profiles_enabled
    ON public.ai_form_profiles(is_enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_ai_form_sessions_user_created
    ON public.ai_form_sessions(user_id, created_at DESC);

ALTER TABLE public.ai_form_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_form_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_form_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read enabled AI form profiles" ON public.ai_form_profiles;
CREATE POLICY "Public can read enabled AI form profiles"
    ON public.ai_form_profiles
    FOR SELECT
    USING (is_enabled = true);

DROP POLICY IF EXISTS "Users can read own AI form sessions" ON public.ai_form_sessions;
CREATE POLICY "Users can read own AI form sessions"
    ON public.ai_form_sessions
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own AI form usage" ON public.ai_form_usage;
CREATE POLICY "Users can read own AI form usage"
    ON public.ai_form_usage
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.increment_ai_form_session_calls(
    p_session_id UUID,
    p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.ai_form_sessions
    SET ai_calls = ai_calls + 1,
        updated_at = now()
    WHERE id = p_session_id
      AND user_id = p_user_id
      AND status = 'started';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'AI form session not found or not active';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_ai_form_session(
    p_session_id UUID,
    p_user_id UUID,
    p_is_subscriber BOOLEAN,
    p_free_limit INTEGER
)
RETURNS TABLE(allowed BOOLEAN, completed_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_count INTEGER;
BEGIN
    INSERT INTO public.ai_form_usage (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT usage.completed_count
    INTO current_count
    FROM public.ai_form_usage AS usage
    WHERE usage.user_id = p_user_id
    FOR UPDATE;

    IF NOT p_is_subscriber AND current_count >= GREATEST(p_free_limit, 0) THEN
        RETURN QUERY SELECT false, current_count;
        RETURN;
    END IF;

    UPDATE public.ai_form_sessions
    SET status = 'completed',
        completed_at = now(),
        updated_at = now()
    WHERE id = p_session_id
      AND user_id = p_user_id
      AND status = 'started';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'AI form session not found or already completed';
    END IF;

    UPDATE public.ai_form_usage
    SET completed_count = ai_form_usage.completed_count + 1,
        last_completed_at = now(),
        updated_at = now()
    WHERE user_id = p_user_id
    RETURNING completed_count INTO current_count;

    RETURN QUERY SELECT true, current_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_ai_form_session_calls(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_ai_form_session_calls(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) TO service_role;

INSERT INTO public.ai_form_profiles (
    form_id,
    display_name,
    description,
    instructions,
    is_enabled,
    sort_order
)
SELECT
    catalog.id,
    catalog.title,
    catalog.description,
    jsonb_build_object(
        'scope', 'Collect only facts required by the visible PDF fields.',
        'disclaimer', 'This assistant fills fields from user answers and does not provide filing advice.'
    ),
    true,
    CASE
        WHEN lower(catalog.title) LIKE '%8842%' THEN 10
        WHEN lower(catalog.title) LIKE '%8940%' THEN 20
        ELSE 30
    END
FROM public.form_catalog AS catalog
WHERE catalog.is_active = true
  AND catalog.is_fillable_expected = true
  AND (
      lower(catalog.title) LIKE '%8842%'
      OR lower(catalog.title) LIKE '%8940%'
      OR lower(catalog.title) ~ 'cms[- ]?29([^0-9]|$)'
  )
ON CONFLICT (form_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    instructions = EXCLUDED.instructions,
    is_enabled = EXCLUDED.is_enabled,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();
