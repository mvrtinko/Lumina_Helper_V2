CREATE INDEX IF NOT EXISTS idx_shifts_guild_start ON shifts(guild_id, start_iso);
CREATE INDEX IF NOT EXISTS idx_attendance_shift ON attendance(shift_id);
CREATE INDEX IF NOT EXISTS idx_fines_user ON fines(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_user_day ON shifts(user_id, start_iso);
