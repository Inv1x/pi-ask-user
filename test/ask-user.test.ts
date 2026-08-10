import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsConfig,
	KeybindingsManager,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import askUser, { type AskUserInput } from "../src/index.ts";
import { buildAskUserResultMessage } from "../src/prompt.ts";

interface ResultDetails {
	question: string;
	options: string[];
	answer: string | null;
	selectedIndex: number | null;
	wasCustom: boolean;
	cancelled: boolean;
}

type ToolResult = AgentToolResult<unknown>;

type AskUserInvocation = Omit<AskUserInput, "options"> & {
	options: Array<
		Omit<AskUserInput["options"][number], "description"> & {
			description?: string | null;
		}
	>;
};

type TestComponent = Component & { dispose?: () => void };

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	prepareArguments?: (args: unknown) => AskUserInput;
	constrainedSampling?: unknown;
	executionMode?: string;
	execute(
		toolCallId: string,
		params: AskUserInvocation,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
};

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function registeredTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	askUser({
		registerTool(tool) {
			registered = tool as unknown as RegisteredTool;
		},
	} as ExtensionAPI);
	assert.ok(registered);
	return registered;
}

function textOf(result: ToolResult): string {
	const first = result.content[0];
	assert.equal(first?.type, "text");
	return first.type === "text" ? first.text : "";
}

function detailsOf(result: ToolResult): ResultDetails {
	return result.details as ResultDetails;
}

function keybindings(userBindings: KeybindingsConfig = {}): KeybindingsManager {
	return new KeybindingsManager(TUI_KEYBINDINGS, userBindings);
}

function startInteractive(
	tool: RegisteredTool,
	input: AskUserInvocation,
	options: {
		signal?: AbortSignal;
		keybindings?: KeybindingsManager;
		theme?: typeof identityTheme;
		onDone?: () => void;
	} = {},
): { component: TestComponent; execution: Promise<ToolResult> } {
	let component: TestComponent | undefined;
	const custom = (
		factory: (
			tui: unknown,
			theme: unknown,
			injectedKeybindings: KeybindingsManager,
			done: (result: unknown) => void,
		) => TestComponent,
	): Promise<unknown> =>
		new Promise((resolve) => {
			component = factory(
				{ requestRender() {} },
				options.theme ?? identityTheme,
				options.keybindings ?? keybindings(),
				(result) => {
					options.onDone?.();
					component?.dispose?.();
					resolve(result);
				},
			);
		});
	const execution = tool.execute("call-1", input, options.signal, undefined, {
		mode: "tui",
		ui: { custom },
	} as unknown as ExtensionContext);
	assert.ok(component);
	return { component, execution };
}

test("result messages preserve every model-facing outcome", () => {
	assert.equal(buildAskUserResultMessage({ kind: "cancelled" }), "Cancelled");
	assert.match(buildAskUserResultMessage({ kind: "no-ui" }), /plain text/);
	assert.match(buildAskUserResultMessage({ kind: "dismissed" }), /dismissed/);
	assert.equal(
		buildAskUserResultMessage({ kind: "custom", answer: "Something else" }),
		"User wrote their own answer: Something else",
	);
	assert.equal(
		buildAskUserResultMessage({
			kind: "selected",
			answer: "Second",
			index: 2,
		}),
		"User selected option 2: Second",
	);
});

test("tool metadata exposes a strict-preferred bounded schema", () => {
	const tool = registeredTool();
	assert.equal(tool.name, "ask_user");
	assert.equal(tool.label, "Ask User");
	assert.equal(tool.executionMode, "sequential");
	assert.match(tool.description, /2-5 options/);
	assert.match(tool.promptSnippet ?? "", /multiple-choice/);
	assert.ok(
		tool.promptGuidelines?.every((guideline) => guideline.includes("ask_user")),
	);
	assert.deepEqual(tool.constrainedSampling, {
		type: "json_schema",
		strict: "prefer",
	});
	assert.deepEqual(
		tool.prepareArguments?.({
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second", description: "Two" }],
		}),
		{
			question: "Choose one",
			options: [
				{ label: "First", description: null },
				{ label: "Second", description: "Two" },
			],
		},
	);

	const schema = tool.parameters as {
		additionalProperties?: boolean;
		required?: string[];
		properties?: {
			question?: { minLength?: number; pattern?: string };
			options?: {
				minItems?: number;
				maxItems?: number;
				items?: {
					additionalProperties?: boolean;
					required?: string[];
					properties?: {
						label?: { minLength?: number; pattern?: string };
						description?: {
							anyOf?: Array<{ type?: string }>;
						};
					};
				};
			};
		};
	};
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.required, ["question", "options"]);
	assert.equal(schema.properties?.question?.minLength, 1);
	assert.equal(schema.properties?.question?.pattern, "\\S");
	assert.equal(schema.properties?.options?.minItems, 2);
	assert.equal(schema.properties?.options?.maxItems, 5);
	assert.equal(schema.properties?.options?.items?.additionalProperties, false);
	assert.deepEqual(schema.properties?.options?.items?.required, [
		"label",
		"description",
	]);
	assert.deepEqual(
		schema.properties?.options?.items?.properties?.description?.anyOf?.map(
			(branch) => branch.type,
		),
		["string", "null"],
	);
	assert.equal(
		schema.properties?.options?.items?.properties?.label?.minLength,
		1,
	);
	assert.equal(
		schema.properties?.options?.items?.properties?.label?.pattern,
		"\\S",
	);
});

