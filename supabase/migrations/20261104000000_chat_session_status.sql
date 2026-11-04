-- Soft delete, plus what the session list needs to show each conversation's
-- status: whether its latest answer was read and how that answer ended.
alter table chat_sessions
  add column archived_at timestamptz,
  add column last_read_at timestamptz,
  add column last_answer_at timestamptz,
  add column last_answer_status text
    check (last_answer_status in ('done', 'stopped', 'truncated', 'failed'));

-- Answers that ran out of search steps can be continued from the conversation.
alter table chat_messages
  add column step_limit_reached boolean not null default false;
