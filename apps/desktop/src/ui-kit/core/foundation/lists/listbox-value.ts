// The selected value of a listbox, shared by Select and Combobox: which items
// it holds, their labels, toggling one, and the keys it submits as. A value is
// one item's value or `null`, or a list with `multiple`, and values may be
// objects: keys are their strings, from `itemToValue`.
import { type Listbox } from "./listbox"
import { pageLocale } from "../text/locale"
import { deriveFromOptions } from "../kernel/derive"
import { type Store, sameValue } from "../kernel/store"

const listFormats = new Map<string | undefined, Intl.ListFormat>()

/**
 * Labels as one text. Without `maxLabels`, joined with commas. With it, the first
 * `maxLabels` and a count of the rest, joined the way the page's language joins a
 * list: "Apple, Banana and 2 more".
 */
function formatLabels(
  labels: readonly string[],
  {
    maxLabels,
    getMoreLabel = (count) => `${count} more`,
  }: { maxLabels?: number; getMoreLabel?: (count: number) => string } = {}
) {
  if (maxLabels === undefined) {
    return labels.join(", ")
  }
  const shown =
    labels.length > maxLabels
      ? [...labels.slice(0, maxLabels), getMoreLabel(labels.length - maxLabels)]
      : labels
  if (typeof Intl.ListFormat !== "function") {
    return shown.join(", ")
  }
  const locale = pageLocale()
  let format = listFormats.get(locale)
  if (!format) {
    listFormats.set(
      locale,
      (format = new Intl.ListFormat(locale, { type: "conjunction" }))
    )
  }
  return format.format(shown)
}

// One value, nothing, or a list, as a list.
function listOf(value: unknown) {
  return Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value]
}

// Whether a memo made from one value holds `value`: the same single value, or
// a list with the same items.
const holds = (
  memo: { value: unknown; values: readonly unknown[] },
  value: unknown
) =>
  Array.isArray(value) ? sameValue(memo.values, value) : memo.value === value

