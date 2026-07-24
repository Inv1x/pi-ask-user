import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
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

type RegisteredTool = {
	name: string;
	executionMode?: string;
	execute(
		toolCallId: string,
		params: AskUserInput,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
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

test("tool is sequential and handles unavailable or already-aborted UI", async () => {
	const tool = registeredTool();
	assert.equal(tool.name, "ask_user");
	assert.equal(tool.executionMode, "sequential");

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

test("number selection returns the chosen label and index", async () => {
	const tool = registeredTool();
	let component: Component | undefined;
	const custom = (
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: unknown) => void,
		) => Component,
	): Promise<unknown> =>
		new Promise((resolve) => {
			component = factory(
				{ requestRender() {} },
				{
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				{},
				resolve,
			);
		});
	const execution = tool.execute(
		"call-1",
		{
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second" }],
		},
		undefined,
		undefined,
		{
			mode: "tui",
			ui: { custom },
		} as unknown as ExtensionContext,
	);
	assert.ok(component?.handleInput);
	component.handleInput("2");

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

test("an active dialog settles once when its signal is aborted", async () => {
	const tool = registeredTool();
	const controller = new AbortController();
	let component: (Component & { dispose?: () => void }) | undefined;
	let doneCalls = 0;
	const custom = (
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: unknown) => void,
		) => Component & { dispose?: () => void },
	): Promise<unknown> =>
		new Promise((resolve) => {
			component = factory(
				{ requestRender() {} },
				{
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
				{},
				(result) => {
					doneCalls++;
					component?.dispose?.();
					resolve(result);
				},
			);
		});
	const execution = tool.execute(
		"call-1",
		{
			question: "Choose one",
			options: [{ label: "First" }, { label: "Second" }],
		},
		controller.signal,
		undefined,
		{
			mode: "tui",
			ui: { custom },
		} as unknown as ExtensionContext,
	);
	assert.ok(component);
	controller.abort();

	const result = await execution;
	assert.equal(textOf(result), "Cancelled");
	assert.equal(detailsOf(result).cancelled, true);
	assert.equal(doneCalls, 1);
});
