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
        WHEN lower(catalog.title) ~ 'cms[- ]?29([^0-9]|$)' THEN 30
        ELSE 1000
    END
FROM public.form_catalog AS catalog
WHERE catalog.is_active = true
  AND catalog.is_fillable_expected = true
ON CONFLICT (form_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    instructions = EXCLUDED.instructions,
    is_enabled = EXCLUDED.is_enabled,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();
