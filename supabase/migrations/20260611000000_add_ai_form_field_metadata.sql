ALTER TABLE public.ai_form_sessions
    ADD COLUMN IF NOT EXISTS field_metadata JSONB NOT NULL DEFAULT '[]'::jsonb;
