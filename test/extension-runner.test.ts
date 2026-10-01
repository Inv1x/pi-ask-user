import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createEventBus,
	discoverAndLoadExtensions,
	ExtensionRunner,
	type ExtensionUIContext,
	type ModelRegistry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionPath = path.join(packageRoot, "src/index.ts");
const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

type PromptEvent = {
	type: "ui_prompt_start" | "ui_prompt_end";
	kind: string;
	reason: string;
};

type TestComponent = Component & { dispose?: () => void };

async function settleEvents(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createHarness(
	options: { overlayOpen?: boolean; uiError?: Error } = {},
) {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-ask-user-runner-"),
	);
	const loaded = await discoverAndLoadExtensions(
		[extensionPath],
		packageRoot,
		agentDir,
		createEventBus(),
	);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.ok(extension);

	const events: PromptEvent[] = [];
	for (const type of ["ui_prompt_start", "ui_prompt_end"] as const) {
		extension.handlers.set(type, [
			async (event: unknown) => {
				events.push(event as PromptEvent);
			},
		]);
	}

	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		packageRoot,
		SessionManager.inMemory(),
		{} as ModelRegistry,
	);
	let overlayOpen = options.overlayOpen ?? false;
	let component: TestComponent | undefined;
	const tui = {
		hasOverlay: () => overlayOpen,
		requestRender() {},
	};
	const ui = {
		custom: options.uiError
			? async () => {
					throw options.uiError;
				}
			: (
					factory: (
						renderer: typeof tui,
						theme: typeof identityTheme,
						keybindings: KeybindingsManager,
						done: (result: unknown) => void,
					) => TestComponent | Promise<TestComponent>,
				) =>
					new Promise<unknown>((resolve, reject) => {
						void Promise.resolve(
							factory(
								tui,
								identityTheme,
								new KeybindingsManager(TUI_KEYBINDINGS, {}),
								(result) => {
									component?.dispose?.();
									resolve(result);
								},
							),
						).then((created) => {
							component = created;
						}, reject);
					}),
	} as unknown as ExtensionUIContext;
	runner.setUIContext(ui, "tui");

	const registered = runner.getAllRegisteredTools();
	assert.equal(registered.length, 1);
	const tool = registered[0]?.definition;
	assert.ok(tool);

	return {
		agentDir,
		events,
		get component() {
			return component;
		},
		closeOverlay() {
			overlayOpen = false;
		},
		execute(signal?: AbortSignal) {
			return tool.execute(
				"call-runner",
				{
					question: "Choose one",
					options: [
						{ label: "First", description: null },
						{ label: "Second", description: "Alternative" },
					],
				},
				signal,
				undefined,
				runner.createContext(),
			);
		},
	};
}

function assertSinglePromptPair(events: PromptEvent[]): void {
	assert.deepEqual(
		events.map(({ type, kind, reason }) => ({ type, kind, reason })),
		[
			{ type: "ui_prompt_start", kind: "custom", reason: "ui_prompt" },
			{ type: "ui_prompt_end", kind: "custom", reason: "ui_prompt" },
		],
	);
}

test("ExtensionRunner emits one prompt pair around the complete overlay wait and answer", async () => {
	const harness = await createHarness({ overlayOpen: true });
	try {
		const execution = harness.execute();
		await settleEvents();
		assert.deepEqual(
			harness.events.map((event) => event.type),
			["ui_prompt_start"],
		);
		assert.equal(Boolean(harness.component), false);

		harness.closeOverlay();
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(harness.component);
		harness.component.handleInput?.("2");
		const result = await execution;
		assert.equal((result.details as { answer: string }).answer, "Second");
		await settleEvents();
		assertSinglePromptPair(harness.events);
	} finally {
		fs.rmSync(harness.agentDir, { recursive: true, force: true });
	}
});

test("ExtensionRunner emits one prompt pair for dismiss and abort outcomes", async () => {
	for (const outcome of ["dismiss", "abort"] as const) {
		const harness = await createHarness();
		try {
			const controller = new AbortController();
			const execution = harness.execute(controller.signal);
			await settleEvents();
			assert.ok(harness.component);
			if (outcome === "dismiss") harness.component.handleInput?.("\u001b");
			else controller.abort();
			const result = await execution;
			assert.equal(
				(result.details as { dismissal: string }).dismissal,
				outcome === "dismiss" ? "user" : "aborted",
			);
			await settleEvents();
			assertSinglePromptPair(harness.events);
		} finally {
			fs.rmSync(harness.agentDir, { recursive: true, force: true });
		}
	}
});

test("ExtensionRunner ends the prompt once when custom UI rejects", async () => {
	const harness = await createHarness({ uiError: new Error("UI failed") });
	try {
		await assert.rejects(harness.execute(), /UI failed/);
		await settleEvents();
		assertSinglePromptPair(harness.events);
	} finally {
		fs.rmSync(harness.agentDir, { recursive: true, force: true });
	}
});