function createValueSelection(config: {
  store: Store<{
    value: unknown
    initial: unknown
    multiple: boolean
    labels: number
  }>
  options: () => {
    itemToValue?: (value: unknown) => string
    itemToLabel?: (value: unknown) => string
    isItemEqualToValue?: (itemValue: unknown, value: unknown) => boolean
  }
  listbox: Listbox
  toKey: (value: unknown) => string
  onDestroy: (cleanup: () => void) => void
}) {
  const { store, options, listbox, toKey, onDestroy } = config
  // The keys of the last value read, so items asking whether they're selected
  // share one lookup instead of mapping the value each. Renderers hand a list
  // changed in place over as a new copy (`createListSnapshots`). The memo
  // keeps its own copy and compares items too, so a `setOptions` caller that
  // changed its list in place reads the new keys, though nothing re-renders
  // for it: the store and `keepListing` compare by identity. It compares
  // items only after the options were handed over, so a render that asks
  // once per item stays linear.
  let keysMemo:
    | {
        value: unknown
        options: object
        itemToValue: unknown
        values: unknown[]
        keys: string[]
        set: Set<string>
        restoring: Restoring | undefined
      }
    | undefined
  let labelsQueued = false
  let learned = false
  let lastLabels: string[] = []
  // A restored value's slots still waiting for their items, which submit their saved keys meanwhile.
  let restoring: Restoring | undefined
  let stopWaiting: (() => void) | undefined
  let filling = false
  onDestroy(stopRestoring)

  // A list that starts or stops holding several values keeps what was chosen,
  // in its new shape, unless the value is controlled.
  deriveFromOptions(
    { store },
    ["value", "initial"],
    (synced, state, next: { value?: unknown }) => {
      if (synced.multiple === undefined || synced.multiple === state.multiple) {
        return
      }
      const shaped = (value: unknown) =>
        synced.multiple
          ? listOf(value)
          : Array.isArray(value)
            ? (value[0] ?? null)
            : value
      return {
        initial: shaped(state.initial),
        ...(next.value === undefined && { value: shaped(state.value) }),
      }
    }
  )

  function memoFor(value: unknown) {
    const given = options()
    const { itemToValue } = given
    const waiting = restoring?.value === value ? restoring : undefined
    const memo = keysMemo?.restoring === waiting ? keysMemo : undefined
    if (memo && memo.value === value && memo.options === given) {
      return memo
    }
    if (memo && memo.itemToValue === itemToValue && holds(memo, value)) {
      memo.value = value
      memo.options = given
      return memo
    }
    const values = [...listOf(value)]
    const keys = values.map(
      (item, index) => waiting?.keys.get(index) ?? toKey(item)
    )
    return (keysMemo = {
      value,
      options: given,
      itemToValue,
      values,
      keys,
      set: new Set(keys),
      restoring: waiting,
    })
  }

  function stopRestoring() {
    stopWaiting?.()
    stopWaiting = restoring = undefined
  }

  // Items that arrive take their slots with no change: the value still names the same keys.
  function fillArrived() {
    const current = restoring
    if (!current) {
      return
    }
    if (store.get().value !== current.value) {
      return stopRestoring()
    }
    const values = [...listOf(current.value)]
    const keys = new Map(current.keys)
    for (const [index, key] of current.keys) {
      const value = listbox.valueOf(key)
      if (value === undefined) {
        continue
      }
      values[index] = value
      keys.delete(index)
    }
    if (keys.size === current.keys.size) {
      return
    }
    const value = Array.isArray(current.value) ? values : values[0]
    if (keys.size) {
      restoring = { value, keys }
    } else {
      stopRestoring()
    }
    filling = true
    try {
      store.set({ value })
    } finally {
      filling = false
    }
  }

  const values = () => memoFor(store.get().value).values
  const keys = () => memoFor(store.get().value).keys

  // Whether an item is selected: by key, or by `isItemEqualToValue` for object
  // values that aren't the same object.
  function isSelected(key: string, itemValue?: unknown) {
    const equal = options().isItemEqualToValue
    if (equal && itemValue !== undefined) {
      return values().some((value) => equal(itemValue, value))
    }
    return memoFor(store.get().value).set.has(key)
  }

  // The text a value shows: from `itemToLabel`, its item, or the value itself.
  function labelOf(value: unknown) {
    const itemToLabel = options().itemToLabel
    if (itemToLabel) {
      return itemToLabel(value)
    }
    const label = listbox.labelOf(toKey(value))
    if (label !== undefined) {
      return label
    }
    return typeof value === "string" ? value : toKey(value)
  }

  // The keys of the value whose items never mounted, so no label is known.
  const unlabeled = () =>
    keys().filter((key) => listbox.labelOf(key) === undefined)

  return {
    values,
    keys,
    // The keys of a value, for attributes that render from a state snapshot.
    keysOf: (value: unknown) => memoFor(value).keys,
    isSelected,
    labelOf,
    // Each value's label, the same list while nothing changed, so a part that reads it doesn't re-render.
    labels() {
      const next = values().map(labelOf)
      if (
        next.length !== lastLabels.length ||
        next.some((label, index) => label !== lastLabels[index])
      ) {
        lastLabels = next
      }
      return lastLabels
    },
    // A label learned from an item that's selected shows in the value. Batched,
    // since a long list registers all at once.
    queueLabels() {
      if (labelsQueued) {
        return
      }
      labelsQueued = true
      queueMicrotask(() => {
        labelsQueued = false
        store.set({ labels: listbox.labelsVersion() })
      })
    },
    // Learns the labels of values whose items haven't mounted, like on the
    // server. `find` answers for the keys with none, from the items among an
    // adapter's children. Only the first call looks, since it's for the
    // render before the items mount. Returns whether it found any.
    learn(
      find: (
        keys: ReadonlySet<string>
      ) => readonly { value: unknown; label: string }[]
    ) {
      if (learned || options().itemToLabel) {
        return false
      }
      learned = true
      const unknown = new Set(unlabeled())
      if (!unknown.size) {
        return false
      }
      const found = find(unknown)
      for (const { value, label } of found) {
        listbox.remember(toKey(value), label, value)
      }
      return found.length > 0
    },
    // Whether a closed list must mount its items hidden for the value: for a
    // label only its item knows, or for a value icon in the page, which copies
    // its item's icon. Not for a label the root found among its children.
    needsItems: (hasValueIcon: boolean) =>
      unlabeled().length > 0 || (hasValueIcon && keys().length > 0),
    // The value with an item added, or removed when it's there, for `multiple`.
    toggled(key: string, itemValue: unknown) {
      if (!isSelected(key, itemValue)) {
        return [...values(), itemValue]
      }
      return values().filter((value) => toKey(value) !== key)
    },
    // The value without one item's key, for removing a chip.
    without: (key: string) => values().filter((value) => toKey(value) !== key),
    // What selecting nothing is: `null`, or an empty list with `multiple`.
    empty: () => (store.get().multiple ? [] : null),
    // Sets the value a browser restored, from the keys it saved, through
    // `write`. Keys whose items haven't arrived hold their place until they
    // do, unless something sets the value first.
    restore(saved: string, write: (value: unknown) => void) {
      stopRestoring()
      let keys: string[] = []
      try {
        keys = JSON.parse(saved)
      } catch {}
      const { multiple } = store.get()
      if (!multiple) {
        keys = keys.slice(0, 1)
      }
      const waiting = new Map<number, string>()
      const found = keys.map((key, index) => {
        const value = listbox.valueOf(key)
        if (value === undefined) {
          waiting.set(index, key)
        }
        return value ?? key
      })
      const value = multiple ? found : (found[0] ?? null)
      if (!waiting.size) {
        return write(value)
      }
      const request = { value, keys: waiting }
      restoring = request
      write(value)
      // A callback may have canceled the restore, or set a value of its own.
      if (restoring !== request) {
        return
      }
      const held = store.get().value
      if (!sameValue(held, value)) {
        return stopRestoring()
      }
      restoring = { value: held, keys: waiting }
      stopWaiting = store.subscribe(fillArrived)
    },
    stopRestoring,
    // Whether the value changing now is a restore's late items taking their slots.
    isFilling: () => filling,
  }
}

type Restoring = { value: unknown; keys: ReadonlyMap<number, string> }

type ValueSelection = ReturnType<typeof createValueSelection>

export { createValueSelection, formatLabels, listOf, type ValueSelection }