test("tool handles unavailable or already-aborted UI", async () => {
	const tool = registeredTool();
	const input: AskUserInvocation = {
		question: "Choose one",
		options: [{ label: "First" }, { label: "Second" }],
	};
	const noUi = await tool.execute("call-1", input, undefined, undefined, {
		mode: "print",
	} as ExtensionContext);
	assert.match(textOf(noUi), /No interactive UI/);
	assert.equal(detailsOf(noUi).cancelled, true);

	const controller = new AbortController();
	controller.abort();
	const aborted = await tool.execute(
		"call-2",
		input,
		controller.signal,
		undefined,
		{ mode: "tui" } as ExtensionContext,
	);
	assert.equal(textOf(aborted), "Cancelled");
	assert.equal(detailsOf(aborted).answer, null);
});

test("runtime validation rejects invalid bounds and sanitized blank text", async () => {
	const tool = registeredTool();
	const execute = (input: AskUserInvocation) =>
		tool.execute("call-1", input, undefined, undefined, {
			mode: "print",
		} as ExtensionContext);

	await assert.rejects(
		execute({ question: "Too few", options: [{ label: "Only" }] }),
		/requires between 2 and 5 options \(got 1\)/,
	);
	for (const question of [" \t\n ", "\u0007\u001b[2J\u202e"]) {
		await assert.rejects(
			execute({
				question,
				options: [{ label: "First" }, { label: "Second" }],
			}),
			/question must be nonblank after sanitization/,
		);
	}
	for (const label of [" \t\n ", "\u0007\u001b[2J\u202e"]) {
		await assert.rejects(
			execute({
				question: "Choose one",
				options: [{ label }, { label: "Second" }],
			}),
			/option 1 label must be nonblank after sanitization/,
		);
	}
});

test("runtime validation rejects duplicate effective labels", async () => {
	const tool = registeredTool();
	const execute = (options: AskUserInvocation["options"]) =>
		tool.execute(
			"call-1",
			{ question: "Choose one", options },
			undefined,
			undefined,
			{ mode: "print" } as ExtensionContext,
		);

	await assert.rejects(
		execute([{ label: "Same" }, { label: " Same " }]),
		/labels must be unique after sanitization.*Same/,
	);
	await assert.rejects(
		execute([{ label: "Same" }, { label: "\u001b[31mSame\u001b[0m" }]),
		/labels must be unique after sanitization.*Same/,
	);
});

test("numeric shortcuts return the chosen label and index", async () => {
	const tool = registeredTool();
	const { component, execution } = startInteractive(tool, {
		question: "Choose one",
		options: [{ label: "First" }, { label: "Second" }],
	});
	component.handleInput?.("2");

	const result = await execution;
	assert.equal(textOf(result), "User selected option 2: Second");
	assert.deepEqual(detailsOf(result), {
		question: "Choose one",
		options: ["First", "Second"],
		answer: "Second",
		selectedIndex: 2,
		wasCustom: false,
		cancelled: false,
	});
});

