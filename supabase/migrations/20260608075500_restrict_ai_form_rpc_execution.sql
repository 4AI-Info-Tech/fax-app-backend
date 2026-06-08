REVOKE ALL ON FUNCTION public.increment_ai_form_session_calls(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_ai_form_session_calls(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.increment_ai_form_session_calls(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_form_session_calls(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_form_session(UUID, UUID, BOOLEAN, INTEGER) TO service_role;
