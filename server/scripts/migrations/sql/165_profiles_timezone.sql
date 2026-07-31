-- Часовой пояс аккаунта (профиля) для ночных фоновых задач.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow';

COMMENT ON COLUMN profiles.timezone IS
  'IANA TZ (например Europe/Moscow, Asia/Yekaterinburg). Ночные джобы планировщика идут по локальному времени профиля.';

-- Идемпотентность: задача уже отработала для scope в этот локальный день.
CREATE TABLE IF NOT EXISTS profile_nightly_job_runs (
  job_key TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  run_local_date DATE NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_key, scope_key, run_local_date)
);

CREATE INDEX IF NOT EXISTS idx_profile_nightly_job_runs_ran_at
  ON profile_nightly_job_runs (ran_at);

COMMENT ON TABLE profile_nightly_job_runs IS
  'Отметки ночных прогонов: scope_key = p:<profileId> или tz:<IANA>.';
