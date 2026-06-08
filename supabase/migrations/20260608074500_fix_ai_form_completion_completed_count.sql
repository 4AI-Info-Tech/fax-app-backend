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

    UPDATE public.ai_form_usage AS usage
    SET completed_count = usage.completed_count + 1,
        last_completed_at = now(),
        updated_at = now()
    WHERE usage.user_id = p_user_id
    RETURNING usage.completed_count INTO current_count;

    RETURN QUERY SELECT true, current_count;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) TO service_role;