test("custom and blank custom answers preserve free-form behavior", async () => {
	const tool = registeredTool();
	const custom = startInteractive(tool, {
		question: "Choose one",
		options: [{ label: "First" }, { label: "Second" }],
	});
	custom.component.handleInput?.("3");
	custom.component.handleInput?.("Something else");
	custom.component.handleInput?.("\r");
	const customResult = await custom.execution;
	assert.equal(
		textOf(customResult),
		"User wrote their own answer: Something else",
	);
	assert.deepEqual(detailsOf(customResult), {
		question: "Choose one",
		options: ["First", "Second"],
		answer: "Something else",
		selectedIndex: null,
		wasCustom: true,
		cancelled: false,
	});

	const blank = startInteractive(tool, {
		question: "Choose one",
		options: [{ label: "First" }, { label: "Second" }],
	});
	blank.component.handleInput?.("3");
	blank.component.handleInput?.("   ");
	blank.component.handleInput?.("\r");
	blank.component.handleInput?.("2");
	const blankResult = await blank.execution;
	assert.equal(textOf(blankResult), "User selected option 2: Second");
	assert.equal(detailsOf(blankResult).selectedIndex, 2);
});

test("selection actions honor injected remapped keybindings", async () => {
	const tool = registeredTool();
	const remapped = keybindings({
		"tui.select.up": "k",
		"tui.select.down": "j",
		"tui.select.confirm": "l",
		"tui.select.cancel": "h",
	});
	const selected = startInteractive(
		tool,
		{
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second" }],
		},
		{ keybindings: remapped },
	);
	selected.component.handleInput?.("k");
	selected.component.handleInput?.("j");
	selected.component.handleInput?.("j");
	selected.component.handleInput?.("l");
	assert.equal(
		textOf(await selected.execution),
		"User selected option 2: Second",
	);

	const dismissed = startInteractive(
		tool,
		{
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second" }],
		},
		{ keybindings: remapped },
	);
	dismissed.component.handleInput?.("h");
	assert.match(textOf(await dismissed.execution), /dismissed/);
});

test("Unicode, CJK, ANSI styling, and width changes render safely", () => {
	const tool = registeredTool();
	const ansiTheme = {
		fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
		bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
	};
	const { component } = startInteractive(
		tool,
		{
			question: "请选择一个方案 👩🏽‍💻 with a long suffix",
			options: [
				{ label: "第一项界面", description: "包含中文描述和 emoji 🚀" },
				{ label: "Second option with a long label" },
			],
		},
		{ theme: ansiTheme },
	);

	const wide = component.render(40);
	const narrow = component.render(7);
	assert.notStrictEqual(wide, narrow);
	assert.ok(narrow.some((line) => stripTerminalSequences(line).includes("选")));
	for (const width of [1, 2, 7, 20]) {
		for (const line of component.render(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`${JSON.stringify(line)} exceeds ${width} columns`,
			);
		}
	}
	component.dispose?.();
});

test("unsafe model-provided terminal and direction controls are sanitized", async () => {
	const tool = registeredTool();
	const { component, execution } = startInteractive(tool, {
		question: "Safe\u001b[2J\u0007\u202e question",
		options: [
			{ label: "Fir\u001b]8;;https://evil.invalid\u0007st\u001b]8;;\u0007" },
			{ label: "Sec\nond", description: "De\u0007scription" },
		],
	});
	const rendered = component.render(30).join("\n");
	for (const control of ["\u001b", "\u0007", "\u202e"]) {
		assert.equal(rendered.includes(control), false);
	}
	assert.match(rendered, /Safe question/);
	assert.match(rendered, /First/);
	assert.match(rendered, /Sec ond/);
	component.handleInput?.("2");
	const result = await execution;
	assert.equal(detailsOf(result).answer, "Sec ond");
	const detailsText = [
		detailsOf(result).question,
		...detailsOf(result).options,
		detailsOf(result).answer ?? "",
	].join("\n");
	for (const control of ["\u001b", "\u0007", "\u202e"]) {
		assert.equal(detailsText.includes(control), false);
	}
});

test("active cancellation settles once and removes its listener", async () => {
	const tool = registeredTool();
	const controller = new AbortController();
	let doneCalls = 0;
	const started = startInteractive(
		tool,
		{
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second" }],
		},
		{
			signal: controller.signal,
			onDone: () => {
				doneCalls++;
			},
		},
	);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	controller.abort();

	const result = await started.execution;
	assert.equal(textOf(result), "Cancelled");
	assert.equal(detailsOf(result).cancelled, true);
	assert.equal(doneCalls, 1);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	started.component.handleInput?.("1");
	assert.equal(doneCalls, 1);
});

test("successful selection removes the cancellation listener", async () => {
	const tool = registeredTool();
	const controller = new AbortController();
	const started = startInteractive(
		tool,
		{
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second" }],
		},
		{ signal: controller.signal },
	);
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	started.component.handleInput?.("1");
	await started.execution;
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
