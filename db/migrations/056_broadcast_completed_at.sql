-- Campaign timing for the broadcast detail view: when a run began and when
-- every send in it finished dispatching, so the UI can show
-- "Campaign started / Campaign completed / Duration".
--
-- Both live on the broadcasts row rather than being derived from
-- MIN/MAX(broadcast_logs.sent_at), because a per-recipient retry rewrites that
-- log row's sent_at — which would silently drag a derived start time forward.
-- A repeat send resets both (each run times its own window); a retry inside a
-- run only clears completed_at.
--
-- Nullable and non-destructive: NULL means "never sent / not yet finished".
-- started_at is backfilled from the existing logs so already-sent campaigns
-- show a start time instead of a dash.

ALTER TABLE coexistence.broadcasts
  ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE coexistence.broadcasts b
   SET started_at = sub.first_sent
  FROM (
    SELECT broadcast_id, MIN(sent_at) AS first_sent
      FROM coexistence.broadcast_logs
     WHERE action = 'BROADCAST'
     GROUP BY broadcast_id
  ) sub
 WHERE sub.broadcast_id = b.id
   AND b.started_at IS NULL;
