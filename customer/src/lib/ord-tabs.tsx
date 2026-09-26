/** قسما «الطلبات» كما في اللوحتين: طلباتي | قوائمي (الشريط السفلي أربعة أقسام، فالقوائم تحت الطلبات). */
import { Link } from "react-router-dom";

import { cx } from "@ui/kit";

const ON = "bg-primary text-on-primary font-bold border border-primary";
const OFF = "bg-surface text-ink border border-border-strong";

export function OrdersTabs({ active }: { active: "orders" | "lists" }) {
  const tab = (key: "orders" | "lists", to: string, label: string) =>
    key === active ? (
      <span role="tab" aria-selected className={cx("text-center p-2.5 rounded-md text-15", ON)}>{label}</span>
    ) : (
      <Link role="tab" aria-selected={false} to={to} className={cx("text-center p-2.5 rounded-md text-15 no-underline", OFF)}>{label}</Link>
    );
  return (
    <div role="tablist" className="grid grid-cols-2 gap-1.5">
      {tab("orders", "/orders", "طلباتي")}
      {tab("lists", "/lists", "قوائمي")}
    </div>
  );
}
