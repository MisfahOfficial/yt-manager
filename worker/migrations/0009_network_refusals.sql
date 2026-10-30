-- Signed-in, approved-computer check-in attempts that were refused for the network. Lets the Owner see WHY someone is refused and allow a genuine office network in one click.
CREATE TABLE network_refusals (
  employee_id TEXT NOT NULL REFERENCES employees(id),
  ip TEXT NOT NULL,
  is_vpn INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (employee_id, ip)
);
