-- ═══════════════════════════════════════════════════════════════════════════
-- مَدَد — الترحيلة 0006: تكلفة كل سطر في مخطط الاستلام (ت-39)
-- build_pickup_plan يكتب تكلفة أسطره بنفسه، لكن سطراً يضيفه المالك يدوياً (§4.1) بقي بلا
-- تكلفة، فيسقط من قيد «تكلفة البضاعة» عند التسليم ولا يُدان مورده. هنا: كل سطر بلا تكلفة
-- عند الإيداع يأخذ سعر شراء عرضه أو متوسط تكلفة مخزنه؛ وتغيير العرض يغيّر التكلفة.
-- ═══════════════════════════════════════════════════════════════════════════
SET search_path = madad, public;
SELECT set_config('madad.actor_role', 'system', true);

CREATE FUNCTION line_cost_estimate(p_line bigint) RETURNS numeric AS $$
    SELECT CASE WHEN l.offer_id IS NOT NULL THEN (SELECT purchase_price FROM supplier_offers WHERE id = l.offer_id)
                WHEN s.warehouse_id IS NOT NULL THEN coalesce((SELECT ws.avg_cost FROM warehouse_stock ws
                    JOIN order_items oi ON oi.catalog_item_id = ws.catalog_item_id
                   WHERE ws.warehouse_id = s.warehouse_id AND oi.id = l.order_item_id), 0) END
      FROM pickup_stop_lines l JOIN pickup_stops s ON s.id = l.stop_id WHERE l.id = p_line
$$ LANGUAGE sql STABLE;

-- مؤجَّل إلى الإيداع: مخطط build_pickup_plan ونقطة الأمانة يكتبان تكلفتهما في الحركة نفسها.
CREATE FUNCTION trg_stop_line_cost_fill() RETURNS trigger AS $$
DECLARE c numeric;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pickup_stop_lines WHERE id = NEW.id)
       OR EXISTS (SELECT 1 FROM pickup_line_costs WHERE stop_line_id = NEW.id) THEN
        RETURN NULL;
    END IF;
    c := line_cost_estimate(NEW.id);
    IF c IS NOT NULL THEN
        INSERT INTO pickup_line_costs (stop_line_id, unit_cost) VALUES (NEW.id, c);
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER stop_line_cost_fill AFTER INSERT ON pickup_stop_lines DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_stop_line_cost_fill();

-- المالك ينقل السطر إلى عرض آخر: التكلفة تتبع العرض الجديد.
CREATE FUNCTION trg_stop_line_cost_follow() RETURNS trigger AS $$
BEGIN
    IF NEW.offer_id IS DISTINCT FROM OLD.offer_id THEN
        UPDATE pickup_line_costs SET unit_cost = line_cost_estimate(NEW.id) WHERE stop_line_id = NEW.id;
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stop_line_cost_follow AFTER UPDATE OF offer_id ON pickup_stop_lines
    FOR EACH ROW EXECUTE FUNCTION trg_stop_line_cost_follow();

INSERT INTO derived_fields (table_name, column_name, writer, source) VALUES
 ('pickup_line_costs', 'unit_cost', 'build_pickup_plan / trg_stop_line_cost_fill / trg_stop_line_cost_follow / trg_stock_movement_apply',
  'سعر شراء العرض أو متوسط المخزن؛ الفعلي عند السحب من المخزن');
