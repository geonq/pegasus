// Which way `to` lies from `from` on screen.
function directionBetween(
  from: { left: number; top: number } | undefined,
  to: { left: number; top: number } | undefined,
  orientation: "horizontal" | "vertical"
) {
  if (!from || !to) {
    return "none"
  }
  const [a, b] =
    orientation === "vertical" ? [from.top, to.top] : [from.left, to.left]
  if (b === a) {
    return "none"
  }
  if (orientation === "vertical") {
    return b > a ? "down" : "up"
  }
  return b > a ? "right" : "left"
}

export { directionBetween }
