-- 0011 — أوقات الدفعة لا ترجع إلى الخلف.
--
-- السبب المقيس (حلقة التشغيل العشرينية، التشغيل 7): ساعة حاوية القاعدة رجعت 1.7 ثانية بين الإشعار
-- والانطلاق، فكُتب departed_at قبل notified_at وسقط القيد order_batches_check. القاعدة («لا انطلاق قبل
-- الإشعار» §4.3) صحيحة؛ الخلل أن الوقتين من now() مباشرة. الإصلاح: الوقت اللاحق لا يقلّ عن السابق.
-- الدالة نفسها من 0001 بلا تغيير آخر.

CREATE OR REPLACE FUNCTION trg_batch_before() RETURNS trigger AS $$
DECLARE r text; o orders; payload jsonb; cust_user bigint; nid bigint;
BEGIN
    r := writer_role();
    SELECT * INTO o FROM orders WHERE id = NEW.order_id;
    IF r NOT IN ('trigger') THEN
        IF r <> 'driver' OR o.driver_id IS DISTINCT FROM (SELECT id FROM drivers WHERE user_id = actor_id()) THEN
            RAISE EXCEPTION 'forbidden_not_assigned' USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    IF o.status NOT IN ('collecting', 'partially_delivered') THEN
        RAISE EXCEPTION 'order_not_collecting: %', o.status USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'planned' THEN
            RAISE EXCEPTION 'batch_must_start_planned' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        IF OLD.status <> 'planned' AND (NEW.eta_at IS DISTINCT FROM OLD.eta_at
                                        OR NEW.next_eta_at IS DISTINCT FROM OLD.next_eta_at) THEN
            RAISE EXCEPTION 'batch_notice_sent_is_immutable' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF (OLD.status, NEW.status) NOT IN (('planned', 'notified'), ('notified', 'departed'),
                                        ('departed', 'delivered')) THEN
        RAISE EXCEPTION 'invalid_batch_transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'notified' THEN
        IF NOT EXISTS (SELECT 1 FROM order_batch_lines WHERE batch_id = NEW.id) THEN
            RAISE EXCEPTION 'batch_empty' USING ERRCODE = 'check_violation';
        END IF;
        payload := batch_notice_payload(NEW.id);
        -- ما سيصل لاحقاً يحتاج موعداً (§4.3)
        IF jsonb_array_length(payload->'later') > 0 AND NEW.next_eta_at IS NULL THEN
            RAISE EXCEPTION 'batch_notice_needs_later_eta' USING ERRCODE = 'check_violation';
        END IF;
        payload := jsonb_set(payload, '{later_eta}', coalesce(to_jsonb(NEW.next_eta_at), 'null'::jsonb));
        payload := jsonb_set(payload, '{eta}', coalesce(to_jsonb(NEW.eta_at), 'null'::jsonb));
        FOR cust_user IN SELECT user_id FROM customer_members WHERE customer_id = o.customer_id LOOP
            INSERT INTO notifications (user_id, kind, order_id, batch_id, title, body, payload, channels)
            VALUES (cust_user, 'batch_departure', o.id, NEW.id, 'دفعة في الطريق',
                    'تصل الآن ' || jsonb_array_length(payload->'now') || ' أصناف'
                    || CASE WHEN jsonb_array_length(payload->'later') > 0
                            THEN '، والباقي لاحقاً' ELSE '' END,
                    payload, ARRAY['push', 'sms']::notification_channel[])
            RETURNING id INTO nid;
        END LOOP;
        IF nid IS NULL THEN
            RAISE EXCEPTION 'batch_notice_no_recipient' USING ERRCODE = 'check_violation';
        END IF;
        NEW.notification_id := nid;
        NEW.notified_at := now();
    ELSIF NEW.status = 'departed' THEN
        -- الانطلاق بعد الإشعار بالتسلسل لا بساعة الخادم: ساعة ترجع ثانية لا تكسر القاعدة (0011)
        NEW.departed_at := greatest(now(), OLD.notified_at);
    ELSIF NEW.status = 'delivered' THEN
        NEW.delivered_at := greatest(now(), OLD.departed_at);
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
