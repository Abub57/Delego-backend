-- Completed escrow spend summaries, refreshed atomically by analytics (#306).
CREATE TABLE daily_spend_metrics (
  date DATE NOT NULL,
  user_id UUID NOT NULL,
  category VARCHAR(64) NOT NULL,
  total_spent_stroops BIGINT NOT NULL DEFAULT 0,
  orders_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (date, user_id, category)
);

CREATE TABLE monthly_spend_metrics (
  month DATE NOT NULL,
  user_id UUID NOT NULL,
  category VARCHAR(64) NOT NULL,
  total_spent_stroops BIGINT NOT NULL DEFAULT 0,
  orders_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (month, user_id, category)
);

-- Dashboard requests always constrain the authenticated user before the date.
CREATE INDEX idx_daily_spend_metrics_user_date
  ON daily_spend_metrics (user_id, date, category)
  INCLUDE (total_spent_stroops, orders_count);
CREATE INDEX idx_monthly_spend_metrics_user_month
  ON monthly_spend_metrics (user_id, month, category)
  INCLUDE (total_spent_stroops, orders_count);
