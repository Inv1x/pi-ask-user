/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: configured selection keys or number keys to pick
 * - "Write my own answer" opens an inline editor (configured cancel returns to options)
 * - Cancelling the options dismisses the question (the model is told you declined)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	stripTerminalSequences,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	ASK_USER_PARAMETER_DESCRIPTIONS,
	ASK_USER_PROMPT_GUIDELINES,
	ASK_USER_PROMPT_SNIPPET,
	ASK_USER_TOOL_DESCRIPTION,
	buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const OVERLAY_POLL_MS = 25;

async function waitForOverlaysToClose(
	tui: TUI,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!tui.hasOverlay() || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const check = () => {
			if (signal?.aborted || !tui.hasOverlay()) {
				finish();
				return;
			}
			timer = setTimeout(check, OVERLAY_POLL_MS);
			timer.unref?.();
		};
		signal?.addEventListener("abort", finish, { once: true });
		check();
	});
}

const OptionSchema = Type.Object(
	{
		label: Type.String({
			minLength: 1,
			pattern: "\\S",
			description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
		}),
		description: Type.Union([Type.String(), Type.Null()], {
			description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
		}),
	},
	{ additionalProperties: false },
);

const AskUserParams = Type.Object(
	{
		question: Type.String({
			minLength: 1,
			pattern: "\\S",
			description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
		}),
		options: Type.Array(OptionSchema, {
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
		}),
	},
	{ additionalProperties: false },
);

export type AskUserInput = Static<typeof AskUserParams>;

function prepareAskUserArguments(args: unknown): AskUserInput {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return args as AskUserInput;
	}
	const input = args as Record<string, unknown>;
	if (!Array.isArray(input.options)) return args as AskUserInput;
	return {
		...input,
		options: input.options.map((option) =>
			option && typeof option === "object" && !Array.isArray(option)
				? { description: null, ...option }
				: option,
		),
	} as AskUserInput;
}

type AskUserDetails = {
	question: string;
	options: Array<{
		label: string;
		description: string | null;
	}>;
	answer: string | null;
	selectedIndex: number | null;
	wasCustom: boolean;
	cancelled: boolean;
	dismissal: "user" | "aborted" | "no-ui" | null;
};

type SelectionResult =
	| {
			kind: "answer";
			answer: string;
			wasCustom: boolean;
			index?: number;
	  }
	| { kind: "dismissed" }
	| { kind: "cancelled" };

interface DisplayOption {
	label: string;
	description?: string;
	isOther?: boolean;
}

