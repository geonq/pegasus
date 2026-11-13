const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

/**
 * When a message was sent: "14:05" today, "12 Nov, 14:05" before, the full date on hover. Shown
 * only with the row's hover actions (T3 TimelineRowTimestamp, Orca NativeChatMessageTimestamp).
 */
export function MessageTime({ createdAt }: { readonly createdAt: string }) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date().toDateString() === date.toDateString();
  return (
    <time
      className="timeline-item__time"
      data-testid="message-time"
      dateTime={date.toISOString()}
      title={fullFormat.format(date)}
    >
      {(today ? timeFormat : dayTimeFormat).format(date)}
    </time>
  );
}
