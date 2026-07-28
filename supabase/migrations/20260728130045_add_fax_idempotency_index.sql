-- Prevent the same iOS fax submission from being created more than once.
-- Legacy client references are intentionally excluded from this constraint.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.faxes
        WHERE user_id IS NOT NULL
          AND client_reference LIKE 'ios:%'
        GROUP BY user_id, client_reference
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot add fax idempotency index: duplicate iOS client references exist';
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_faxes_user_client_reference_idempotency
    ON public.faxes (user_id, client_reference)
    WHERE user_id IS NOT NULL
      AND client_reference LIKE 'ios:%';

COMMENT ON INDEX public.idx_faxes_user_client_reference_idempotency IS
    'Enforces per-user idempotency for iOS fax submissions.';
