-- Migration: Newscast tables and the newscast task group
-- The newscast worker makes one newscast for each source article of a task group
-- stage run. This adds the newscasts and the share links of the finished ones,
-- the schedulers it made from its templates, and registers the task group the
-- scheduler runs to make them. The audio is in an R2 bucket of the environment
-- (<newscast id>/part-<N> and <newscast id>/signal), so a copy of the newscast
-- rows to another environment would point at audio it does not have.

-- One row per newscast. A stage run makes one for each of its sources, numbered by
-- source_index, and the pair is unique so a retried start does not make a second.
-- request is the source and the settings the newscast was made with; details is the
-- record of each step; result is the finished newscast (sources, script, and the
-- parts with their audio keys and timings). The names inside the JSON are those
-- of the newscast core package.
CREATE TABLE newscasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  stage_run_id UUID REFERENCES scheduler_stage_runs(id) ON DELETE SET NULL,
  source_index INTEGER NOT NULL CHECK (source_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  stage TEXT NOT NULL,
  stage_progress REAL NOT NULL DEFAULT 0,
  overall_progress REAL NOT NULL DEFAULT 0,
  title TEXT,
  title_override TEXT,
  request JSONB NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stage_run_id, source_index)
);
CREATE INDEX newscasts_user_created_index ON newscasts (user_uuid, created_at DESC);

COMMENT ON TABLE newscasts IS 'Newscasts made by the newscast task group, one row per source article';
COMMENT ON COLUMN newscasts.stage_run_id IS 'Scheduler stage run that made the newscast; NULL once that run is deleted';
COMMENT ON COLUMN newscasts.source_index IS 'Position of the source in the input of the stage run, from 0';
COMMENT ON COLUMN newscasts.stage IS 'Step the newscast is in, or the last step it reached';
COMMENT ON COLUMN newscasts.title_override IS 'Title the user typed, shown instead of title';
COMMENT ON COLUMN newscasts.request IS 'The source and the settings the newscast was made with';
COMMENT ON COLUMN newscasts.details IS 'Record of each step, in the shape of the newscast core job details';
COMMENT ON COLUMN newscasts.result IS 'The finished newscast, in the shape of the newscast core result; NULL until it is done';
COMMENT ON COLUMN newscasts.updated_at IS 'Set by the worker with each write';

-- One share link for each shared newscast. Anyone with the token sees the
-- allowlisted view of the newscast and plays its audio, without signing in.
CREATE TABLE newscast_shares (
  token TEXT PRIMARY KEY,
  newscast_id UUID NOT NULL UNIQUE REFERENCES newscasts(id) ON DELETE CASCADE,
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  included_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE newscast_shares IS 'Share links of newscasts, one per newscast';
COMMENT ON COLUMN newscast_shares.token IS 'Secret in the share link';
COMMENT ON COLUMN newscast_shares.included_metadata IS 'What the owner chose to show on the shared page, next to the newscast';

-- The scheduler the newscast worker made for a user from the template of a source
-- (geeknews, url or text). The worker makes one for each user and source and uses
-- it again; the row goes with the scheduler when the user deletes it.
CREATE TABLE newscast_schedulers (
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('geeknews', 'url', 'text')),
  scheduler_id UUID NOT NULL REFERENCES schedulers(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_uuid, source)
);

COMMENT ON TABLE newscast_schedulers IS 'Schedulers made from the newscast templates, one per user and source';
COMMENT ON COLUMN newscast_schedulers.source IS 'Where the articles of the template come from: geeknews, url or text';

-- Only the newscast worker (service role) uses these tables.
ALTER TABLE newscasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE newscast_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE newscast_schedulers ENABLE ROW LEVEL SECURITY;

-- Supabase gives tables created from here on no privileges, so the worker's role
-- gets them here, one GRANT for each table.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE newscasts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE newscast_shares TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE newscast_schedulers TO service_role;

-- The public anon and authenticated keys must never reach these rows, whatever
-- the default privileges of the schema gave them. The roles exist on Supabase
-- and in the docker database only, hence the check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE newscasts, newscast_shares, newscast_schedulers FROM anon, authenticated;
  END IF;
END;
$$;

-- The task group the scheduler runs as one stage. The input is wide on purpose:
-- it is the list of a previous stage, the picked articles of a form, one URL or
-- one text, and the worker checks which of them it got. The settings are flat,
-- one field for each key, so the web page of a stage draws them as they are.
INSERT INTO task_groups (id, version, input_schema, settings_schema, output_schema, worker_binding)
VALUES (
  'newscast',
  1,
  '{
    "type": ["array", "object"]
  }'::jsonb,
  '{
    "type": "object",
    "properties": {
      "provider": {
        "type": "string",
        "title": "Script provider",
        "description": "The provider whose key of the user writes the script",
        "enum": ["google", "anthropic", "openai", "xai"],
        "default": "google"
      },
      "model": {
        "type": "string",
        "title": "Script model",
        "description": "The model that writes the script; leave empty for the default model of the provider",
        "default": ""
      },
      "effort": {
        "type": "string",
        "title": "Reasoning effort",
        "description": "How much the model reasons before it writes; leave empty to send no effort",
        "enum": ["", "none", "low", "medium", "high", "xhigh", "max"],
        "default": ""
      },
      "length": {
        "type": "string",
        "title": "Length",
        "description": "How long each newscast is",
        "enum": ["short", "standard", "long"],
        "default": "standard"
      },
      "tts_model": {
        "type": "string",
        "title": "Voice model",
        "description": "The Gemini text-to-speech model that reads the newscast",
        "enum": [
          "gemini-3.8-flash-tts",
          "gemini-3.8-flash-lite-tts",
          "gemini-2.5-flash-preview-tts",
          "gemini-3.1-flash-tts-preview",
          "gemini-2.5-pro-preview-tts"
        ],
        "default": "gemini-2.5-flash-preview-tts"
      },
      "signal": {
        "type": "boolean",
        "title": "Signal",
        "description": "Play a short generated signal between the parts of a newscast that has two or more parts",
        "default": false
      },
      "verbatim": {
        "type": "boolean",
        "title": "Read verbatim",
        "description": "For a pasted text, read the text as it is instead of writing a script from it",
        "default": false
      },
      "article_limit": {
        "type": "integer",
        "title": "Article limit",
        "description": "For a list of articles, how many articles from the top become newscasts",
        "minimum": 1,
        "maximum": 10,
        "default": 3
      }
    }
  }'::jsonb,
  '{
    "type": "object",
    "properties": {
      "newscasts": {
        "type": "array",
        "title": "Newscasts",
        "description": "One entry for each source, in the order of the sources",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Identifier of the newscast"
            },
            "status": {
              "type": "string",
              "description": "Whether the newscast is done or ended with an error",
              "enum": ["done", "error"]
            },
            "title": {
              "type": ["string", "null"],
              "description": "Title of the newscast; null when it ended before it had one"
            }
          },
          "required": ["id", "status"]
        }
      }
    },
    "required": ["newscasts"]
  }'::jsonb,
  'NEWSCAST'
);
