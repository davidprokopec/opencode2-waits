import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionInbox } from "@opencode-ai/schema/session-inbox"
import { Effect } from "effect"

export interface Definition {
  readonly name: string
  readonly description: string
  readonly template: string
}

/**
 * The fallback trigger for clients without a plugin runtime — the web and
 * desktop apps only list plugins in settings, they cannot run one. Each of
 * these submits its template as a prompt, so it costs one model turn: the
 * template's only job is to make the agent call the matching tool once, with
 * the argument text passed straight through. In the TUI the client-side slash
 * commands intercept /wait before submission, so these never fire there.
 */
export const definitions: ReadonlyArray<Definition> = [
  {
    name: "wait",
    description: "Send a prompt to this session after a delay, e.g. /wait 1hour do it",
    template: [
      "The user wants a prompt delivered later, not now.",
      "",
      "Call the `wait_schedule` tool exactly once with:",
      "",
      "- `duration`: $1",
      "- `prompt`: the text between the OPENCODE_WAIT_PROMPT markers below, copied verbatim,",
      "  without the marker lines",
      "",
      "OPENCODE_WAIT_PROMPT",
      "$2",
      "OPENCODE_WAIT_PROMPT",
      "",
      "Do not start the requested work, do not read any files, and do not call any other tool.",
      "After `wait_schedule` returns, reply with one short line repeating what it reported.",
    ].join("\n"),
  },
  {
    name: "wait-list",
    description: "Browse pending scheduled prompts and cancel one",
    template: [
      "Call the `wait_list` tool exactly once and do not call any other tool.",
      "Reply with its output and nothing else.",
    ].join("\n"),
  },
  {
    name: "wait-cancel",
    description: "Cancel a scheduled prompt by id, or all of them",
    template: [
      "Call the `wait_cancel` tool exactly once and do not call any other tool.",
      "",
      "The user wrote: $ARGUMENTS",
      "",
      "If that text is `all`, call the tool with `all` set to true.",
      "Otherwise call the tool with `id` set to that text exactly.",
      "If the text is empty, call the tool with no arguments.",
      "Reply with the tool's output and nothing else.",
    ].join("\n"),
  },
]

/**
 * The slice of the OpenCode session API a command needs to submit its
 * template, kept narrow like `Delivery.SessionPort` so the server plugin
 * context and a plain client both satisfy it.
 */
export interface SessionPort {
  readonly prompt: (input: {
    readonly sessionID: Session.ID
    readonly text: string
    readonly files?: PromptInput.Prompt["files"]
    readonly agents?: PromptInput.Prompt["agents"]
    readonly skills?: PromptInput.Prompt["skills"]
    readonly delivery?: SessionInbox.Delivery
  }) => Effect.Effect<unknown, unknown>
}

/** What the host hands an executable command when the user runs it. */
export interface Invocation {
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt
  readonly delivery: SessionInbox.Delivery
}

/** Structural mirror of the host's `CommandDefinition`. */
export interface Command {
  readonly name: string
  readonly description: string
  readonly execute: (input: Invocation) => Effect.Effect<void, unknown>
}

const token = /\$(ARGUMENTS|[1-9][0-9]*)/g

/** The highest `$n` the template refers to, so the last one can absorb the
 * rest of the argument text. */
const arity = (template: string): number => {
  let highest = 0
  for (const match of template.matchAll(token)) {
    const name = match[1]
    if (name !== undefined && name !== "ARGUMENTS") highest = Math.max(highest, Number(name))
  }
  return highest
}

/** Splits on whitespace until one placeholder is left, which takes everything
 * that remains: `/wait 1hour do the thing` gives `$1` the duration and `$2`
 * the whole prompt, spaces included. */
const positional = (args: string, count: number): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let rest = args
  while (parts.length < count - 1) {
    const boundary = rest.search(/\s/)
    if (boundary < 0) break
    parts.push(rest.slice(0, boundary))
    rest = rest.slice(boundary + 1).trimStart()
  }
  // Left off rather than pushed as `""` so a missing argument renders empty.
  if (rest !== "") parts.push(rest)
  return parts
}

/**
 * Expands `$ARGUMENTS` and `$1`..`$n` in a template.
 *
 * The host did this itself while a command was only a template; an executable
 * command is handed the raw argument text instead. A replacer function is used
 * rather than a replacement string so `$&` or `$1` typed by the user is
 * inserted verbatim, and the single pass keeps substituted text from being
 * expanded again.
 */
export const render = (template: string, args: string): string => {
  const text = args.trim()
  const parts = positional(text, arity(template))
  return template.replace(token, (_match, name: string) =>
    name === "ARGUMENTS" ? text : (parts[Number(name) - 1] ?? ""),
  )
}

/**
 * Turns a definition into an executable command that submits the rendered
 * template, carrying the invocation's attachments and delivery over so an
 * `@file` mention still reaches the agent.
 */
export const command = (definition: Definition, session: SessionPort): Command => ({
  name: definition.name,
  description: definition.description,
  execute: (input) =>
    session
      .prompt({
        sessionID: input.sessionID,
        text: render(definition.template, input.prompt.text),
        files: input.prompt.files,
        agents: input.prompt.agents,
        skills: input.prompt.skills,
        delivery: input.delivery,
      })
      .pipe(Effect.asVoid),
})
