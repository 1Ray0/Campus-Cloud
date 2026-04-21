/**
 * AvailabilityPanel
 * 可申請時段選擇器：7 天日期列 + 小時格狀選擇
 *
 * Props:
 *   draft     { resource_type, cores, memory, disk_size?, rootfs_size?, gpu_required? }
 *   onChange  ({ start_at: string|null, end_at: string|null }) => void
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { VmRequestAvailabilityService } from "../../services/vmRequestAvailability";
import styles from "./AvailabilityPanel.module.scss";

const MIcon = ({ name, size = 16 }) => (
  <span className="material-icons-outlined" style={{ fontSize: size, lineHeight: 1 }}>
    {name}
  </span>
);

/* ── Helpers ── */
function isSelectable(slot) {
  return slot.status === "available" || slot.status === "limited";
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function getAllSlots(data) {
  if (!data) return [];
  return data.days
    .flatMap((day) => day.slots)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
}

function getSelectableRange(data, startAt, endAt) {
  if (!data || !startAt) return [];
  const slots = getAllSlots(data);
  const si = slots.findIndex((s) => s.start_at === startAt);
  if (si < 0) return [];
  if (!endAt) return isSelectable(slots[si]) ? [slots[si]] : [];
  const ei = slots.findIndex((s) => s.start_at === endAt);
  if (ei < si) return [];
  const range = slots.slice(si, ei + 1);
  return range.every(isSelectable) ? range : [];
}

/* Whether a not-yet-ended slot can complete the range from rangeStartAt */
function canCompleteRange(data, rangeStartAt, slot) {
  if (!rangeStartAt) return isSelectable(slot);
  if (!isSelectable(slot)) return false;
  if (slot.start_at === rangeStartAt) return true;
  const startTime = new Date(rangeStartAt).getTime();
  const slotTime  = new Date(slot.start_at).getTime();
  if (slotTime <= startTime) return true; // can reset start
  return getSelectableRange(data, rangeStartAt, slot.start_at).length > 0;
}

function isDraftReady(draft) {
  if (!draft?.resource_type || !draft?.cores || !draft?.memory) return false;
  if (draft.resource_type === "vm") return Boolean(draft.disk_size);
  return Boolean(draft.rootfs_size);
}

/* ── Slot button ── */
function SlotButton({ slot, inRange, isStart, isEnd, clickable, onClick }) {
  const statusCls = {
    available:      styles.slotAvailable,
    limited:        styles.slotLimited,
    unavailable:    styles.slotUnavailable,
    policy_blocked: styles.slotBlocked,
  }[slot.status] ?? "";

  return (
    <button
      type="button"
      disabled={!clickable}
      className={`${styles.slot} ${statusCls} ${inRange ? styles.slotInRange : ""} ${isStart ? styles.slotStart : ""} ${isEnd ? styles.slotEnd : ""}`}
      onClick={onClick}
    >
      <span className={styles.slotTime}>{formatHour(slot.hour)}</span>
      <span className={styles.slotLabel}>
        {isStart ? "起點" : isEnd ? "終點" : "\u00A0"}
      </span>
    </button>
  );
}

/* ── Main component ── */
export default function AvailabilityPanel({ draft, onChange }) {
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [rangeStartAt, setRangeStartAt] = useState(null);
  const [rangeEndAt, setRangeEndAt]     = useState(null);

  /* Stable ref to onChange to avoid re-fetch loop */
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  /* Fetch availability when draft changes */
  const draftReady = isDraftReady(draft);
  const draftKey = draftReady
    ? `${draft.resource_type}|${draft.cores}|${draft.memory}|${draft.disk_size ?? ""}|${draft.rootfs_size ?? ""}|${draft.gpu_required ?? 0}`
    : null;

  useEffect(() => {
    if (!draftKey) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    VmRequestAvailabilityService.preview(draft)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setSelectedDate(res.days[0]?.date ?? null);
        setRangeStartAt(null);
        setRangeEndAt(null);
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Notify parent of range changes */
  useEffect(() => {
    const range = getSelectableRange(data, rangeStartAt, rangeEndAt);
    const first = range[0];
    const last  = range[range.length - 1];
    onChangeRef.current?.({
      start_at: first?.start_at ?? null,
      end_at:   last?.end_at   ?? null,
    });
  }, [data, rangeStartAt, rangeEndAt]);

  /* Derived */
  const selectedDay = useMemo(
    () => data?.days.find((d) => d.date === selectedDate) ?? data?.days[0],
    [data, selectedDate],
  );
  const selectedRange = useMemo(
    () => getSelectableRange(data, rangeStartAt, rangeEndAt),
    [data, rangeStartAt, rangeEndAt],
  );

  /* Click handler for a slot */
  function handleSlotClick(slot) {
    if (!rangeStartAt || rangeEndAt) {
      setRangeStartAt(slot.start_at);
      setRangeEndAt(null);
      return;
    }
    const startTime = new Date(rangeStartAt).getTime();
    const slotTime  = new Date(slot.start_at).getTime();
    if (slotTime <= startTime) {
      setRangeStartAt(slot.start_at);
      setRangeEndAt(null);
      return;
    }
    const range = getSelectableRange(data, rangeStartAt, slot.start_at);
    if (range.length > 0) {
      setRangeEndAt(slot.start_at);
    } else {
      setRangeStartAt(slot.start_at);
      setRangeEndAt(null);
    }
  }

  /* ── Not ready ── */
  if (!draftReady) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <MIcon name="schedule" size={16} />
          <span className={styles.title}>可申請時段</span>
        </div>
        <p className={styles.hint}>先填完基本規格後，再選日期與連續時段。</p>
      </div>
    );
  }

  /* ── Loading ── */
  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <MIcon name="schedule" size={16} />
          <span className={styles.title}>可申請時段</span>
        </div>
        <div className={styles.skeletonWrap}>
          <div className={`${styles.skeleton} ${styles.skeletonDates}`} />
          <div className={`${styles.skeleton} ${styles.skeletonGrid}`} />
        </div>
      </div>
    );
  }

  /* ── Error ── */
  if (error || !data) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <MIcon name="schedule" size={16} />
          <span className={styles.title}>可申請時段</span>
        </div>
        <p className={`${styles.hint} ${styles.hintError}`}>
          目前無法取得時段資料，請稍後再試。
        </p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <MIcon name="schedule" size={16} />
        <span className={styles.title}>可申請時段</span>
      </div>
      <p className={styles.hint}>
        先選起始時段，再到任意日期選結束時段，可跨天選擇連續時段。
      </p>

      {/* Selected range summary */}
      {selectedRange.length > 0 && (
        <div className={styles.summary}>
          <MIcon name="check_circle" size={14} />
          <span>
            {new Date(selectedRange[0].start_at).toLocaleString("zh-TW", {
              month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
            })}
            {" → "}
            {new Date(selectedRange[selectedRange.length - 1].end_at).toLocaleString("zh-TW", {
              month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
            })}
            {`（${selectedRange.length} 小時）`}
          </span>
        </div>
      )}

      {/* Date pills */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>日期</div>
        <div className={styles.datePills}>
          {data.days.map((day) => {
            const active = day.date === (selectedDay?.date);
            return (
              <button
                key={day.date}
                type="button"
                className={`${styles.datePill} ${active ? styles.datePillActive : ""}`}
                onClick={() => setSelectedDate(day.date)}
              >
                {day.date}
              </button>
            );
          })}
        </div>
      </div>

      {/* Time slot grid */}
      {selectedDay && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>時段</div>
          <div className={styles.slotGrid}>
            {selectedDay.slots.map((slot) => {
              const clickable = canCompleteRange(data, rangeStartAt, slot) ||
                (!rangeStartAt && isSelectable(slot));
              const inRange = selectedRange.some((s) => s.start_at === slot.start_at);
              return (
                <SlotButton
                  key={slot.start_at}
                  slot={slot}
                  inRange={inRange}
                  isStart={rangeStartAt === slot.start_at}
                  isEnd={rangeEndAt === slot.start_at}
                  clickable={clickable}
                  onClick={() => handleSlotClick(slot)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className={styles.legend}>
        {[
          { cls: styles.slotAvailable,  label: "可申請" },
          { cls: styles.slotLimited,    label: "名額有限" },
          { cls: styles.slotUnavailable,label: "已滿" },
          { cls: styles.slotBlocked,    label: "政策限制" },
        ].map((item) => (
          <div key={item.label} className={styles.legendItem}>
            <span className={`${styles.legendDot} ${item.cls}`} />
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
