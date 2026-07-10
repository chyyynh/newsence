\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS resource_localization_state (
	resource_id uuid PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
	status varchar(32) NOT NULL,
	current_source_content_hash text,
	source_content_hash text,
	attempt_content_hash text,
	attempts integer NOT NULL DEFAULT 0,
	last_attempt_at timestamp(6),
	completed_at timestamp(6),
	error text,
	created_at timestamp(6) NOT NULL DEFAULT NOW(),
	updated_at timestamp(6) NOT NULL DEFAULT NOW(),
	CONSTRAINT resource_localization_state_status_check CHECK (
		status IN ('not_required', 'blocked_on_content', 'pending', 'queued', 'running', 'complete', 'failed')
	),
	CONSTRAINT resource_localization_state_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS resource_localization_state_status_attempt_idx
	ON resource_localization_state (status, last_attempt_at);
