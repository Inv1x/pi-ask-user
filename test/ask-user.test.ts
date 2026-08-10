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
	wasCustom: boolean;
	cancelled: boolean;
}

type ToolResult = AgentToolResult<unknown>;

type TestComponent = Component & { dispose?: () => void };

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	constrainedSampling?: unknown;
	executionMode?: string;
	execute(
		toolCallId: string,
		params: AskUserInput,
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
	input: AskUserInput,
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

	const schema = tool.parameters as {
		additionalProperties?: boolean;
		properties?: {
			options?: {
				minItems?: number;
				maxItems?: number;
				items?: { additionalProperties?: boolean };
			};
		};
	};
	assert.equal(schema.additionalProperties, false);
	assert.equal(schema.properties?.options?.minItems, 2);
	assert.equal(schema.properties?.options?.maxItems, 5);
	assert.equal(schema.properties?.options?.items?.additionalProperties, false);
});

test("tool handles unavailable or already-aborted UI", async () => {
	const tool = registeredTool();
	const input: AskUserInput = {
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

test("runtime option bounds reject malformed calls", async () => {
	const tool = registeredTool();
	await assert.rejects(
		tool.execute(
			"call-1",
			{ question: "Too few", options: [{ label: "Only" }] },
			undefined,
			undefined,
			{ mode: "print" } as ExtensionContext,
		),
		/requires between 2 and 5 options \(got 1\)/,
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
		wasCustom: false,
		cancelled: false,
	});
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
