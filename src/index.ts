/**
 * ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
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

const OptionSchema = Type.Object({
	label: Type.String({
		description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
	}),
	description: Type.Optional(
		Type.String({
			description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
		}),
	),
});

const AskUserParams = Type.Object({
	question: Type.String({
		description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
	}),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
	cancelled: boolean;
}

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

function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		const words = paragraph.split(/\s+/).filter(Boolean);
		if (words.length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (const word of words) {
			const candidate = current ? `${current} ${word}` : word;
			if (candidate.length > width && current) {
				lines.push(current);
				current = word;
			} else {
				current = candidate;
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

export default function askUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_USER_TOOL_DESCRIPTION,
		promptSnippet: ASK_USER_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const reply = (
				text: string,
				answer: string | null = null,
				wasCustom = false,
			) => ({
				content: [{ type: "text" as const, text }],
				details: {
					question: params.question,
					options: params.options.map((option) => option.label),
					answer,
					wasCustom,
					cancelled: answer === null,
				} satisfies AskUserDetails,
			});

			if (
				params.options.length < MIN_OPTIONS ||
				params.options.length > MAX_OPTIONS
			) {
				throw new Error(
					`ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
				);
			}

			if (ctx.mode !== "tui") {
				return reply(buildAskUserResultMessage({ kind: "no-ui" }));
			}

			if (signal?.aborted) {
				return reply(buildAskUserResultMessage({ kind: "cancelled" }));
			}

			const allOptions: DisplayOption[] = [
				...params.options,
				{ label: "Write my own answer…", isOther: true },
			];

			const result = await ctx.ui.custom<SelectionResult>(
				(tui, theme, _keybindings, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;
					let settled = false;

					function finish(value: SelectionResult): void {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", cancel);
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
						const trimmed = value.trim();
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
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex =
								(optionIndex - 1 + allOptions.length) % allOptions.length;
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = (optionIndex + 1) % allOptions.length;
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

						if (matchesKey(data, Key.enter)) {
							selectOption(optionIndex);
							return;
						}

						if (matchesKey(data, Key.escape)) {
							finish({ kind: "dismissed" });
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (text: string) =>
							lines.push(truncateToWidth(text, width));

						const title = " Question ";
						add(
							theme.fg(
								"accent",
								`─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`,
							),
						);
						for (const line of wrapText(
							params.question,
							Math.max(10, width - 2),
						)) {
							add(` ${theme.fg("text", theme.bold(line))}`);
						}
						lines.push("");

						for (let index = 0; index < allOptions.length; index++) {
							const option = allOptions[index];
							if (!option) continue;
							const selected = index === optionIndex;
							const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
							const marker = option.isOther ? "✎" : `${index + 1}.`;
							const label = `${marker} ${option.label}`;

							if (selected || (option.isOther && editMode)) {
								add(prefix + theme.fg("accent", label));
							} else {
								add(
									prefix + theme.fg(option.isOther ? "muted" : "text", label),
								);
							}

							if (option.description) {
								add(`      ${theme.fg("muted", option.description)}`);
							}
						}

						if (editMode) {
							lines.push("");
							add(theme.fg("muted", " Your answer:"));
							for (const line of editor.render(Math.max(1, width - 2))) {
								add(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							add(theme.fg("dim", " Enter submit • Esc back to options"));
						} else {
							add(
								theme.fg(
									"dim",
									` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`,
								),
							);
						}
						add(theme.fg("accent", "─".repeat(Math.max(0, width))));

						cachedLines = lines;
						return lines;
					}

					signal?.addEventListener("abort", cancel, { once: true });
					if (signal?.aborted) queueMicrotask(cancel);

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
						dispose: () => {
							signal?.removeEventListener("abort", cancel);
						},
					};
				},
			);

			if (result.kind === "cancelled") {
				return reply(buildAskUserResultMessage({ kind: "cancelled" }));
			}

			if (result.kind === "dismissed") {
				return reply(buildAskUserResultMessage({ kind: "dismissed" }));
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
			);
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg(
				"muted",
				typeof args.question === "string" ? args.question : "",
			);
			const options = Array.isArray(args.options)
				? (args.options as DisplayOption[])
				: [];
			if (options.length > 0) {
				const numbered = options.map(
					(option, index) => `${index + 1}. ${option.label}`,
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
						theme.fg("accent", details.answer),
					0,
					0,
				);
			}

			const index = details.options.indexOf(details.answer) + 1;
			const display =
				index > 0 ? `${index}. ${details.answer}` : details.answer;
			return new Text(
				theme.fg("success", "✓ ") + theme.fg("accent", display),
				0,
				0,
			);
		},
	});
}