function isUnsafeModelControl(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		codePoint <= 0x08 ||
		codePoint === 0x0b ||
		codePoint === 0x0c ||
		(codePoint >= 0x0e && codePoint <= 0x1f) ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

function sanitizeText(text: string, multiline = false): string {
	const normalized = [...stripTerminalSequences(text).replace(/\r\n?/g, "\n")]
		.filter((character) => !isUnsafeModelControl(character))
		.join("");
	return multiline
		? normalized.replace(/\t/g, " ")
		: normalized.replace(/[\n\t]+/g, " ");
}

export default function askUser(pi: ExtensionAPI): void {
	pi.registerTool<typeof AskUserParams, AskUserDetails>({
		name: "ask_user",
		label: "Ask User",
		description: ASK_USER_TOOL_DESCRIPTION,
		promptSnippet: ASK_USER_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
		parameters: AskUserParams,
		prepareArguments: prepareAskUserArguments,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (
				params.options.length < MIN_OPTIONS ||
				params.options.length > MAX_OPTIONS
			) {
				throw new Error(
					`ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
				);
			}

			const question = sanitizeText(params.question, true).trim();
			if (!question) {
				throw new Error(
					"ask_user question must be nonblank after sanitization. Retry with a valid question.",
				);
			}

			const options = params.options.map((option, index) => {
				const label = sanitizeText(option.label).trim();
				if (!label) {
					throw new Error(
						`ask_user option ${index + 1} label must be nonblank after sanitization. Retry with valid option labels.`,
					);
				}
				return {
					label,
					description:
						typeof option.description === "string"
							? sanitizeText(option.description)
							: undefined,
				};
			});
			const labels = new Set<string>();
			for (const option of options) {
				if (labels.has(option.label)) {
					throw new Error(
						`ask_user option labels must be unique after sanitization (duplicate: ${JSON.stringify(option.label)}). Retry with distinct option labels.`,
					);
				}
				labels.add(option.label);
			}

			const reply = (
				text: string,
				answer: string | null = null,
				wasCustom = false,
				selectedIndex: number | null = null,
				dismissal: AskUserDetails["dismissal"] = null,
			) => ({
				content: [{ type: "text" as const, text }],
				details: {
					question,
					options: options.map((option) => ({
						label: option.label,
						description: option.description ?? null,
					})),
					answer,
					selectedIndex,
					wasCustom,
					cancelled: answer === null,
					dismissal,
				} satisfies AskUserDetails,
			});

			if (ctx.mode !== "tui") {
				return reply(
					buildAskUserResultMessage({ kind: "no-ui" }),
					null,
					false,
					null,
					"no-ui",
				);
			}

			if (signal?.aborted) {
				return reply(
					buildAskUserResultMessage({ kind: "cancelled" }),
					null,
					false,
					null,
					"aborted",
				);
			}

			const allOptions: DisplayOption[] = [
				...options,
				{ label: "Write my own answer…", isOther: true },
			];

			const result = await ctx.ui.custom<SelectionResult>(
				(tui, theme, keybindings, done) => {
					const createQuestion = () => {
						let optionIndex = 0;
						let editMode = false;
						let cachedLines: string[] | undefined;
						let cachedWidth: number | undefined;
						let settled = false;
						let listeningForAbort = false;

						function removeAbortListener(): void {
							if (!listeningForAbort) return;
							signal?.removeEventListener("abort", cancel);
							listeningForAbort = false;
						}

						function finish(value: SelectionResult): void {
							if (settled) return;
							settled = true;
							removeAbortListener();
							done(value);
						}

						function cancel(): void {
							finish({ kind: "cancelled" });
						}

						const editorTheme: EditorTheme = {
							borderColor: (text) => theme.fg("accent", text),
							selectList: {
								selectedPrefix: (text) => theme.fg("accent", text),
								selectedText: (text) => theme.fg("accent", text),
								description: (text) => theme.fg("muted", text),
								scrollInfo: (text) => theme.fg("dim", text),
								noMatch: (text) => theme.fg("warning", text),
							},
						};
						const editor = new Editor(tui, editorTheme);

						editor.onSubmit = (value) => {
							const trimmed = sanitizeText(value.trim(), true);
							if (trimmed) {
								finish({
									kind: "answer",
									answer: trimmed,
									wasCustom: true,
								});
							} else {
								editMode = false;
								editor.setText("");
								refresh();
							}
						};

						function refresh(): void {
							cachedLines = undefined;
							cachedWidth = undefined;
							tui.requestRender();
						}

						function selectOption(index: number): void {
							const selected = allOptions[index];
							if (!selected) return;
							if (selected.isOther) {
								optionIndex = index;
								editMode = true;
								refresh();
							} else {
								finish({
									kind: "answer",
									answer: selected.label,
									wasCustom: false,
									index: index + 1,
								});
							}
						}

						function handleInput(data: string): void {
							if (editMode) {
								if (keybindings.matches(data, "tui.select.cancel")) {
									editMode = false;
									editor.setText("");
									refresh();
									return;
								}
								editor.handleInput(data);
								refresh();
								return;
							}

							if (
								data.length === 1 &&
								data >= "1" &&
								data <= String(allOptions.length)
							) {
								selectOption(Number(data) - 1);
								return;
							}

							if (keybindings.matches(data, "tui.select.up")) {
								optionIndex =
									(optionIndex - 1 + allOptions.length) % allOptions.length;
								refresh();
								return;
							}
							if (keybindings.matches(data, "tui.select.down")) {
								optionIndex = (optionIndex + 1) % allOptions.length;
								refresh();
								return;
							}

							if (keybindings.matches(data, "tui.select.confirm")) {
								selectOption(optionIndex);
								return;
							}

							if (keybindings.matches(data, "tui.select.cancel")) {
								finish({ kind: "dismissed" });
							}
						}

						function render(width: number): string[] {
							const renderWidth = Math.max(1, width);
							if (cachedLines && cachedWidth === renderWidth)
								return cachedLines;

							const lines: string[] = [];
							const addWrapped = (text: string): void => {
								lines.push(...wrapTextWithAnsi(text, renderWidth));
							};
							const addWrappedWithPrefix = (
								prefix: string,
								text: string,
							): void => {
								const prefixWidth = visibleWidth(prefix);
								if (prefixWidth >= renderWidth) {
									addWrapped(prefix + text);
									return;
								}
								const wrapped = wrapTextWithAnsi(
									text,
									renderWidth - prefixWidth,
								);
								const continuationPrefix = " ".repeat(prefixWidth);
								for (let index = 0; index < wrapped.length; index++) {
									lines.push(
										`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`,
									);
								}
							};

							lines.push(theme.fg("accent", "─".repeat(renderWidth)));
							addWrappedWithPrefix(" ", theme.fg("text", theme.bold(question)));
							lines.push("");

							for (let index = 0; index < allOptions.length; index++) {
								const option = allOptions[index];
								if (!option) continue;
								const selected = index === optionIndex;
								const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
								const marker = option.isOther ? "✎" : `${index + 1}.`;
								const label = `${marker} ${option.label}`;
								const color =
									selected || (option.isOther && editMode)
										? "accent"
										: option.isOther
											? "muted"
											: "text";
								addWrappedWithPrefix(prefix, theme.fg(color, label));

								if (option.description) {
									addWrappedWithPrefix(
										"      ",
										theme.fg("muted", option.description),
									);
								}
							}

							if (editMode) {
								lines.push("");
								addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
								const editorWidth = Math.max(1, renderWidth - 1);
								for (const line of editor.render(editorWidth)) {
									if (renderWidth > 1) {
										lines.push(` ${truncateToWidth(line, editorWidth, "")}`);
									} else {
										lines.push(truncateToWidth(line, renderWidth, ""));
									}
								}
							}

							lines.push("");
							if (editMode) {
								addWrappedWithPrefix(
									" ",
									theme.fg("dim", "Submit answer • Cancel back to options"),
								);
							} else {
								addWrappedWithPrefix(
									" ",
									theme.fg(
										"dim",
										`Use selection keys or 1-${allOptions.length} • Confirm select • Cancel dismiss`,
									),
								);
							}
							lines.push(theme.fg("accent", "─".repeat(renderWidth)));

							cachedLines = lines.map((line) =>
								visibleWidth(line) > renderWidth
									? truncateToWidth(line, renderWidth, "")
									: line,
							);
							cachedWidth = renderWidth;
							return cachedLines;
						}

						if (signal) {
							signal.addEventListener("abort", cancel, { once: true });
							listeningForAbort = true;
							if (signal.aborted) queueMicrotask(cancel);
						}

						return {
							render,
							invalidate: () => {
								cachedLines = undefined;
								cachedWidth = undefined;
							},
							handleInput,
							dispose: removeAbortListener,
						};
					};
					return tui.hasOverlay()
						? waitForOverlaysToClose(tui, signal).then(createQuestion)
						: createQuestion();
				},
			);

			if (result.kind === "cancelled") {
				return reply(
					buildAskUserResultMessage({ kind: "cancelled" }),
					null,
					false,
					null,
					"aborted",
				);
			}

			if (result.kind === "dismissed") {
				return reply(
					buildAskUserResultMessage({ kind: "dismissed" }),
					null,
					false,
					null,
					"user",
				);
			}

			if (result.wasCustom) {
				return reply(
					buildAskUserResultMessage({
						kind: "custom",
						answer: result.answer,
					}),
					result.answer,
					true,
				);
			}

			return reply(
				buildAskUserResultMessage({
					kind: "selected",
					answer: result.answer,
					index: result.index,
				}),
				result.answer,
				false,
				result.index ?? null,
			);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg(
				"muted",
				typeof args.question === "string"
					? sanitizeText(args.question, true)
					: "",
			);
			const options = Array.isArray(args.options)
				? (args.options as DisplayOption[])
				: [];
			if (options.length > 0) {
				const numbered = options.map(
					(option, index) =>
						`${index + 1}. ${sanitizeText(
							typeof option.label === "string" ? option.label : "",
						)}`,
				);
				text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.cancelled || details.answer === null) {
				return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "(wrote) ") +
						theme.fg("accent", sanitizeText(details.answer, true)),
					0,
					0,
				);
			}

			const safeAnswer = sanitizeText(details.answer, true);
			const display =
				typeof details.selectedIndex === "number"
					? `${details.selectedIndex}. ${safeAnswer}`
					: safeAnswer;
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("accent", display),
				0,
				0,
			);
		},
	});
}
