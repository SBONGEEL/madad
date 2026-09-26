-- نزول 0006.
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);
DELETE FROM derived_fields WHERE table_name = 'pickup_line_costs' AND column_name = 'unit_cost';
DROP TRIGGER stop_line_cost_follow ON pickup_stop_lines;
DROP FUNCTION trg_stop_line_cost_follow();
DROP TRIGGER stop_line_cost_fill ON pickup_stop_lines;
DROP FUNCTION trg_stop_line_cost_fill();
DROP FUNCTION line_cost_estimate(bigint);
