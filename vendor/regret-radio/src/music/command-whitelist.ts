/**
 * Music command whitelist + arg-shape validation for the DSH command-injection
 * endpoint (design §4.1). Pure and side-effect free so it can be unit-tested.
 *
 * Only the 17 music action tools from upstream tools-schema (minus
 * show_weather / set_assistant_name, which are stripped with the A-side) are
 * allowed. Each command's args are validated structurally (no regex — the
 * model decides semantics), and invalid args reject with null so the endpoint
 * returns 400 instead of forwarding a malformed command into the player.
 */
export type CommandArgs = Record<string, unknown>

/** A whitelist entry: returns cleaned args, or null when args are invalid. */
export type CommandCheck = (args: CommandArgs) => CommandArgs | null

/** The 17 whitelisted music action tools. */
export const ALLOWED_COMMANDS: Record<string, CommandCheck> = {
  player_next: () => ({}),
  player_prev: () => ({}),
  player_toggle: () => ({}),
  player_pause: () => ({}),
  player_play: () => ({}),
  set_play_mode: (a) => (a && ["loop", "single", "shuffle"].includes(a.mode as string) ? { mode: a.mode as string } : null),
  player_volume: (a) => {
    // delta (relative -1..1) / set (absolute 0..1): pass exactly one — both
    // given is an invalid protocol violation (reject, don't silently ignore).
    const hasDelta = a?.delta !== undefined
    const hasSet = a?.set !== undefined
    if (!hasDelta && !hasSet) return {}
    if (hasDelta && hasSet) return null
    if (hasDelta) {
      return typeof a.delta === "number" && a.delta >= -1 && a.delta <= 1 ? { delta: a.delta } : null
    }
    return typeof a.set === "number" && a.set >= 0 && a.set <= 1 ? { set: a.set } : null
  },
  search_music: (a) => (typeof a?.query === "string" && a.query.trim() ? { query: a.query.trim() } : null),
  play_song: (a) => (typeof a?.query === "string" && a.query.trim() ? { query: a.query.trim() } : null),
  play_stage_index: (a) => (Number.isInteger(a?.index) && (a!.index as number) >= 1 ? { index: a!.index as number } : null),
  queue_add_song: (a) => (typeof a?.query === "string" && a.query.trim() ? { query: a.query.trim() } : null),
  queue_add_index: (a) => (Number.isInteger(a?.index) && (a!.index as number) >= 1 ? { index: a!.index as number } : null),
  play_queue_index: (a) => (Number.isInteger(a?.index) && (a!.index as number) >= 1 ? { index: a!.index as number } : null),
  queue_remove: (a) => (Number.isInteger(a?.index) && (a!.index as number) >= 1 ? { index: a!.index as number } : null),
  queue_clear: () => ({}),
  remove_current: () => ({}),
  rate_song: (a) => (a && typeof a.liked === "boolean" ? { liked: a.liked } : null),
}

/** Is `name` a whitelisted command? */
export function isAllowedCommand(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, name)
}

/**
 * Validate + clean args for one whitelisted command.
 * @returns cleaned args, or null when not allowed / args invalid.
 */
export function validateCommandArgs(name: string, args: unknown): CommandArgs | null {
  const check = ALLOWED_COMMANDS[name]
  if (check === undefined) return null
  const raw = (args && typeof args === "object") ? (args as CommandArgs) : {}
  try {
    return check(raw)
  } catch {
    return null
  }
}
