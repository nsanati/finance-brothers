import React from "react";

const COLORS = ["#2F47D6", "#0E7A4E", "#C2362F", "#9A4DCC", "#D07A00", "#0B7E8C", "#B8336A", "#5B6B1F"];
export const colorFor = (id = "") => {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};
const initials = (n = "?") => n.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export function Avatar({ person, size = 34 }) {
  return (
    <span className="avatar" style={{ background: colorFor(person?.id), width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials(person?.display_name)}
    </span>
  );
}

export function Sheet({ title, onClose, children }) {
  React.useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn link" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
      {action}
    </div>
  );
}

export const todayISO = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const toCents = (v) => Math.round(parseFloat(String(v).replace(/[^0-9.]/g, "")) * 100);
